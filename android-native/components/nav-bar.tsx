// The bottom navigation of the app: evidence, workbench, video, cases and the more section.
// The navigation is drawn by the app itself (instead of the platform tab bar) to keep the
// instrument look of the workbench.
import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { C, S } from "@/lib/ui/theme";

export interface NavItem {
  key: string;
  label: string;
  href: string;
  glyph: string;
}

export const NAV_ITEMS: NavItem[] = [
  { key: "evidence", label: "Evidence", href: "/", glyph: "▣" },
  { key: "workbench", label: "Workbench", href: "/workbench", glyph: "◧" },
  { key: "video", label: "Video", href: "/video", glyph: "▶" },
  { key: "cases", label: "Cases", href: "/cases", glyph: "▤" },
  { key: "more", label: "More", href: "/more", glyph: "⋯" },
];

export function NavBar({ active }: { active: string }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, S.sm) }]}>
      {NAV_ITEMS.map((item) => {
        const on = item.key === active;
        return (
          <Pressable
            key={item.key}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            accessibilityLabel={item.label}
            onPress={() => router.push(item.href as Parameters<typeof router.push>[0])}
            style={styles.item}
          >
            <Text style={[styles.glyph, on ? styles.glyphOn : null]}>{item.glyph}</Text>
            <Text style={[styles.label, on ? styles.labelOn : null]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    backgroundColor: "#0b0b0b",
    borderTopWidth: 1,
    borderTopColor: C.line,
    paddingTop: 8,
  },
  item: { flex: 1, alignItems: "center", gap: 2, paddingHorizontal: 2 },
  glyph: { color: C.dim, fontSize: 15 },
  glyphOn: { color: C.text },
  label: { color: C.dim, fontSize: 9, fontWeight: "700", letterSpacing: 0.4 },
  labelOn: { color: C.text },
});
