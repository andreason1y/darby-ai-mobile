import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: "Darby AI",
  slug: "darby-ai",
  version: "1.0.0",
  scheme: "darbyai",
  ios: { bundleIdentifier: "ai.darby.mobile", supportsTablet: true },
  android: { package: "ai.darby.mobile" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "darby-ai" }],
  ],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
