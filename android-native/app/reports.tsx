import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Card, KeyValue, Note, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { useSession } from "@/lib/session/store";
import { C } from "@/lib/ui/theme";

export default function ReportsScreen() {
  const { state } = useSession();
  const e = state.evidence;
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>REPORT</Text>
          <Text style={styles.subtitle}>The provenance of the current session.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="SOURCE" />
          {e ? (
            <>
              <KeyValue label="File" value={e.name} mono={false} />
              <KeyValue label="Format" value={e.format.toUpperCase()} mono={false} />
              <KeyValue label="Decoder" value={e.decoder} mono={false} />
              <KeyValue label="Dimensions" value={`${e.width} × ${e.height} px`} mono={false} />
              <KeyValue label="Stored depth" value={`${e.depth}-bit`} mono={false} />
              <KeyValue label="Opened" value={new Date(e.opened).toLocaleString()} mono={false} />
              <KeyValue label="MD5" value={e.md5} />
              <KeyValue label="SHA-1" value={e.sha1} />
              <KeyValue label="SHA-256" value={e.sha256} />
            </>
          ) : (
            <Body>No evidence is open, so there is nothing to report yet.</Body>
          )}
        </Card>

        <Card>
          <SectionTitle index="02" title="PROCESSING" />
          {state.result ? (
            <>
              <KeyValue label="Filters" value={state.result.applied.join(" → ") || "none"} mono={false} />
              <KeyValue label="Output size" value={`${state.result.width} × ${state.result.height} px`} mono={false} />
              <KeyValue label="Duration" value={`${state.result.ms} ms`} mono={false} />
              <KeyValue label="Output sample MD5" value={state.result.outputMd5} />
              <KeyValue label="Executed" value={new Date(state.result.at).toLocaleString()} mono={false} />
            </>
          ) : (
            <Body>The chain was not run yet, so there is no output to report.</Body>
          )}
        </Card>

        <Card>
          <SectionTitle index="03" title="CHAIN" />
          {state.chain.filters.length ? (
            state.chain.filters.map((f, i) => (
              <KeyValue
                key={f.id}
                label={`${String(i + 1).padStart(2, "0")} · ${f.enabled ? "enabled" : "disabled"}`}
                value={f.type}
              />
            ))
          ) : (
            <Body>The chain is empty.</Body>
          )}
        </Card>

        <Note>
          The export of the report as a file (with the case information, the parameters and the hashes) is part of the
          next milestone of the build; this screen shows the same provenance in the app.
        </Note>
        <Row style={styles.pillRow}>
          <Pill title="SOURCE IMMUTABLE" tone="success" />
          <Pill title="ON-DEVICE" />
        </Row>
      </Screen>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  pillRow: { flexWrap: "wrap" },
});
