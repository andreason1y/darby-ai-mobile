import { expoClient } from "@better-auth/expo/client";
import { ssoClient } from "@better-auth/sso/client";
import { createAuthClient } from "better-auth/react";
import * as SecureStore from "expo-secure-store";

const fallbackServerUrl = "http://100.102.255.114:4000";
const configured = process.env.EXPO_PUBLIC_SERVER_URL || fallbackServerUrl;
const endpoint = new URL(configured);
if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:")
  throw new Error("OpenBot server URL must use HTTP or HTTPS.");
if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
  throw new Error(
    "Use the public deployment URL without credentials or query parameters.",
  );
export const serverUrl = endpoint.origin;
export const DEMO_SESSION = {
  user: {
    id: "user_test_lawyer",
    name: "Advokat / Legal Counsel",
    email: "legal@darby.internal",
  },
  session: { id: "sess_demo" },
} as const;
export function getSession() {
  return DEMO_SESSION;
}
export function useSession() {
  return { data: DEMO_SESSION, isPending: false, error: null };
}
export const authClient = createAuthClient({
  baseURL: serverUrl,
  plugins: [
    expoClient({
      scheme: "openbotmobile",
      storagePrefix: `openbot-${endpoint.host.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      storage: SecureStore,
    }),
    ssoClient(),
  ],
});
export async function signIn(provider: "google" | "microsoft" | "okta") {
  const result = await authClient.signIn.social({
    provider: provider as "google",
    callbackURL: "openbotmobile://",
  });
  if (result.error)
    throw new Error(result.error.message ?? "Could not sign in.");
}
export async function signInEnterprise(email: string) {
  const result = await authClient.signIn.sso({
    email,
    callbackURL: "openbotmobile://",
  });
  if (result.error)
    throw new Error(
      result.error.message ?? "Could not sign in to your organization.",
    );
}
