import { serve } from "bun";
import { Hono } from "hono";
import { authorised } from "./authorisation";
import { environmentFor } from "./environment";
import {
  ComputerNotAnsweringError,
  DockerUnavailableError,
  ensure,
  listOwned,
  NameHeldError,
  reachable,
  reset,
  stop,
  WorkspaceMountError,
} from "./docker";
import { registerEntry } from "./identity";
import { namesFor } from "./names";
import { computerMemoryBytes } from "./computer-memory-bytes";
import { listenPort } from "./listen-port";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in Bots rather than in Docker: ensure a computer
 * for this Bot, stop it, reset it, list them. There is no passthrough and no way to name a container
 * directly, names are derived from the Bot id, which is validated first. A compromised API server
 * can ask for a Bot's computer to be restarted. It cannot ask for anything else, because nothing
 * else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Neither is the network the boundary, but it is the layer in front of both. Compose publishes this
 * port on `127.0.0.1` rather than on every address the host has, for the same reason the computer's
 * own port is bound there: a secret in an environment variable is one leak away from being known,
 * and this process holds the Docker socket. This listener stays on every interface inside its own
 * container, which is what the published mapping forwards to and what a server running inside the
 * compose network connects to as `supervisor:4300`.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const resolvedPort = listenPort(process.env.PORT, 4300);
if (!resolvedPort.ok) {
  console.error(resolvedPort.reason);
  process.exit(1);
}
const port = resolvedPort.port;
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
const image =
  process.env.COMPUTER_IMAGE?.trim() || "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK?.trim() || undefined;
const runtime = process.env.COMPUTER_RUNTIME?.trim() || undefined;
const resolvedMemory = computerMemoryBytes(process.env.COMPUTER_MEMORY_BYTES);
if (!resolvedMemory.ok) {
  console.error(resolvedMemory.reason);
  process.exit(1);
}
const memoryBytes = resolvedMemory.bytes;
const spireSocketVolume =
  process.env.SPIRE_AGENT_SOCKET_VOLUME?.trim() || undefined;
const tenantWorkspaceRoot =
  process.env.TENANT_WORKSPACE_ROOT?.trim() || undefined;

const app = new Hono();

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health") return next();
  if (!authorised(context.req.header("authorization"), token)) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

/** The Bot id in the path, validated before it becomes any kind of name. */
function resolve(raw: string) {
  return namesFor(raw);
}

type EnsureBody = {
  tenantId?: string;
  workspaceVolume?: string;
  workspacePath?: string;
};

type EnsureBodyResult =
  | { ok: true; body: EnsureBody }
  | { ok: false; reason: string };

function optionalString(
  body: Record<string, unknown>,
  key: string,
): { ok: true; value?: string } | { ok: false; reason: string } {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, reason: `${key} must be a string.` };
  }
  return { ok: true, value };
}

async function ensureBody(request: Request): Promise<EnsureBodyResult> {
  const text = await request.text();
  if (!text.trim()) return { ok: true, body: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The request body must be valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "The request body must be a JSON object." };
  }

  const record = parsed as Record<string, unknown>;
  const tenantId = optionalString(record, "tenantId");
  if (!tenantId.ok) return tenantId;
  const workspaceVolume = optionalString(record, "workspaceVolume");
  if (!workspaceVolume.ok) return workspaceVolume;
  const workspacePath = optionalString(record, "workspacePath");
  if (!workspacePath.ok) return workspacePath;

  if (
    tenantId.value !== undefined &&
    (tenantId.value.trim().length === 0 ||
      tenantId.value.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(tenantId.value))
  ) {
    return {
      ok: false,
      reason:
        "tenantId must be a non-empty label of at most 128 characters without control characters.",
    };
  }

  return {
    ok: true,
    body: {
      ...(tenantId.value !== undefined ? { tenantId: tenantId.value } : {}),
      ...(workspaceVolume.value !== undefined
        ? { workspaceVolume: workspaceVolume.value }
        : {}),
      ...(workspacePath.value !== undefined
        ? { workspacePath: workspacePath.value }
        : {}),
    },
  };
}

app.post("/computers/:botId/ensure", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  const supplied = await ensureBody(context.req.raw);
  if (!supplied.ok) return context.json({ error: supplied.reason }, 400);

  try {
    // Registered before the computer is handed out, so it can prove which Bot it is from its first
    // request.
    const identity = await registerEntry(parsed.names);

    const state = await ensure(parsed.names, {
      image,
      environment: environmentFor(parsed.names.botId),
      ...(network ? { network } : {}),
      ...(runtime ? { runtime } : {}),
      ...(memoryBytes ? { memoryBytes } : {}),
      ...(spireSocketVolume ? { spireSocketVolume } : {}),
      ...(tenantWorkspaceRoot ? { tenantWorkspaceRoot } : {}),
      ...(supplied.body.tenantId !== undefined
        ? { tenantId: supplied.body.tenantId }
        : {}),
      ...(supplied.body.workspaceVolume !== undefined
        ? { tenantWorkspaceVolume: supplied.body.workspaceVolume }
        : {}),
      ...(supplied.body.workspacePath !== undefined
        ? { tenantWorkspacePath: supplied.body.workspacePath }
        : {}),
    });
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    // A held name is not an outage. 409 says the conflict is with something already there, so an
    // operator reads the message rather than going to look at a daemon that is working.
    if (error instanceof NameHeldError) {
      return context.json({ error: error.message }, 409);
    }
    if (error instanceof WorkspaceMountError) {
      return context.json({ error: error.message }, 400);
    }
    // Not ready is a 503 like an outage is, because the caller's next move is the same: wait and
    // ask again. The message is what differs, and it is the part an operator acts on.
    if (
      error instanceof DockerUnavailableError ||
      error instanceof ComputerNotAnsweringError
    ) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/stop", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await stop(parsed.names);
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/reset", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await reset(parsed.names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);
