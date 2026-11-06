import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Card, EmptyState, KeyValue, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { NavBar } from "@/components/nav-bar";
import { useSession } from "@/lib/session/store";
import { C, S, mono } from "@/lib/ui/theme";

const KIND_LABEL: Record<string, string> = {
  source: "SOURCE",
  process: "PROCESS",
  export: "EXPORT",
  case: "CASE",
};

export default function HistoryScreen() {
  const { state } = useSession();
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>HISTORY</Text>
          <Text style={styles.subtitle}>Every step of this session, with the hash of the result.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="SESSION LOG" note={`${state.history.length} entries`} />
          {state.history.length === 0 ? (
            <EmptyState title="Nothing happened yet" copy="Opening evidence, running a chain and exporting fill this list." />
          ) : (
            state.history.map((h, i) => (
              <View key={`${h.time}-${i}`} style={styles.entry}>
                <Row style={styles.entryHead}>
                  <Pill
                    title={KIND_LABEL[h.kind] ?? h.kind.toUpperCase()}
                    tone={h.kind === "export" ? "success" : h.kind === "source" ? "warning" : "default"}
                  />
                  <Text style={styles.time}>{new Date(h.time).toLocaleTimeString()}</Text>
                </Row>
                <Text style={styles.entryTitle}>{h.title}</Text>
                <Text style={styles.entryDetail}>{h.detail}</Text>
                {h.outputHash ? <KeyValue label="MD5" value={h.outputHash} /> : null}
              </View>
            ))
          )}
        </Card>

        <Card>
          <SectionTitle index="02" title="PROVENANCE OF THE OPEN SOURCE" />
          {state.evidence ? (
            <>
              <KeyValue label="File" value={state.evidence.name} mono={false} />
              <KeyValue label="Format" value={state.evidence.format.toUpperCase()} mono={false} />
              <KeyValue label="Decoder" value={state.evidence.decoder} mono={false} />
              <KeyValue label="Dimensions" value={`${state.evidence.width} × ${state.evidence.height} px`} mono={false} />
              <KeyValue label="Stored depth" value={`${state.evidence.depth}-bit`} mono={false} />
              <KeyValue label="MD5" value={state.evidence.md5} />
              <KeyValue label="SHA-1" value={state.evidence.sha1} />
              <KeyValue label="SHA-256" value={state.evidence.sha256} />
              <Body>
                The hashes were computed from the bytes as they were read. The original file is opened read only and
                is never written to by the app.
              </Body>
            </>
          ) : (
            <Body>No evidence is open.</Body>
          )}
        </Card>
      </Screen>
      <NavBar active="history" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  entry: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: S.sm, gap: 4, backgroundColor: C.panelRaised },
  entryHead: { justifyContent: "space-between" },
  time: { color: C.dim, fontSize: 10, fontFamily: mono.fontFamily },
  entryTitle: { color: C.text, fontSize: 13, fontWeight: "700" },
  entryDetail: { color: C.muted, fontSize: 11, lineHeight: 15 },
});
