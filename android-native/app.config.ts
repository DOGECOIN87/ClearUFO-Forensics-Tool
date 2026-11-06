import "./scripts/load-env.js";
import type { ExpoConfig } from "expo/config";

// Preserve the project-generated identifiers; Android package segments start with a letter.
const bundleId = "space.manus.clearufonat.t087974638181694";
const timestamp = bundleId.split(".").pop()?.replace(/^t/, "") ?? "";
const scheme = `manus${timestamp}`;

const appBrand = {
  appName: "ClearUFO Forensics Native",
  appSlug: "clearufonat",
  logoUrl: "https://raw.githubusercontent.com/DOGECOIN87/ClearUFO-Forensics-Tool/main/docs/img/clearufo-logo.jpg",
};

const config: ExpoConfig = {
  name: appBrand.appName,
  slug: appBrand.appSlug,
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme,
  userInterfaceStyle: "dark",
  ios: {
    supportsTablet: true,
    bundleIdentifier: bundleId,
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#080808",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    predictiveBackGestureEnabled: false,
    package: bundleId,
    permissions: [],
    blockedPermissions: ["android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE"],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-asset",
    "expo-router",
    [
      "expo-splash-screen",
      {
        image: "./assets/images/splash-icon.png",
        imageWidth: 200,
        resizeMode: "contain",
        backgroundColor: "#080808",
        dark: { backgroundColor: "#080808" },
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["armeabi-v7a", "arm64-v8a"],
          minSdkVersion: 29,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
