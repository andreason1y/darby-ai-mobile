import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { setDefaultAutoSelectFamily } from "node:net";
import { join } from "node:path";
import { serve } from "bun";
import type { Page } from "playwright";
import { downloadHeaders } from "../../shared/file-download";
import {
  cutAtCodeUnits,
  parseAriaSnapshot,
  type SnapshotElement,
} from "./aria-snapshot";
import {
  actsOnTheComputer,
  isOpenPath,
  matchesToken,
  mutatesBrowser,
  offeredToken,
} from "./authorisation";
import { isPlainBotId } from "./bot-id";
import { browserRuntimeFromEnv } from "./browser-runtime";
import { detectChallenge } from "./challenge";
import {
  ControlError,
  ControlRequestError,
  NO_SECRET_PENDING,
  SnapshotRequiredError,
  TAKE_CONTROL_FIRST,
} from "./control";
import { describeHumanGesture } from "./demonstration";
import { handleEgressPolicyRequest, startEgressFilter } from "./egress";
import { identity } from "./identity";
import {
  assertPageAccess,
  navigateWebPage,
  type PagePurpose,
} from "./navigation";
import { createProfiles, numberFromEnv, VIEWPORT } from "./profiles";
import {
  parseExecTimeout,
  parseInputMessage,
  parseNavigateUrl,
  parseScrollDelta,
} from "./request-validation";
import { type InputMessage, startScreencast } from "./screencast";
import {
  markElementSecret,
  maskSensitiveValues,
  SECRET_ATTRIBUTE,
  SENSITIVE_FIELD_SELECTOR,
  sensitiveRefs,
} from "./secret-masking";
import { type BotSession, createSessions } from "./sessions";
import { createShell } from "./shell";
import {
  fillSignIn,
  fillSignInCode,
  parseSignInCode,
  parseSignInFill,
} from "./sign-in";
import { startVirtualDisplay } from "./virtual-display";
import { applyWebBotAuthPush } from "./web-bot-auth";
import {
  createWorkspace,
  WorkspaceFileError,
  WorkspaceFileNotFoundError,
  WorkspaceFileTooLargeError,
  WorkspacePathError,
} from "./workspace";

/**
 * The Bot's computer: one long-lived browser, reachable over HTTP.
 *
 * Acting on a page lives in this process because only this process holds the browser. In the
 * intended deployment path, the server gateway decides whether an action may run and records the
 * audit row before calling this process. This process has no policy engine and no audit trail of its
 * own; its direct-port boundary is the computer token.
 *
 * `/files/read`, `/files/download` and `/files/write` reach the durable workspace volume, confined
 * to it by workspace.ts. Reading and writing are the two operations a Bot needs to keep notes between
 * turns; download returns the exact bytes so a PDF, image or archive is not damaged by text decoding.
 *
 * Elements are addressed by reference, not by pixel. `/snapshot` stamps every interactive element
 * with a ref and hands back a compact list; `/click` and `/type` take one of those refs. That is the
 * accessibility-tree-first driver this is built on, and it is why filling in a form needs no
 * vision model at all: the Bot reads a list of fields rather than squinting at a picture and guessing
 * coordinates. Pixels remain the eventual fallback for canvas-style pages that expose no elements.
 *
 * One browser stays open so state survives between
 * turns: a session it signed into an hour ago is still signed in now. Launching per request would
 * make every task start from a cold, logged-out browser, which is the behaviour we are specifically
 * trying not to have.
 *
 * It authenticates its caller: every request must present the secret below, and the process refuses
 * to start without one. That is a lock on the door rather than a reason to put the door somewhere
 * public. It still belongs on the deployment network, behind the server that decides who is asking.
 */

/**
 * The secret every caller must present.
 *
 * This process drives a browser that holds real logins. Policy, audit, actor identity and SPIFFE
 * identity live in the server and are not on the direct computer port.
 *
 * Refusing to start without a token makes missing authentication a deployment failure, never an open
 * computer.
 */
const COMPUTER_TOKEN = process.env.COMPUTER_TOKEN?.trim();
if (!COMPUTER_TOKEN) {
  console.error(
    "COMPUTER_TOKEN is not set. This process drives a browser holding real logins and will not start without the secret its caller must present.",
  );
  process.exit(1);
}

/*
 * No multi-address connect anywhere in this process. Bun turns it on by default, and its timer can
 * throw from `internalConnectMultipleTimeout` after the connection is gone, which exits the process
 * (oven-sh/bun#25633, fixed in Bun 1.4.0, kept as defence in depth). The egress filter already
 * connects one checked address at a time (see `connectInTurn`); this covers every other connect here,
 * such as reaching an upstream proxy by name.
 */
setDefaultAutoSelectFamily(false);

const RUNTIME = browserRuntimeFromEnv(process.env);
const BROWSER_MODE = RUNTIME.mode;
const VIRTUAL_DISPLAY = await startVirtualDisplay(
  RUNTIME.useVirtualDisplay ? "headed" : "headless",
);
if (VIRTUAL_DISPLAY) process.env.DISPLAY = VIRTUAL_DISPLAY.name;
console.info(
  JSON.stringify({
    type: "computer-browser-mode",
    mode: BROWSER_MODE,
    display: VIRTUAL_DISPLAY?.name ?? null,
  }),
);

/*
 * A whole port in range, or the default: a fraction never binds and an out-of-range one
 * misbinds at boot, which is a deployment failure instead of the documented fallback.
 */
const PORT = numberFromEnv("PORT", 4100, { min: 1, max: 65535 });
const NAVIGATION_TIMEOUT_MS = numberFromEnv("NAVIGATION_TIMEOUT_MS", 30000);

/**
 * How long one action waits for its element.
 *
 * Much shorter than a navigation. Playwright waits for a control to become clickable, which is the
 * behaviour we want, but a ref that no longer resolves would otherwise hang for the full navigation
 * timeout before saying so, and the person is sitting watching a screen that is not changing.
 */
const ACTION_TIMEOUT_MS = numberFromEnv("ACTION_TIMEOUT_MS", 10000);

/**
 * How much page text a navigation hands back.
 *
 * Bounded because a page can be megabytes and the text goes into a model's context, where a single
 * unbounded page can push the rest of the conversation out. Generous enough that the visible part of
 * an ordinary page arrives whole, which is what the answer is usually made of.
 */
const TEXT_EXTRACT_LIMIT = 6000;

/**
 * Which snapshot the caller's refs came from.
 *
 * Kept as a caller-facing guard even though Playwright enforces the real thing underneath. The
 * published tool contract says an action carries the `snapshotId` it got, and a mismatch is answered
 * with "take a new snapshot", which is a clearer message for a model than an element that merely fails
 * to resolve. Playwright's `aria-ref` engine is the runtime enforcement: it resolves a ref only against
 * the most recent snapshot, only while the element is still connected to the document, and it mints a
 * new ref if an element's role or accessible name changed, so a recycled node cannot inherit an old one.
 *
 * The counter, the run it belongs to, and the sessions holding both live in their own module: the
 * rules about when a run changes are testable there, and not here, because this file launches a
 * browser the moment it is imported.
 */
const sessions = createSessions({
  isLive: (botId) => profiles.isLive(botId),
  profilesDirectory: process.env.PROFILES_DIR?.trim() || "/profiles",
});

/**
 * Sent by the server as a header on every call. Absent means the caller does not know or does not
 * care, such as a health check, and that gets the default computer rather than an error, because
 * refusing it would make the container undemonstrable on its own.
 */
function botIdOf(request: Request, fallback?: string | null): string {
  return (
    request.headers.get("x-openbot-bot-id")?.trim() ||
    fallback?.trim() ||
    DEFAULT_BOT_ID
  );
}

/**
 * The Bot's durable files.
 *
 * Rooted at WORKSPACE_DIR, which the image creates and docker-compose mounts as a volume, so what a
 * Bot saves outlives the container. Built once at boot: the root is fixed, and resolving it per request
 * would only add a syscall to every call. Everything about why confinement is harder than it looks
 * lives in workspace.ts.
 */
/**
 * The two directories this process cannot do its job without, checked before it says it is ready.
 *
 * WHY A CHECK AND NOT A CRASH LATER. Neither of these fails loudly on its own. A persistent
 * Chromium profile it cannot write is not an error to Chromium: `launchPersistentContext` falls
 * back to a throwaway profile, so the Bot is signed out of everything and the container is healthy.
 * `profiles.ts` swallows the EACCES on cleanup for its own good reasons. So the failure that
 * actually happens in the field is a green pod and an empty profile, which is the worst shape a
 * failure can take: nothing to read, and a week of logins gone.
 *
 * WHEN IT HAPPENS. The volume is created root-owned and something has to hand it over. In Docker
 * the image does it at build time; on Kubernetes the kubelet does it from `fsGroup`, which it
 * applies only where the volume plugin reports it can. `hostPath` reports it cannot, and that is
 * what rancher/local-path-provisioner hands out by default, which is the default StorageClass on
 * k3s. There, uid 1001 gets a directory it cannot even list.
 *
 * Exiting non-zero turns that into a CrashLoopBackOff with a readable reason, which an operator can
 * act on: chown the directory, or set `computers.podSecurityContext: null`.
 */
