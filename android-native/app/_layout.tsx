import "@/global.css";
import "react-native-reanimated";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "@/lib/_core/nativewind-pressable";

import { SessionProvider } from "@/lib/session/store";

export const unstable_settings = {
  anchor: "(tabs)",
};

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <SessionProvider>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#080808" } }}>
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="more" options={{ presentation: "card" }} />
            <Stack.Screen name="reports" options={{ presentation: "card" }} />
            <Stack.Screen name="settings" options={{ presentation: "card" }} />
            <Stack.Screen name="help" options={{ presentation: "card" }} />
          </Stack>
        </SessionProvider>
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
