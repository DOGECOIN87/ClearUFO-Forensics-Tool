import { useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Card, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { useSession } from "@/lib/session/store";
import { C, S } from "@/lib/ui/theme";

const ENTRIES: { href: string; title: string; copy: string; note?: string }[] = [
  { href: "/history", title: "History", copy: "Every step of the session with the hash of the result." },
  { href: "/reports", title: "Reports", copy: "The case report: provenance, parameters and output hashes." },
  { href: "/settings", title: "Settings", copy: "Defaults of the workbench and the state of the offline build." },
  { href: "/help", title: "Help & diagnostics", copy: "What this build can do, and how to check it." },
];

export default function MoreScreen() {
  const router = useRouter();
  const { state } = useSession();
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>MORE</Text>
          <Text style={styles.subtitle}>ClearUFO Forensics Native · offline build</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="SECTIONS" />
          {ENTRIES.map((e) => (
            <Pressable
              key={e.href}
              accessibilityRole="button"
              onPress={() => router.push(e.href as Parameters<typeof router.push>[0])}
              style={({ pressed }) => [styles.entry, pressed ? styles.pressed : null]}
            >
              <Row style={styles.entryHead}>
                <Text style={styles.entryTitle}>{e.title}</Text>
                <Text style={styles.chevron}>›</Text>
              </Row>
              <Text style={styles.entryCopy}>{e.copy}</Text>
            </Pressable>
          ))}
        </Card>

        <Card>
          <SectionTitle index="02" title="BUILD" />
          <Row style={styles.pillRow}>
            <Pill title="OFFLINE" tone="success" />
            <Pill title="NO INTERNET PERMISSION" />
            <Pill title="ON-DEVICE PROCESSING" />
          </Row>
          <Body>
            The evidence is processed on the device. The app does not use the network and does not store anything on a
            server.
          </Body>
          <Body>
            Session: {state.evidence ? state.evidence.name : "no evidence open"} · {state.chain.filters.length} filters in
            the chain · {state.history.length} history entries.
          </Body>
        </Card>
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  entry: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: S.md, gap: 4, backgroundColor: C.panelRaised },
  pressed: { opacity: 0.75 },
  entryHead: { justifyContent: "space-between" },
  entryTitle: { color: C.text, fontSize: 14, fontWeight: "700" },
  chevron: { color: C.muted, fontSize: 16 },
  entryCopy: { color: C.muted, fontSize: 11, lineHeight: 15 },
  pillRow: { flexWrap: "wrap" },
});