async function assertWritable(label: string, directory: string) {
  const probe = join(directory, `.openbot-write-probe-${process.pid}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, "");
    await rm(probe, { force: true });
  } catch (error) {
    console.error(
      `${label} at ${directory} is not writable by uid ${process.getuid?.() ?? "unknown"}: ${String(error)}. ` +
        "A Bot's files and browser profile live here, and a profile this process cannot write is one Chromium silently replaces with a throwaway, so this refuses to start instead. " +
        "On Kubernetes this usually means the volume's storage class does not apply fsGroup, which hostPath-backed provisioners such as local-path do not: chown it to the pod's uid, or set computers.podSecurityContext to null.",
    );
    process.exit(1);
  }
}

await assertWritable(
  "The workspace",
  process.env.WORKSPACE_DIR?.trim() || "/workspace",
);
await assertWritable(
  "The browser profiles directory",
  process.env.PROFILES_DIR?.trim() || "/profiles",
);

const workspace = createWorkspace(
  process.env.WORKSPACE_DIR?.trim() || "/workspace",
);

/*
 * The legal document tools. They run out of the image's venv because the system Python has no
 * document libraries, and each is launched as its own argv rather than through a shell so a
 * workspace file name can never become a command.
 */
const LEGAL_PYTHON =
  process.env.LEGAL_PYTHON?.trim() || "/opt/legal-tools-env/bin/python";
const LEGAL_TOOLS_DIR = join(import.meta.dir, "..", "tools");
const LEGAL_INPUT_BYTES = 100 * 1024 * 1024;
const LEGAL_PLAYBOOK_BYTES = 2 * 1024 * 1024;
const LEGAL_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
const LEGAL_SCOPES = new Set(["all", "putusan", "regulasi"]);
const LEGAL_OCR_LANGUAGES = /^[a-z]{2,16}(\+[a-z]{2,16})*$/i;

/**
 * Who has the wheel, as a state machine in its own module.
 *
 * The state machine lives in `control.ts` so it can be tested without importing Playwright.
 */

/**
 * The Bot's browser and the profile that outlives it. See profiles.ts.
 *
 * `chromium.launch()` gives a fresh anonymous profile every time. Persistent profiles live on a
 * mounted volume so sign-in state survives the container.
 */
/**
 * The browsers, and what a closing one takes with it.
 *
 * Every close announces itself here, whether it came from a request, the cap, or the idle sweep, and
 * the live screen watching that Bot comes down with it. Hanging this off the close rather than
 * calling it from the stop and reset handlers is what covers the two closes no request makes: a
 * viewer that outlived one of those kept a 1Hz loop asking for a page, which starts a browser, so
 * the Bot was immune to the idle timeout and came straight back after a cap eviction.
 *
 * `sessions.get`, never `sessions.for`: a Bot with no session has nobody watching, and inventing one
 * here would put an entry in the map on the path that closes browsers, which is where the map is
 * meant to shrink.
 */
// Every browser and shell launched below goes through the policy filter, which still chains to the
// per-Bot upstream proxy. Started before any browser exists so nothing escapes it.
// Only the running computer points its shell at it: a test that imports this module shares its
// process with every later test.
await startEgressFilter({ forShell: import.meta.main });
const profiles = createProfiles(
  process.env.PROFILES_DIR?.trim() || "/profiles",
  async (botId) => {
    if (sessions.get(botId)) sessions.renewRun(botId);
    await sessions.get(botId)?.viewer.releaseAll(COMPUTER_STOPPED);
  },
);
// Rooted in the same workspace the file tools use, so a command and a written file see one
// directory rather than two.
const shell = createShell(process.env.WORKSPACE_DIR?.trim() || "/workspace");

/**
 * The id normally arrives as a header on every request. This is the fallback for a caller that has no
 * Bot to name, such as a health check, so the container stays demonstrable on its own rather than
 * refusing everything that is not the server.
 */
const DEFAULT_BOT_ID = (() => {
  const configured = process.env.COMPUTER_BOT_ID ?? "shared";
  // At boot rather than per request. This is the id every unheadered call falls back to, so a value
  // the path rules refuse would answer 400 to everything and read as a broken computer.
  if (!isPlainBotId(configured)) {
    throw new Error(
      "COMPUTER_BOT_ID may contain only letters, digits, hyphen and underscore, and must start with a letter or digit.",
    );
  }
  return configured;
})();

async function currentPage(
  botId: string,
  purpose: PagePurpose = "read",
): Promise<Page> {
  const session = sessions.for(botId);
  const page = await profiles.page(botId);
  sessions.observeBrowser(botId, page.context());
  assertPageAccess(RUNTIME.backend, page.url(), purpose);
  // A ref names an element on the page it was taken from, so moving to a window the site opened has
  // to retire the outstanding ones exactly as a navigation does, or a click lands on the wrong document.
  if (session.livePage && session.livePage !== page) session.snapshotId += 1;
  session.livePage = page;
  return page;
}

/** A browser that has not been sent anywhere, which is what a restarted one shows. */
function isBlankPage(url: string): boolean {
  return (
    url === "" ||
    url === "about:blank" ||
    url.startsWith("chrome://newtab") ||
    url.startsWith("chrome://new-tab-page")
  );
}

/**
 * Put the page a handoff is about back in front of the person, when the browser came back blank.
 *
 * A browser restarts underneath a waiting request more often than it should: Chromium crashing, the
 * idle sweep or the cap closing it, the whole computer restarting. Each of those relaunches onto
 * `about:blank`, and before this a person who took control was handed a blank screen with nothing to
 * solve while the Bot waited for them to solve it. The request carries the page it was raised on, so
 * the computer opens it again first. Through the same navigation the Bot uses, so the egress filter
 * and the page-access rule still decide whether it may load.
 *
 * Only a blank browser is touched. A person or a site that moved the page somewhere else meant to.
 * Best effort: a page that will not load is logged and the handoff goes ahead, because a person in
 * front of a blank browser can still type the address, and a refused handoff helps nobody.
 */
const restoringPages = new Set<string>();
async function restoreHandoffPage(botId: string): Promise<void> {
  // One at a time per Bot: the help call and "Take control" both start one, and the second would
  // navigate again over the first while it is still loading.
  if (restoringPages.has(botId)) return;
  const session = sessions.for(botId);
  const want = session.control.pageToRestore();
  if (!want) return;
  // Run in the background, so the help call and "Take control" answer at once. Starting the browser
  // can take a while; by the time it is up the person may already be driving, or the request over.
  const inputsBefore = session.humanInputs;
  restoringPages.add(botId);
  try {
    const target = await currentPage(botId);
    if (!isBlankPage(target.url())) return;
    if (
      session.humanInputs !== inputsBefore ||
      session.control.pageToRestore() !== want
    )
      return;
    await navigateWebPage(target, want, RUNTIME.backend, NAVIGATION_TIMEOUT_MS);
    // A new document, so every ref handed out before it is retired, as after any navigation.
    session.snapshotId += 1;
    console.info(
      JSON.stringify({
        type: "computer-handoff-page-restored",
        botId,
        origin: new URL(want).origin,
      }),
    );
  } catch (error) {
    console.info(
      JSON.stringify({
        type: "computer-handoff-page-not-restored",
        botId,
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
  } finally {
    restoringPages.delete(botId);
  }
}

/**
 * The page as text, the way a reader sees it.
 *
 * Script and style bodies are dropped rather than included: they are the bulk of a modern page and
 * none of it is what anybody asked about, so leaving them in spends the extract on noise and pushes
 * the actual article past the limit.
 */
async function readablePageText(
  target: Page,
): Promise<{ text: string; truncated: boolean }> {
  const raw = await target.evaluate(() => {
    const clone = document.body?.cloneNode(true) as HTMLElement | undefined;
    if (!clone) return "";
    for (const node of clone.querySelectorAll("script, style, noscript, svg")) {
      node.remove();
    }
    return clone.innerText ?? "";
  });

  const collapsed = raw.replace(/\n{3,}/g, "\n\n").trim();
  return {
    /*
     * Cut between characters, not through one. #539 fixed this for a control's name and value in the
     * snapshot and left the page text, which is the same bug at thirty times the length: `slice`
     * counts UTF-16 code units, an emoji is two, and a limit landing between the halves hands the Bot
     * a lone high surrogate that reads as U+FFFD — a character that is not on the page.
     *
     * More likely to bite here than there, for the reason the limit is bigger. A 200-unit control
     * name rarely reaches an emoji; 6000 units of somebody's page usually passes through several, and
     * whether the cut lands mid-character is decided by whatever was above it.
     */
    text: cutAtCodeUnits(collapsed, TEXT_EXTRACT_LIMIT),
    // Unaffected by the line above: dropping one more unit cannot make an over-limit string fit.
    truncated: collapsed.length > TEXT_EXTRACT_LIMIT,
  };
}

/**
 * Describe everything on the page a Bot can act on.
 *
 * Uses Playwright's AI snapshot rather than stamping attributes into the DOM. `ariaSnapshot` keeps
 * refs outside the page, survives framework re-renders, resolves accessible names, reports current
 * values and checked state, filters to actionable elements and descends into iframes.
 */
async function snapshotPage(
  session: BotSession,
  target: Page,
): Promise<{
  snapshotId: number;
  url: string;
  title: string;
  elements: SnapshotElement[];
  truncated: boolean;
}> {
  const snapshotId = ++session.snapshotId;
  const before = session.control.get();
  const yaml = await target.ariaSnapshot({ mode: "ai" });
  const title = await target.title();
  if (
    session.snapshotId === snapshotId &&
    before.holder === "bot" &&
    !before.requested
  )
    session.control.snapshotTaken();
  const parsed = parseAriaSnapshot(yaml);
  return {
    snapshotId,
    url: target.url(),
    title,
    truncated: parsed.truncated,
    // A password field's value is in the aria snapshot in plain text. See secret-masking.ts.
    elements: maskSensitiveValues(
      parsed.elements,
      await sensitiveRefs(target, parsed.elements),
    ),
  };
}

/**
 * Resolve a ref to a locator, refusing anything from a superseded snapshot.
 *
 * `aria-ref=` is a first-party Playwright selector engine, and it is the same one its MCP server uses.
 * The generation check here is the caller-facing half; see the note on `snapshotId` for why both exist.
 */
function locateRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  if (
    expectedSnapshotId !== undefined &&
    expectedSnapshotId !== session.snapshotId
  ) {
    throw new StaleSnapshotError(
      `That list of elements is out of date: it was taken for snapshot ${expectedSnapshotId} and the page is now at ${session.snapshotId}. Take a new snapshot and use the refs from it.`,
    );
  }
  return target.locator(`aria-ref=${ref}`);
}

/**
 * The element, or a refusal that says what to do about it.
 *
 * A generation check is not an existence check. A ref from
 * the current snapshot that names nothing on the page, because a model invented it or because the
 * page moved on without a new snapshot being taken, passes `locateRef` and then simply waits. The
 * action times out, and the caller gets a generic failure carrying Playwright's internal call log
 * instead of the actionable answer: take a fresh snapshot.
 *
 * `count()` resolves immediately rather than waiting, so a ref that names nothing is refused in
 * milliseconds instead of holding the action open for the full timeout.
 */
async function resolveRef(
  session: BotSession,
  target: Page,
  ref: string,
  expectedSnapshotId: number | undefined,
) {
  const locator = locateRef(session, target, ref, expectedSnapshotId);
  if ((await locator.count()) === 0) {
    throw new StaleSnapshotError(
      `Nothing on this page has the ref ${ref}. Take a new snapshot and use the refs it returns.`,
    );
  }
  return locator;
}

class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The environment a legal tool sees.
 *
 * An allow list, for the reason shell.ts keeps one: the computer process holds the deployment's
 * secrets when it runs inside the one-container image, and a Python process is no more entitled to
 * them than a shell command is. Only the variables the legal tools actually read are copied.
 */
const LEGAL_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "LEGAL_DB_API_URL",
  "LEGAL_DB_API_KEY",
  "LEGAL_DB_SEARCH_PATH",
  "LEGAL_DB_DOCUMENT_PATH",
  "LEGAL_DB_TIMEOUT",
  "TESSERACT_BIN",
  "TESSERACT_LANG",
  "TESSDATA_PREFIX",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

function legalToolEnvironment(): Record<string, string> {
  const workspaceDir = process.env.WORKSPACE_DIR?.trim() || "/workspace";
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: workspaceDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? process.env.LANG ?? "C.UTF-8",
    PYTHONUNBUFFERED: "1",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  for (const name of LEGAL_ENV_NAMES) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  return env;
}

type LegalToolRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
};

function appendBounded(current: string, chunk: string): string {
  const next = current + chunk;
  if (Buffer.byteLength(next, "utf8") <= LEGAL_TOOL_OUTPUT_BYTES) return next;
  return Buffer.from(next, "utf8")
    .subarray(-LEGAL_TOOL_OUTPUT_BYTES)
    .toString("utf8");
}

/**
 * Run one legal tool to completion, a timeout, or a start failure.
 *
 * Its own process group, so a Python child that spawned LibreOffice or Tesseract cannot outlive the
 * timeout that killed the parent. This promise always settles; failures arrive as a non-zero exit
 * code rather than a rejection, because every caller has to turn one into an HTTP status anyway.
 */
function runLegalTool(
  script: string,
  args: string[],
  timeoutMs: number,
): Promise<LegalToolRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(LEGAL_PYTHON, [join(LEGAL_TOOLS_DIR, script), ...args], {
      cwd: process.env.WORKSPACE_DIR?.trim() || "/workspace",
      env: legalToolEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
        elapsedMs: Date.now() - started,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The group, so LibreOffice or Tesseract children stop with the tool that started them.
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk));
    });
    child.on("error", (error) => {
      stderr = appendBounded(stderr, `${stderr}${error.message}\n`);
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
  });
}

function legalToolJson(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout.trim());
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not JSON, which the caller reports as a broken tool.
  }
  return null;
}

function legalToolError(result: LegalToolRun, fallback: string): string {
  for (const text of [result.stdout, result.stderr]) {
    const parsed = legalToolJson(text);
    const message = parsed?.error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  const lines = result.stderr
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) return lines[lines.length - 1];
  return `${fallback} (exit code ${result.exitCode}).`;
}

function legalToolResponse(result: LegalToolRun, tool: string): Response {
  if (result.timedOut) {
    return json(
      { error: `${tool} timed out after ${Math.round(result.elapsedMs / 1000)}s.`, tool },
      504,
    );
  }
  if (result.exitCode !== 0) {
    return json(
      {
        error: legalToolError(result, `${tool} failed`),
        tool,
        exitCode: result.exitCode,
        elapsedMs: result.elapsedMs,
      },
      502,
    );
  }
  const parsed = legalToolJson(result.stdout);
  if (!parsed) {
    return json(
      {
        error: `${tool} did not return JSON.`,
        tool,
        stdout: result.stdout.slice(0, 2000),
      },
      502,
    );
  }
  return json({ ...parsed, tool, elapsedMs: result.elapsedMs });
}

/** A successful tool run, with the workspace-relative path it wrote named for the caller. */
function legalToolSuccess(
  result: LegalToolRun,
  tool: string,
  file: string,
): Response {
  const parsed = legalToolJson(result.stdout);
  if (!parsed) return legalToolResponse(result, tool);
  return json({ ...parsed, tool, file, elapsedMs: result.elapsedMs });
}

async function assertWorkspaceFile(
  path: string,
  label: string,
  maxBytes: number,
): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new WorkspaceFileNotFoundError(`There is no file at ${label}.`);
  }
  if (info.size > maxBytes) {
    throw new WorkspaceFileTooLargeError(
      `${label} is ${info.size} bytes and the legal tool limit is ${maxBytes}.`,
    );
  }
}

/** A sibling of a workspace path, so a default output lands next to its input. */
function siblingOutput(
  input: string,
  suffix: string,
  fallbackExtension = "",
  keepExtension = true,
): string {
  const normalised = input.replace(/\\/g, "/");
  const slash = normalised.lastIndexOf("/");
  const directory = slash >= 0 ? normalised.slice(0, slash + 1) : "";
  const name = normalised.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension =
    keepExtension && dot > 0 ? name.slice(dot) : fallbackExtension;
  return `${directory}${stem}${suffix}${extension}`;
}

/** What a person watching is told when the browser they were watching went away. */
const COMPUTER_STOPPED =
  "This computer stopped, so the screen ended. Start it again to carry on watching.";

/** What a person is told when their screen is still opening and they have already started typing. */
const SCREEN_STILL_STARTING =
  "This screen is still starting. Try that again in a moment.";

/** What a person is told when they act on a screen that is no longer theirs, or no longer anything. */
const SCREEN_NO_LONGER_LIVE =
  "This screen is no longer live. Reopen it to carry on watching.";

/** How often the cast checks that it is still showing the page the Bot is on. */
const FOLLOW_INTERVAL_MS = 1_000;

/** What a live-screen socket carries: the Bot whose screen it is showing. */
type StreamData = { botId: string; recordingId?: string };

serve<StreamData>({
  port: PORT,
  ...(RUNTIME.hostname ? { hostname: RUNTIME.hostname } : {}),
  idleTimeout: 120,
  /**
   * The live screen, pushed by Chrome rather than polled.
   *
   * Upgraded here rather than served as HTTP because the whole point is that frames arrive when the
   * page changes and input goes back over the same connection. See screencast.ts for why polling was
   * not good enough once a person had to type into this.
   */
  websocket: {
    async open(ws) {
      const session = sessions.for(ws.data.botId);
      /*
       * Claimed before anything is awaited, and that order is the fix.
       *
       * Below this line the Bot's browser may have to be launched, which takes long enough for a
       * client to connect and go away inside it. A close arriving in that window used to find nothing
       * installed and so did nothing, while this function carried on to install a cast and a 1Hz
       * interval for a socket that had already gone: no second close ever came, and the interval went
       * on relaunching a browser somebody had stopped. With the claim taken first there is always
       * something for that close to release, and everything below goes through the claim and is
       * refused once it is gone.
       */
      const claim = session.viewer.claim(ws, (reason) => {
        try {
          ws.send(JSON.stringify({ type: "error", error: reason }));
        } catch {
          // Best effort. The socket may already be gone, which is not a reason to stop tearing down.
        }
      });
      try {
        const send = (frame: unknown) => {
          // A closed socket starts a fresh cast on the next connection.
          try {
            ws.send(JSON.stringify(frame));
          } catch {
            void session.viewer.release(ws);
          }
        };

        /*
         * The cast follows the Bot's current page. Re-checking also handles a page being closed
         * underneath us without a listener per page.
         */
        let casting: Page | undefined;
        const attach = async () => {
          const target = await currentPage(ws.data.botId);
          if (target === casting) return;
          const cast = await startScreencast(target, send);
          // The claim stops a cast it refuses, so a launch that lost the screen leaks nothing.
          if (!(await claim.install(cast))) return;
          casting = target;
        };

        await attach();
        const follow = setInterval(() => {
          void attach().catch(() => undefined);
        }, FOLLOW_INTERVAL_MS);
        if (!claim.setFollow(() => clearInterval(follow))) return;
      } catch (error) {
        /*
         * Released before the socket is told, because this path is reachable in exactly the timing
         * the claim exists for. A claim left behind here would keep the session occupied for the life
         * of the process, and the sweep in sessions.ts could never take it: the unbounded growth that
         * function was written to stop, reintroduced by the error path of the fix for it.
         */
        await session.viewer.release(ws);
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "The screen could not be started."),
          }),
        );
        ws.close();
      }
    },

    async message(ws, raw) {
      const session = sessions.for(ws.data.botId);
      /*
       * Whose screen this is, asked before anything is done with the input.
       *
       * A superseded socket used to dispatch through whatever the session held, so a replaced
       * window's typing landed in the page the current viewer was watching. It heard nothing about
       * it either, because the old missing-viewer check returned before reaching anything that could
       * report, which is why this answers the sender rather than returning quietly.
       *
       * Starting and gone are told apart deliberately. Both own no cast, and answering them the same
       * way tells somebody whose screen is still opening that their session ended.
       */
      const standing = session.viewer.standingOf(ws);
      if (standing.state !== "casting") {
        ws.send(
          JSON.stringify({
            type: "error",
            error:
              standing.state === "starting"
                ? SCREEN_STILL_STARTING
                : SCREEN_NO_LONGER_LIVE,
          }),
        );
        return;
      }
      let message: InputMessage;
      try {
        const parsed: unknown = JSON.parse(String(raw));
        const validated = parseInputMessage(parsed);
        if (!validated.ok) {
          ws.send(JSON.stringify({ type: "error", error: validated.error }));
          return;
        }
        message = validated.message;
      } catch {
        // The validated-but-wrong branch above sends an error frame; unparseable input used to
        // be dropped silently, so a buggy surface saw input "ignored" with no diagnostic.
        ws.send(JSON.stringify({ type: "error", error: "Input is not JSON." }));
        return;
      }
      // A person's input is accepted only while they hold the wheel. The socket being open is not permission:
      // without this check, anything that could reach this port could drive the browser while a Bot
      // was working, which is the one thing the control state exists to prevent.
      //
      // Owning the screen is not permission either, which is why this stands after the ownership
      // question above and not instead of it: the two refuse different things, and the one asked
      // first only decides whether the input has anywhere to land.
      //
      // Refuse with an error so the surface can explain why input is ignored.
      if (!session.control.humanMayDrive()) {
        ws.send(JSON.stringify({ type: "error", error: TAKE_CONTROL_FIRST }));
        return;
      }
      session.humanInputs += 1;
      try {
        const recorded = ws.data.recordingId
          ? await describeHumanGesture(
              await currentPage(ws.data.botId),
              message,
            )
          : null;
        await standing.cast.send(message);
        if (recorded)
          ws.send(
            JSON.stringify({
              type: "demonstration.action",
              recordingId: ws.data.recordingId,
              action: recorded,
            }),
          );
      } catch (error) {
        // Reported rather than swallowed. A dispatch that fails means the person's input did nothing,
        // and they must not be left believing it landed.
        console.error(
          JSON.stringify({
            type: "screencast-input-error",
            message: message.type,
            error: String(error),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "error",
            error: describe(error, "That input could not be applied."),
          }),
        );
      }
    },

    async close(ws) {
      // Names the socket, so it can only ever give up its own screen. A superseded socket closing
      // after its replacement has started releases nothing; see viewer.ts.
      //
      // `get`, not `for`: a socket closing for a Bot with no session has nothing to release,
      // and creating one here would add a map entry on a teardown path, which is the direction the
      // map is meant to shrink in.
      await sessions.get(ws.data.botId)?.viewer.release(ws);
    },
  },
  async fetch(request, server) {
    const url = new URL(request.url);

    /*
     * Nothing below this line happens for an untrusted caller.
     *
     * `/health` is the single exception: it names no Bot, touches no browser and reports nothing but
     * whether this process is up, and a container orchestrator has to be able to ask that without
     * holding a secret.
     *
     * The websocket upgrade is checked here too. A browser cannot set headers on an upgrade, so the
     * stream carries the token as a query
     * parameter the same way it already carries the Bot.
     */
    if (
      !isOpenPath(url.pathname) &&
      !matchesToken(COMPUTER_TOKEN, offeredToken(request.headers, url))
    ) {
      // Says nothing about what is here. A refusal that describes the endpoint it is protecting is a
      // directory listing for whoever is knocking.
      return json({ error: "Not authorised." }, 401);
    }

    // Resolved once per request. Everything below that touches a browser, a takeover or a snapshot
    // goes through this Bot's session, so there is no path where one Bot's call reaches another's.
    const botId = botIdOf(request);

    // Refused here rather than deeper down, because the id names a directory and the API server
    // forwards whatever URL segment a caller typed. `reset` deletes that directory as root.
    // `/health` is exempt for the same reason it is exempt from the token: it names no Bot, and an
    // orchestrator's probe must not fail on a header it never meant to send.
    if (!isOpenPath(url.pathname) && !isPlainBotId(botId)) {
      return json({ error: "That is not a usable bot id." }, 400);
    }
    // The admin network policy, pushed by the server on every change; applied without a restart.
    // The deployment's Web Bot Auth key rides the same push (see `web-bot-auth.ts`).
    if (url.pathname === "/egress-policy" && request.method === "PUT") {
      const body = (await request
        .clone()
        .json()
        .catch(() => null)) as { webBotAuth?: unknown } | null;
      const applied = await handleEgressPolicyRequest(botId, request);
      if (applied.ok) await applyWebBotAuthPush(body?.webBotAuth);
      return applied;
    }
    const session = sessions.for(botId);

    /*
     * The wheel, asked once for everything that acts.
     *
     * Refused here rather than inside each handler because the handler that forgets is the whole
     * defect: the shell shipped without this check and ran commands underneath a person who had taken
     * the browser at a login wall. `actsOnTheComputer` is the list, and a new acting endpoint is
     * refused by being added to it rather than by remembering to repeat this.
     */
    let releaseAction: (() => void) | undefined;
    try {
      if (actsOnTheComputer(url.pathname)) {
        releaseAction = session.control.admitBotAction(
          mutatesBrowser(url.pathname),
        );
      }

      if (url.pathname === "/stream") {
        /*
         * The socket carries the Bot in the query because it cannot do it in a header. Every other call here names
         * its Bot in `x-openbot-bot-id`, but a websocket client sends no custom headers on the upgrade,
         * so the stream, and only the stream, also accepts the Bot as a query parameter. The header
         * still wins where there is one.
         */
        const streamBotId = botIdOf(request, url.searchParams.get("bot"));
        if (!isPlainBotId(streamBotId)) {
          return json({ error: "That is not a usable bot id." }, 400);
        }
        const recordingId = url.searchParams.get("recording")?.trim();
        if (recordingId && !/^[a-f0-9-]{36}$/.test(recordingId))
          return json({ error: "Invalid recording identity." }, 400);
        if (
          server.upgrade(request, {
            data: {
              botId: streamBotId,
              ...(recordingId ? { recordingId } : {}),
            },
          })
        )
          return undefined as unknown as Response;
        return json({ error: "Expected a WebSocket upgrade." }, 400);
      }

      /*
       * `/live` stays absent. A page served by this process can only be opened by putting the secret in
       * a URL, where it lands in history and logs. The React app is the guarded way to watch a Bot.
       */

      // Who has the wheel. Polled by the surface alongside the screen, so the person sees the Bot ask
      // for help without having to reload anything.
      if (url.pathname === "/control" && request.method === "GET") {
        return json(
          session.control.get(url.searchParams.get("requestId") ?? undefined),
        );
      }

      // The Bot asking for help. It does not take control: it says it is stuck and why, and a person
      // decides. A Bot that could hand itself to a human could also hand a human a page they never
      // asked to see.
      if (url.pathname === "/control/request" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          reason?: unknown;
          toolCallId?: unknown;
        } | null;
        if (
          body?.toolCallId !== undefined &&
          typeof body.toolCallId !== "string"
        )
          return json({ error: "toolCallId must be a string." }, 400);
        // The page the Bot is stuck on, recorded with the request. A browser that will not start is
        // no reason to refuse the request: the person is the one who can see why.
        const stuckOn = await currentPage(botId).catch(() => undefined);
        const state = session.control.requestHelp(
          body?.reason,
          body?.toolCallId,
          "model",
          stuckOn?.url(),
        );
        // Not awaited: reopening the page can take a navigation timeout plus a cold browser start,
        // and the Bot's help call must not wait on it. It catches its own errors.
        void restoreHandoffPage(botId);
        return json(state);
      }

      // The Bot asking for one value it must not be told. It has already focused the field.
      if (url.pathname === "/control/secret" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          label?: unknown;
          ref?: unknown;
          snapshotId?: unknown;
        } | null;
        try {
          return json(session.control.requestSecret(body ?? {}));
        } catch (error) {
          if (error instanceof ControlRequestError) {
            return json({ error: error.message }, 400);
          }
          throw error;
        }
      }

      /**
       * A person supplying that value.
       *
       * Scoped by the pending request rather than by a control handover: it is usable only while the Bot
       * has actually asked for a secret, and the request is cleared the moment it is answered, so this
       * cannot be used as a general back door to type into the page.
       *
       * The value is typed and forgotten. Not stored on `control`, not returned in the response, not
       * logged. The response says how many characters arrived, which is enough for the surface to
       * confirm something was sent and useless to anybody reading it later.
       *
       * It types and does not submit. Committing a form is a separate action through the gateway and
       * audit trail; secret entry only places the value in the named field.
       */
      if (url.pathname === "/human/secret" && request.method === "POST") {
        const pending = session.control.pendingSecret();
        if (!pending) {
          return json({ error: NO_SECRET_PENDING }, 409);
        }
        const body = (await request.json().catch(() => null)) as {
          text?: unknown;
        } | null;
        if (typeof body?.text !== "string" || !body.text) {
          return json({ error: "A value is required." }, 400);
        }
        try {
          const target = await currentPage(botId);
          // Focus the field the Bot named, and let this throw if it cannot be found. A secret must not
          // be reported as delivered unless a field receives it.
          //
          // No generation check here: a Bot may take another snapshot after asking for a secret, while
          // the ref remains protected by Playwright's `aria-ref` rules.
          //
          // `aria-ref` resolves a ref only against the most recent snapshot, only while the element is
          // still connected, and mints a
          // new ref when an element's role or accessible name changes, so a recycled node cannot
          // inherit an old one. If the ref resolves, it is the field the Bot meant. If it does not,
          // nothing is typed, which is the outcome the generation check existed to guarantee.
          const field = locateRef(session, target, pending.ref, undefined);
          await field.click({ timeout: ACTION_TIMEOUT_MS });
          await field.fill(body.text, { timeout: ACTION_TIMEOUT_MS });
          // Marked so the snapshot, screenshots and the live screen never show it back.
          await field
            .evaluate(markElementSecret, SECRET_ATTRIBUTE)
            .catch(() => undefined);
          const characters = body.text.length;
          // Cleared only after it actually landed, so a failure leaves the request open and the person
          // can try again rather than being told to start over.
          session.control.secretSupplied();
          return json({ supplied: true, characters, url: target.url() });
        } catch (error) {
          if (error instanceof StaleSnapshotError) {
            return json({ error: error.message, stale: true }, 409);
          }
          // The field is gone, which is unretryable, so the request is closed rather than left open.
          // Keeping it open is right for a mistyped value and wrong here: the person would retype their
          // password into the same dead ref for ever. Clearing it also unblocks the Bot, which can see
          // on its next turn that nothing is pending and ask again against a fresh snapshot.
          session.control.secretSupplied();
          return json(
            {
              error: describe(
                error,
                "That value could not be entered: the field is no longer on the page. Ask the assistant to request it again.",
              ),
            },
            502,
          );
        }
      }

      /**
       * A person's login, from the private sign-in form, typed by this process.
       *
       * On the acting list, so it is refused while a person holds the wheel. The body is read once,
       * handed to `fillSignIn`, and dropped: not logged, not stored, not returned. The answer says
       * whether a form was submitted and whether a password field is still showing, and every error
       * in it is `fillSignIn`'s own sentence rather than a browser's.
       */
      if (url.pathname === "/sign-in/fill" && request.method === "POST") {
        const input = parseSignInFill(await request.json().catch(() => null));
        if (typeof input === "string") return json({ error: input }, 400);
        const target = await currentPage(botId);
        const result = await fillSignIn(target, input);
        // The page moved on, so every ref handed out before it is retired, as after a navigation.
        if (result.submitted) session.snapshotId += 1;
        return json(result);
      }

      /**
       * The verification code a site asked for after the password, from the same private form.
       *
       * Handled exactly as the login above: read once, typed by `fillSignInCode` into the page that is
       * waiting for it, and dropped.
       */
      if (url.pathname === "/sign-in/code" && request.method === "POST") {
        const input = parseSignInCode(await request.json().catch(() => null));
        if (typeof input === "string") return json({ error: input }, 400);
        const target = await currentPage(botId);
        const result = await fillSignInCode(target, input);
        if (result.submitted) session.snapshotId += 1;
        return json(result);
      }

      if (
        ["/control/take", "/control/release", "/control/cancel"].includes(
          url.pathname,
        ) &&
        request.method === "POST"
      ) {
        const body = (await request.json().catch(() => null)) as {
          requestId?: unknown;
        } | null;
        if (typeof body?.requestId !== "string" || !body.requestId.trim())
          return json({ error: "A requestId is required." }, 400);
        if (url.pathname === "/control/take") {
          const taken = await session.control.take(body.requestId);
          // The browser may have restarted while the request waited; give the person the page. In the
          // background, so "Take control" answers at once; the live screen shows the page as it loads.
          void restoreHandoffPage(botId);
          return json(taken);
        }
        if (url.pathname === "/control/cancel")
          return json(session.control.cancel(body.requestId));
        return json(session.control.release(body.requestId));
      }

      // A person's input, by pixel. The Bot addresses elements by reference because it reads a list; a
      // person addresses them by pointing, because they are looking at a picture. Different problem,
      // different endpoint, and only usable while they hold the wheel.
      if (HUMAN_INPUT.has(url.pathname) && request.method === "POST") {
        if (!session.control.humanMayDrive()) {
          return json({ error: TAKE_CONTROL_FIRST }, 409);
        }
        session.humanInputs += 1;
        const body = (await request.json().catch(() => null)) as Record<
          string,
          unknown
        > | null;
        if (url.pathname === "/human/scroll") {
          const parsed = parseScrollDelta(body?.deltaY);
          if (!parsed.ok) {
            return json({ error: parsed.error }, 400);
          }
        }
        try {
          const target = await currentPage(botId);
          return json(
            await performHumanInput(target, url.pathname, body ?? {}),
          );
        } catch (error) {
          return json({ error: describe(error, "That did not work.") }, 502);
        }
      }

      if (url.pathname === "/health") {
        const [profile] = profiles.summary([botId]);
        return json({
          status: "ok",
          // `browser` kept as it was: it is in the published contract and start.sh reads it.
          browser: profile?.running ?? false,
          profile,
          // Which Bot this computer can prove it is, when the deployment runs SPIRE. Null is a
          // deployment without it, not a failure, and it is reported rather than omitted so the
          // difference between "no identity here" and "identity broken" is visible.
          identity: await identity(),
          browserMode: BROWSER_MODE,
          browserBackend: RUNTIME.backend,
          browserChannel: RUNTIME.channel,
        });
      }

      /**
       * Which run of this Bot's browser the caller is looking at.
       *
       * The server orders snapshots on `(run, generation)`, and the generation alone cannot carry it:
       * this process mints one at zero for every session that is new, so a restart, a redeploy, an
       * eviction from the idle sweep and a reset all produce a page at generation one that looks older
       * than the page the server still has. Ordering on the run as well is what lets the fresh one land
       * and the dead one stop resolving.
       *
       * A read, and deliberately not on the acting list: a person holding the wheel must not turn every
       * ref the server holds into an unanswerable question.
       *
       * Its own endpoint rather than a field on `/computers`, because that one reads the profile
       * directory and this is asked on the path of every governed action.
       */
      if (url.pathname === "/run" && request.method === "GET") {
        return json({ run: session.run });
      }

      /**
       * The computers this process holds. The shape is a list because the admin surface is a
       * list, and because a Bot that has a profile has a computer whether or not a browser is running
       * for it this second.
       */
      if (url.pathname === "/computers" && request.method === "GET") {
        return json({ computers: profiles.summary(await profiles.known()) });
      }

      /**
       * Stop the browser, keep what it knows.
       *
       * Closed gracefully so Chromium flushes its profile, and deliberately
       * not restarted here: the next request starts it again, which is the same path as a first ever
       * start, so there is no second way for a browser to come into existence.
       */
      if (url.pathname === "/computers/stop" && request.method === "POST") {
        const wasRunning = await profiles.stop(botId);
        session.control.interrupt(
          "The computer stopped; the previous task was interrupted.",
        );
        return json({ stopped: true, wasRunning });
      }

      /**
       * Forget everything and start over.
       *
       * Signs the computer out of everything by deleting the profile. Irreversible, which is why it is
       * its own endpoint rather than a flag on the one above: a person clicking "stop" must not be able
       * to discard a login by mistyping a parameter.
       */
      if (url.pathname === "/computers/reset" && request.method === "POST") {
        await profiles.reset(botId);
        session.control.interrupt(
          "The computer was reset; the previous task was interrupted.",
        );
        /*
         * And a new run, because the browser this session described is gone.
         *
         * Nothing else here says so. The entry stays in the map and the generation counter carries on,
         * so a snapshot that was in flight when the wipe landed arrives at the server carrying the same
         * run and the same generation as the fresh browser's would: the server deletes its row on
         * reset, the late save inserts the wiped page straight back, and every ref on it goes on
         * resolving. A new run is what makes those two distinguishable at the far end.
         */
        sessions.renewRun(botId);
        return json({ reset: true, botId });
      }

      if (url.pathname === "/navigate" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          url?: unknown;
          toolCallId?: unknown;
        } | null;
        const parsed = parseNavigateUrl(body?.url);
        if (!parsed.ok) {
          return json({ error: parsed.error }, 400);
        }

        const startedAt = Date.now();
        try {
          const target = await currentPage(botId, "navigate");
          session.control.assertBotMayAct(true);
          const response = await navigateWebPage(
            target,
            parsed.url,
            RUNTIME.backend,
            NAVIGATION_TIMEOUT_MS,
          );
          // A new document wipes every stamp, so every ref handed out before now is meaningless.
          // Bumping the generation makes an action carrying one fail with "take a new snapshot" rather
          // than fall through to a selector that matches nothing and read as a missing element.
          session.snapshotId += 1;
          const extract = await readablePageText(target);
          return json({
            url: target.url(),
            title: await target.title(),
            text: extract.text,
            truncated: extract.truncated,
            elapsedMs: Date.now() - startedAt,
            challenge: await detectChallenge(target, session.control, {
              cfMitigated: response
                ? await response.headerValue("cf-mitigated")
                : undefined,
              toolCallId:
                typeof body?.toolCallId === "string"
                  ? body.toolCallId
                  : undefined,
            }),
          });
        } catch (error) {
          if (
            error instanceof ControlError ||
            error instanceof SnapshotRequiredError
          )
            throw error;
          // The page is the Bot's working surface, so a failed navigation is reported rather than
          // thrown: the transcript needs to say what happened, and the browser stays usable.
          return json(
            {
              error:
                error instanceof Error ? error.message : "Navigation failed.",
            },
            502,
          );
        }
      }

      if (url.pathname === "/screenshot" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          // Sensitive fields are masked in the picture the Bot is handed. See secret-masking.ts.
          const buffer = await target.screenshot({
            type: "png",
            mask: [target.locator(SENSITIVE_FIELD_SELECTOR)],
          });
          const size = target.viewportSize() ?? { width: 1280, height: 800 };
          return json({
            base64: buffer.toString("base64"),
            width: size.width,
            height: size.height,
            capturedAt: new Date().toISOString(),
            // Which page this is a picture of. A browser that has not been sent anywhere sits on
            // `about:blank`, and a screenshot of that is a valid, entirely white PNG, indistinguishable
            // from a real page to anything looking only at the bytes. The transcript needs to tell
            // those apart to avoid presenting a blank browser as though it were a loaded page.
            url: target.url(),
          });
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error ? error.message : "Screenshot failed.",
            },
            502,
          );
        }
      }

      // The Bot's files. Confined to the workspace by workspace.ts. Nothing here decides whether a Bot
      // MAY touch a path: the gateway in front of this process does that.
      if (url.pathname === "/files/download" && request.method === "GET") {
        try {
          const file = await workspace.download(
            url.searchParams.get("path") ?? "",
          );
          return new Response(file.body, {
            headers: downloadHeaders(file.name, file.bytes),
          });
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be downloaded.") },
            fileStatus(error),
          );
        }
      }

      if (url.pathname === "/files/read" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        try {
          return json(await workspace.read(String(body?.path ?? "")));
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be read.") },
            fileStatus(error),
          );
        }
      }

      if (url.pathname === "/files/list" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
        } | null;
        try {
          return json(
            await workspace.list(
              typeof body?.path === "string" ? body.path : undefined,
            ),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The folder could not be listed.") },
            fileStatus(error),
          );
        }
      }

      /*
       * A command on this computer.
       *
       * Nothing here decides whether it may run: the gateway already asked the deployment's policy and
       * wrote the audit row before this was called. Refusing again here would be a second, quieter
       * policy nobody configured.
       */
      if (url.pathname === "/exec" && request.method === "POST") {
        if (!RUNTIME.allowExec)
          return json(
            {
              error:
                "Shell execution is disabled for local Chrome. Use the approved host-access tools to run commands on this computer.",
            },
            403,
          );
        const body = (await request.json().catch(() => null)) as {
          command?: unknown;
          timeoutMs?: unknown;
        } | null;
        if (typeof body?.command !== "string" || !body.command.trim()) {
          return json({ error: "A command is required." }, 400);
        }
        const timeout = parseExecTimeout(body.timeoutMs);
        if (!timeout.ok) {
          return json({ error: timeout.error }, 400);
        }
        try {
          return json(
            await shell.run({
              command: body.command,
              ...(timeout.timeoutMs !== undefined
                ? { timeoutMs: timeout.timeoutMs }
                : {}),
              signal: request.signal,
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The command could not be run.") },
            500,
          );
        }
      }

      if (url.pathname === "/files/write" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
          contents?: unknown;
          append?: unknown;
        } | null;
        if (typeof body?.contents !== "string") {
          return json({ error: "The contents to write are required." }, 400);
        }
        try {
          return json(
            await workspace.write(String(body?.path ?? ""), body.contents, {
              append: body.append === true,
            }),
          );
        } catch (error) {
          return json(
            { error: describe(error, "The file could not be written.") },
            fileStatus(error),
          );
        }
      }

      /**
       * Contract review with native Word Track Changes and comments.
       *
       * Both paths are workspace-confined before Python sees them, and the tool is spawned as argv,
       * so a file name with a space or a semicolon is a file name. The output is a new DOCX: the
       * caller can download it through `/files/download` and open it in Word, where the revisions
       * arrive as Review changes rather than as a diff the lawyer has to reconcile by hand.
       */
      if (url.pathname === "/legal/redline" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          input?: unknown;
          playbook?: unknown;
          output?: unknown;
          author?: unknown;
        } | null;
        const input =
          typeof body?.input === "string" ? body.input.trim() : "";
        const playbook =
          typeof body?.playbook === "string" ? body.playbook.trim() : "";
        if (!input) {
          return json(
            { error: "input must name a DOCX file in the workspace." },
            400,
          );
        }
        if (!playbook) {
          return json(
            { error: "playbook must name a playbook JSON file in the workspace." },
            400,
          );
        }
        if (!/\.docx$/i.test(input)) {
          return json({ error: "input must be a .docx file." }, 400);
        }
        if (!/\.json$/i.test(playbook)) {
          return json({ error: "playbook must be a .json file." }, 400);
        }
        if (
          body?.output !== undefined &&
          (typeof body.output !== "string" || !body.output.trim())
        ) {
          return json({ error: "output must be a workspace path." }, 400);
        }
        const output =
          typeof body?.output === "string" && body.output.trim()
            ? body.output.trim()
            : siblingOutput(input, ".redlined", ".docx");
        if (!/\.docx$/i.test(output)) {
          return json({ error: "output must be a .docx path." }, 400);
        }
        const author =
          typeof body?.author === "string" ? body.author.trim() : "";
        if (author.length > 120) {
          return json(
            { error: "author must be at most 120 characters." },
            400,
          );
        }
        try {
          const inputPath = await workspace.resolvePath(input, false);
          const playbookPath = await workspace.resolvePath(playbook, false);
          const outputPath = await workspace.resolvePath(output, true);
          if (outputPath === inputPath) {
            return json(
              { error: "output must be a different file from input." },
              400,
            );
          }
          await assertWorkspaceFile(inputPath, input, LEGAL_INPUT_BYTES);
          await assertWorkspaceFile(playbookPath, playbook, LEGAL_PLAYBOOK_BYTES);
          const args = [
            "--input",
            inputPath,
            "--playbook",
            playbookPath,
            "--output",
            outputPath,
            "--json",
          ];
          if (author) args.push("--author", author);
          const result = await runLegalTool(
            "contract_redline.py",
            args,
            180_000,
          );
          if (result.exitCode === 0 && !result.timedOut) {
            return legalToolSuccess(result, "contract_redline", output);
          }
          return legalToolResponse(result, "contract_redline");
        } catch (error) {
          return json(
            { error: describe(error, "The contract could not be redlined.") },
            fileStatus(error),
          );
        }
      }

      /**
       * Text extraction from a digital or scanned PDF.
       *
       * The tool decides page by page: a page with a usable text layer is read directly, a page
       * without one is rendered and OCRed in Indonesian and English. The extracted text is written
       * to a workspace file so a 200-page data room does not have to fit in the model's context;
       * `includeText` asks for a bounded preview as well.
       */
      if (url.pathname === "/legal/ocr" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          path?: unknown;
          input?: unknown;
          output?: unknown;
          lang?: unknown;
          dpi?: unknown;
          ocr?: unknown;
          psm?: unknown;
          pages?: unknown;
          minTextChars?: unknown;
          includeText?: unknown;
          maxTextChars?: unknown;
        } | null;
        const input =
          typeof body?.path === "string"
            ? body.path.trim()
            : typeof body?.input === "string"
              ? body.input.trim()
              : "";
        if (!input) {
          return json(
            { error: "path must name a PDF file in the workspace." },
            400,
          );
        }
        if (!/\.pdf$/i.test(input)) {
          return json({ error: "path must be a .pdf file." }, 400);
        }
        if (
          body?.output !== undefined &&
          (typeof body.output !== "string" || !body.output.trim())
        ) {
          return json({ error: "output must be a workspace path." }, 400);
        }
        const output =
          typeof body?.output === "string" && body.output.trim()
            ? body.output.trim()
            : siblingOutput(input, ".ocr", ".txt", false);
        const language =
          typeof body?.lang === "string" && body.lang.trim()
            ? body.lang.trim()
            : "ind+eng";
        if (language.length > 64 || !LEGAL_OCR_LANGUAGES.test(language)) {
          return json(
            {
              error:
                "lang must be Tesseract language codes joined with +, such as ind+eng.",
            },
            400,
          );
        }
        const dpi = body?.dpi === undefined ? 300 : body.dpi;
        if (
          typeof dpi !== "number" ||
          !Number.isInteger(dpi) ||
          dpi < 72 ||
          dpi > 600
        ) {
          return json({ error: "dpi must be an integer from 72 to 600." }, 400);
        }
        const ocrMode = body?.ocr === undefined ? "auto" : body.ocr;
        if (ocrMode !== "auto" && ocrMode !== "always" && ocrMode !== "never") {
          return json(
            { error: "ocr must be auto, always, or never." },
            400,
          );
        }
        const psm = body?.psm === undefined ? 3 : body.psm;
        if (
          typeof psm !== "number" ||
          !Number.isInteger(psm) ||
          psm < 0 ||
          psm > 13
        ) {
          return json(
            { error: "psm must be a Tesseract page segmentation mode from 0 to 13." },
            400,
          );
        }
        const pages =
          typeof body?.pages === "string" && body.pages.trim()
            ? body.pages.trim()
            : undefined;
        if (
          pages !== undefined &&
          (pages.length > 300 ||
            !/^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(pages))
        ) {
          return json(
            { error: "pages must look like 1-5,8 or a comma-separated list." },
            400,
          );
        }
        const minTextChars =
          body?.minTextChars === undefined ? undefined : body.minTextChars;
        if (
          minTextChars !== undefined &&
          (typeof minTextChars !== "number" ||
            !Number.isInteger(minTextChars) ||
            minTextChars < 0 ||
            minTextChars > 10000)
        ) {
          return json(
            { error: "minTextChars must be an integer from 0 to 10000." },
            400,
          );
        }
        const includeText = body?.includeText === true;
        let maxTextChars = 0;
        if (includeText) {
          const requested =
            body?.maxTextChars === undefined ? 20_000 : body.maxTextChars;
          if (
            typeof requested !== "number" ||
            !Number.isInteger(requested) ||
            requested < 1 ||
            requested > 200_000
          ) {
            return json(
              { error: "maxTextChars must be an integer from 1 to 200000." },
              400,
            );
          }
          maxTextChars = requested;
        }
        try {
          const inputPath = await workspace.resolvePath(input, false);
          const outputPath = await workspace.resolvePath(output, true);
          if (outputPath === inputPath) {
            return json(
              { error: "output must be a different file from path." },
              400,
            );
          }
          await assertWorkspaceFile(inputPath, input, LEGAL_INPUT_BYTES);
          const args = [
            "--input",
            inputPath,
            "--output",
            outputPath,
            "--json",
            "--lang",
            language,
            "--dpi",
            String(dpi),
            "--ocr",
            ocrMode,
            "--psm",
            String(psm),
          ];
          if (pages) args.push("--pages", pages);
          if (minTextChars !== undefined) {
            args.push("--min-text-chars", String(minTextChars));
          }
          if (includeText) {
            args.push("--include-text", "--max-text-chars", String(maxTextChars));
          }
          const result = await runLegalTool("pdf_extractor.py", args, 540_000);
          if (result.exitCode === 0 && !result.timedOut) {
            return legalToolSuccess(result, "pdf_extractor", output);
          }
          return legalToolResponse(result, "pdf_extractor");
        } catch (error) {
          return json(
            { error: describe(error, "The PDF could not be processed.") },
            fileStatus(error),
          );
        }
      }

      /**
       * Search the Centralized Legal DB: Supreme Court rulings and UU/PP regulations.
       *
       * The gateway does not get to name the API URL. It lives in this computer's environment, so
       * this endpoint cannot be turned into a request to an arbitrary host, and a deployment
       * without it answers 503 rather than sending the query somewhere else.
       */
      if (url.pathname === "/legal/search-db" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          query?: unknown;
          scope?: unknown;
          limit?: unknown;
          filters?: unknown;
        } | null;
        const query = typeof body?.query === "string" ? body.query.trim() : "";
        if (!query) {
          return json({ error: "query is required." }, 400);
        }
        if (query.length > 2000) {
          return json({ error: "query must be at most 2000 characters." }, 400);
        }
        const scope =
          typeof body?.scope === "string" && body.scope.trim()
            ? body.scope.trim().toLowerCase()
            : "all";
        if (!LEGAL_SCOPES.has(scope)) {
          return json(
            { error: "scope must be all, putusan, or regulasi." },
            400,
          );
        }
        const limit = body?.limit === undefined ? 10 : body.limit;
        if (
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50
        ) {
          return json(
            { error: "limit must be an integer from 1 to 50." },
            400,
          );
        }
        let filtersJson: string | undefined;
        if (body?.filters !== undefined && body.filters !== null) {
          if (
            typeof body.filters !== "object" ||
            Array.isArray(body.filters)
          ) {
            return json({ error: "filters must be a JSON object." }, 400);
          }
          filtersJson = JSON.stringify(body.filters);
          if (filtersJson.length > 10_000) {
            return json({ error: "filters are too large." }, 400);
          }
        }
        if (!process.env.LEGAL_DB_API_URL?.trim()) {
          return json(
            {
              error:
                "LEGAL_DB_API_URL is not configured on this computer, so the Centralized Legal DB is not reachable.",
            },
            503,
          );
        }
        const args = [
          "search",
          query,
          "--scope",
          scope,
          "--limit",
          String(limit),
          "--json",
        ];
        if (filtersJson) args.push("--filters-json", filtersJson);
        const result = await runLegalTool("legal_db_client.py", args, 60_000);
        return legalToolResponse(result, "legal_db_client");
      }

      /**
       * Legal Due Diligence multi-sheet workbook generation.
       *
       * Ingests a data room directory or pre-extracted analysis JSON and produces
       * an Excel (.xlsx) workbook with 5 sheets: Executive Summary, Capital/Management,
       * OSS/KBLI Licensing, Debt/Negative Covenants, and Litigation/Assets.
       */
      if (url.pathname === "/legal/due-diligence" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          input?: unknown;
          output?: unknown;
          client?: unknown;
          target?: unknown;
          reviewer?: unknown;
        } | null;
        const input = typeof body?.input === "string" ? body.input.trim() : "";
        if (!input) {
          return json(
            { error: "input must name a data room directory or analysis JSON file in the workspace." },
            400,
          );
        }
        const output =
          typeof body?.output === "string" && body.output.trim()
            ? body.output.trim()
            : siblingOutput(input, "-dd-matrix", ".xlsx");
        if (!/\.xlsx$/i.test(output)) {
          return json({ error: "output must be an .xlsx path." }, 400);
        }
        try {
          const inputPath = await workspace.resolvePath(input, false);
          const outputPath = await workspace.resolvePath(output, true);
          const args = ["--input", inputPath, "--output", outputPath, "--json"];
          if (typeof body?.client === "string" && body.client.trim()) {
            args.push("--client", body.client.trim());
          }
          if (typeof body?.target === "string" && body.target.trim()) {
            args.push("--target", body.target.trim());
          }
          if (typeof body?.reviewer === "string" && body.reviewer.trim()) {
            args.push("--reviewer", body.reviewer.trim());
          }
          const result = await runLegalTool("due_diligence_matrix.py", args, 240_000);
          if (result.exitCode === 0 && !result.timedOut) {
            return legalToolSuccess(result, "due_diligence", output);
          }
          return legalToolResponse(result, "due_diligence");
        } catch (error) {
          return json(
            { error: describe(error, "The due diligence matrix could not be generated.") },
            fileStatus(error),
          );
        }
      }

      /**
       * Indonesian litigation drafting (Somasi, Gugatan, Matriks Bukti).
       *
       * Accepts structured pleading facts/claims in JSON and renders formal,
       * publication-ready Indonesian court pleadings in DOCX.
       */
      if (url.pathname === "/legal/litigation-draft" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          mode?: unknown;
          input?: unknown;
          output?: unknown;
          basis?: unknown;
          level?: unknown;
        } | null;
        const mode = typeof body?.mode === "string" ? body.mode.trim().toLowerCase() : "";
        if (!["somasi", "gugatan", "matriks-bukti", "matriks_bukti"].includes(mode)) {
          return json(
            { error: "mode must be somasi, gugatan, or matriks-bukti." },
            400,
          );
        }
        const input = typeof body?.input === "string" ? body.input.trim() : "";
        if (!input) {
          return json({ error: "input must name a case JSON file in the workspace." }, 400);
        }
        const output =
          typeof body?.output === "string" && body.output.trim()
            ? body.output.trim()
            : siblingOutput(input, `-${mode}`, ".docx");
        if (!/\.docx$/i.test(output)) {
          return json({ error: "output must be a .docx path." }, 400);
        }
        try {
          const inputPath = await workspace.resolvePath(input, false);
          const outputPath = await workspace.resolvePath(output, true);
          await assertWorkspaceFile(inputPath, input, LEGAL_INPUT_BYTES);
          const args = [mode, "--input", inputPath, "--output", outputPath, "--json"];
          if (typeof body?.basis === "string" && ["wanprestasi", "pmh"].includes(body.basis.trim().toLowerCase())) {
            args.push("--basis", body.basis.trim().toLowerCase());
          }
          if (typeof body?.level === "number" && [1, 2].includes(body.level)) {
            args.push("--level", String(body.level));
          }
          const result = await runLegalTool("litigation_drafter.py", args, 180_000);
          if (result.exitCode === 0 && !result.timedOut) {
            return legalToolSuccess(result, "litigation_drafter", output);
          }
          return legalToolResponse(result, "litigation_drafter");
        } catch (error) {
          return json(
            { error: describe(error, "The litigation pleading could not be drafted.") },
            fileStatus(error),
          );
        }
      }

      /**
       * Formal Indonesian Law Firm Legal Opinion (LO) Memo builder.
       *
       * Compiles facts, issues, authorities, substantive analysis, and mitigations
       * into a standardized 5-part Legal Opinion in DOCX.
       */
      if (url.pathname === "/legal/opinion-memo" && request.method === "POST") {
        const body = (await request.json().catch(() => null)) as {
          input?: unknown;
          output?: unknown;
        } | null;
        const input = typeof body?.input === "string" ? body.input.trim() : "";
        if (!input) {
          return json({ error: "input must name an opinion JSON file in the workspace." }, 400);
        }
        const output =
          typeof body?.output === "string" && body.output.trim()
            ? body.output.trim()
            : siblingOutput(input, "-opinion", ".docx");
        if (!/\.docx$/i.test(output)) {
          return json({ error: "output must be a .docx path." }, 400);
        }
        try {
          const inputPath = await workspace.resolvePath(input, false);
          const outputPath = await workspace.resolvePath(output, true);
          await assertWorkspaceFile(inputPath, input, LEGAL_INPUT_BYTES);
          const args = ["--input", inputPath, "--output", outputPath, "--json"];
          const result = await runLegalTool("legal_opinion_builder.py", args, 180_000);
          if (result.exitCode === 0 && !result.timedOut) {
            return legalToolSuccess(result, "legal_opinion_builder", output);
          }
          return legalToolResponse(result, "legal_opinion_builder");
        } catch (error) {
          return json(
            { error: describe(error, "The legal opinion memo could not be built.") },
            fileStatus(error),
          );
        }
      }

      // The current page as text, without navigating anywhere.
      //
      // Reading must be available after actions too. Returning page text only from `/navigate` would be enough if
      // opening a page were the only way to change what is on screen. It is not: the Bot presses
      // "Submit order", the page becomes a confirmation, and it has no way to find out what the
      // confirmation said. "I clicked the button" is not an answer to what happened.
      if (url.pathname === "/read" && request.method === "GET") {
        try {
          const target = await currentPage(botId);
          const extract = await readablePageText(target);
          return json({
            url: target.url(),
            title: await target.title(),
            text: extract.text,
            truncated: extract.truncated,
            challenge: await detectChallenge(target, session.control),
          });
        } catch (error) {
          return json(
            { error: describe(error, "Reading the page failed.") },
            502,
          );
        }
      }

      // The list of things on the page a Bot can act on. POST rather than GET because it mutates the
      // page, stamping every element it describes, and a GET that changes the document is a lie that
      // caches and prefetchers eventually punish.
      if (url.pathname === "/snapshot" && request.method === "POST") {
        try {
          const target = await currentPage(botId);
          const snapshot = await snapshotPage(session, target);
          return json({
            ...snapshot,
            challenge: await detectChallenge(target, session.control),
          });
        } catch (error) {
          return json({ error: describe(error, "Snapshot failed.") }, 502);
        }
      }

      if (ACTIONS.has(url.pathname) && request.method === "POST") {
        const body = (await request
          .json()
          .catch(() => null)) as ActionBody | null;
        if (!body) {
          return json({ error: "An action needs a JSON body." }, 400);
        }
        if (url.pathname === "/scroll") {
          const parsed = parseScrollDelta(body.deltaY);
          if (!parsed.ok) {
            return json({ error: parsed.error }, 400);
          }
        }

        const startedAt = Date.now();
        try {
          const target = await currentPage(botId);
          session.control.assertBotMayAct(true);
          const detail = await performAction(
            session,
            target,
            url.pathname,
            body,
            // The caller going away is the stop signal: the surface aborts its request, the server
            // aborts the one it made to this computer, and Bun aborts this one in turn.
            request.signal,
          );
          return json({ ...detail, elapsedMs: Date.now() - startedAt });
        } catch (error) {
          /*
           * Stopped, not failed. The signal is checked rather than the error text: Playwright words an
           * abort differently per call, and the caller's own request going away is the fact that
           * matters either way.
           *
           * Logged because the response is not observed after the caller aborts. The log distinguishes
           * "stopped in time" from "ran to completion after cancellation".
           */
          if (
            error instanceof ControlError ||
            error instanceof SnapshotRequiredError
          )
            throw error;
          if (request.signal.aborted) {
            console.info(
              JSON.stringify({
                type: "action-stopped",
                action: url.pathname,
                ref: typeof body.ref === "string" ? body.ref : undefined,
                elapsedMs: Date.now() - startedAt,
              }),
            );
            // 499, the convention for a client that closed the request: this is not the computer
            // failing, and a 502 here would be counted as one.
            return json({ error: "Stopped.", stopped: true }, 499);
          }
          // A stale ref is the caller's mistake and is fixable by taking a new snapshot, so it is a 409
          // rather than a 502: the computer is fine and retrying the same call unchanged will not help.
          if (error instanceof StaleSnapshotError) {
            return json({ error: error.message, stale: true }, 409);
          }
          return json({ error: describe(error, "The action failed.") }, 502);
        }
      }

      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof ControlError) {
        const state = session.control.get();
        return json(
          {
            error: error.message,
            humanHasControl: true,
            requestId: state.request?.id,
            handoff: state.request,
          },
          409,
        );
      }
      if (error instanceof SnapshotRequiredError)
        return json(
          { error: error.message, stale: true, snapshotRequired: true },
          409,
        );
      if (error instanceof ControlRequestError)
        return json(
          { error: error.message, controlRequestError: true },
          error.status,
        );
      throw error;
    } finally {
      releaseAction?.();
    }
  },
});

type ActionBody = {
  ref?: unknown;
  snapshotId?: unknown;
  text?: unknown;
  key?: unknown;
  deltaY?: unknown;
  submit?: unknown;
};

const ACTIONS = new Set(["/click", "/type", "/key", "/scroll"]);

const HUMAN_INPUT = new Set([
  "/human/click",
  "/human/type",
  "/human/key",
  "/human/scroll",
]);

/**
 * Carry out one thing a person did with their mouse or keyboard.
 *
 * Coordinates are viewport pixels, which the surface works out from the screenshot it is displaying:
 * it knows the image's natural size and the size it drew it at, so it can scale a click back. Doing
 * that conversion in the browser rather than here keeps this endpoint bound to page coordinates
 * rather than window coordinates.
 *
 * Nothing a person types here reaches the model. It goes from their keyboard to this browser and
 * stops. That is what makes a password or a one-time code safe to enter during a takeover: not a
 * filter that strips it out afterwards, but a path the model is not on. The same reason the value is
 * never returned and never logged below.
 */
async function performHumanInput(
  target: Page,
  action: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const at = (): { x: number; y: number } => {
    const x = typeof body.x === "number" ? body.x : Number.NaN;
    const y = typeof body.y === "number" ? body.y : Number.NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("A click needs an x and a y inside the page.");
    }
    // Clamped rather than rejected. A click a pixel outside the viewport is a rounding artefact of
    // scaling the screenshot, not a mistake worth refusing.
    return {
      x: Math.min(Math.max(x, 0), VIEWPORT.width - 1),
      y: Math.min(Math.max(y, 0), VIEWPORT.height - 1),
    };
  };

  if (action === "/human/click") {
    const { x, y } = at();
    await target.mouse.click(x, y);
    return { action: "human_click", url: target.url() };
  }

  if (action === "/human/type") {
    if (typeof body.text !== "string") {
      throw new Error("Typing needs text.");
    }
    // `insertText` rather than per-key typing: a person pasting a one-time code should not have it
    // arrive one character at a time into a field that reformats as you go.
    await target.keyboard.insertText(body.text);
    // Length only, never the value. See the note above about the model not being on this path.
    return {
      action: "human_type",
      characters: body.text.length,
      url: target.url(),
    };
  }

  if (action === "/human/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name.");
    }
    await target.keyboard.press(body.key);
    return { action: "human_key", key: body.key, url: target.url() };
  }

  const parsed = parseScrollDelta(body.deltaY);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const deltaY = parsed.deltaY ?? 400;
  await target.mouse.wheel(0, deltaY);
  return { action: "human_scroll", deltaY, url: target.url() };
}

/**
 * Carry out one action on the page.
 *
 * Every action that addresses an element goes through {@link locateRef}, so the staleness check
 * cannot be forgotten at a call site. `/key` and `/scroll` may omit a ref and act on the page itself,
 * which is how a Bot presses Enter to submit or scrolls to bring more of a long form into view.
 *
 * Stop has to reach the browser. `signal` is the caller's request going away, the person pressed
 * Stop, and the abort travels from the surface, through the server, to here. Without passing it on,
 * pressing Stop ended the run in the transcript while the click it was meant to prevent carried on
 * landing on a live page. Stop must reach the browser before a high-impact click lands.
 */
async function performAction(
  session: BotSession,
  target: Page,
  action: string,
  body: ActionBody,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Passed to every Playwright call below. It does not disable the timeout, which still applies.
  const acting = { timeout: ACTION_TIMEOUT_MS, ...(signal ? { signal } : {}) };
  const expected =
    typeof body.snapshotId === "number" ? body.snapshotId : undefined;
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;

  if (action === "/click") {
    if (!ref) throw new Error("A click needs the ref of an element to click.");
    await (await resolveRef(session, target, ref, expected)).click(acting);
    return { action: "click", ref, url: target.url() };
  }

  if (action === "/type") {
    if (!ref) throw new Error("Typing needs the ref of a field to type into.");
    if (typeof body.text !== "string") {
      throw new Error("Typing needs the text to enter.");
    }
    const field = await resolveRef(session, target, ref, expected);
    // `fill` rather than keystrokes: it clears the field first, which is what "put this value in
    // this box" means. Typing into a field a previous attempt half-filled otherwise appends, and the
    // form ends up with "AlicAlice" in it.
    await field.fill(body.text, acting);
    if (body.submit === true) {
      await field.press("Enter", acting);
    }
    // The text itself is deliberately NOT returned. It is echoed nowhere: this response is read by
    // the model and logged by the server, and a value typed into a form is exactly where a password
    // or a card number lives. The caller already knows what it sent.
    return {
      action: "type",
      ref,
      characters: body.text.length,
      submitted: body.submit === true,
      url: target.url(),
    };
  }

  if (action === "/key") {
    if (typeof body.key !== "string" || !body.key) {
      throw new Error("A key press needs a key name, such as Enter or Tab.");
    }
    if (ref) {
      await (await resolveRef(session, target, ref, expected)).press(
        body.key,
        acting,
      );
    } else {
      await target.keyboard.press(body.key);
    }
    return { action: "key", key: body.key, ref, url: target.url() };
  }

  // Scroll. A plain wheel event on the page, which is what moves a long form, rather than scrolling a
  // specific element into view: the Bot asked to see further down, not to hunt for one control.
  const parsed = parseScrollDelta(body.deltaY);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  const deltaY = parsed.deltaY ?? 600;
  await target.mouse.wheel(0, deltaY);
  return { action: "scroll", deltaY, url: target.url() };
}

function describe(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Which status a file failure deserves.
 *
 * A path outside the workspace is the caller asking for something it may never have, so 403: retrying
 * it unchanged will never work, and it is not a fault. A missing download is 404, an oversized
 * download is 413, and an ordinary bad file request is 400, because a different request could
 * succeed. Collapsing these into 500 would tell the caller the computer is broken and invite a retry
 * of the same request.
 */
function fileStatus(error: unknown): 400 | 403 | 404 | 413 | 500 {
  if (error instanceof WorkspacePathError) return 403;
  if (error instanceof WorkspaceFileTooLargeError) return 413;
  if (error instanceof WorkspaceFileNotFoundError) return 404;
  if (error instanceof WorkspaceFileError) return 400;
  return 500;
}

console.info(`agent-computer listening on http://127.0.0.1:${PORT}`);

/**
 * Hand the profile back before dying.
 *
 * `docker stop` and a Kubernetes eviction both send SIGTERM and then wait, so this is the window in
 * which Chromium can flush its profile to the volume. This is the graceful-shutdown path for normal
 * container restarts.
 *
 * `stop_grace_period` in docker-compose.yml is what gives this time to run.
 */
let shuttingDown = false;

async function shutDown(reason: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  // Set before the first await: a display exiting while Chromium flushes is part of this shutdown,
  // not a second failure racing it.
  shuttingDown = true;
  console.info(`${reason}: closing the browser so its profile is flushed`);
  await profiles.closeAll();
  await VIRTUAL_DISPLAY?.stop();
  process.exit(exitCode);
}

if (VIRTUAL_DISPLAY) {
  void VIRTUAL_DISPLAY.terminated.then(({ code, expected }) => {
    if (expected || shuttingDown) return;
    console.error(
      JSON.stringify({
        type: "computer-virtual-display-exited",
        exitCode: code,
      }),
    );
    // A headed Chromium cannot recover without its display. Let the container restart policy build
    // the pair together again instead of advertising a healthy service whose next browser fails.
    void shutDown("virtual display exited", 1);
  });
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutDown(signal, 0);
  });
}
