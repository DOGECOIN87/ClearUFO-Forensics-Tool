import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarStyle: { display: "none" } }}>
      <Tabs.Screen name="index" options={{ title: "Evidence" }} />
      <Tabs.Screen name="workbench" options={{ title: "Workbench" }} />
      <Tabs.Screen name="video" options={{ title: "Video" }} />
      <Tabs.Screen name="cases" options={{ title: "Cases" }} />
      <Tabs.Screen name="history" options={{ title: "History" }} />
    </Tabs>
  );
}
