import Constants from "expo-constants";
import { Platform, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Card, KeyValue, Note, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { useSession } from "@/lib/session/store";
import { C } from "@/lib/ui/theme";

export default function SettingsScreen() {
  const { state } = useSession();
  const appVersion = Constants.expoConfig?.version ?? "1.0.0";
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>SETTINGS</Text>
          <Text style={styles.subtitle}>Build, permissions and the state of the session.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="BUILD" />
          <KeyValue label="App version" value={appVersion} mono={false} />
          <KeyValue label="Platform" value={`${Platform.OS} ${Platform.Version}`} mono={false} />
          <KeyValue label="Application id" value={Constants.expoConfig?.android?.package ?? "space.manus.clearufonat.t087974638181694"} />
          <Row style={styles.pillRow}>
            <Pill title="MIN SDK 29 (ANDROID 10)" />
            <Pill title="NO INTERNET PERMISSION" tone="success" />
            <Pill title="NO NETWORK STATE PERMISSION" tone="success" />
          </Row>
          <Note tone="success">
            The Android configuration blocks the INTERNET and the ACCESS_NETWORK_STATE permissions, so the app cannot
            reach the network even if a code path asked for it.
          </Note>
        </Card>

        <Card>
          <SectionTitle index="02" title="PROCESSING DEFAULTS" />
          <Body>
            The filters use the values of the browser workbench: the same defaults, the same legacy values for the
            projects saved earlier, the same rounding and the same colour matrices. The frames are stored as 32-bit
            floating point and the intermediate results are computed in double precision, exactly as in the reference.
          </Body>
        </Card>

        <Card>
          <SectionTitle index="03" title="SESSION" />
          <KeyValue label="Evidence" value={state.evidence?.name ?? "none"} mono={false} />
          <KeyValue label="Filters in the chain" value={String(state.chain.filters.length)} mono={false} />
          <KeyValue label="History entries" value={String(state.history.length)} mono={false} />
          <KeyValue label="Undo steps" value={String(state.undoStack.length)} mono={false} />
          <KeyValue label="Redo steps" value={String(state.redoStack.length)} mono={false} />
        </Card>
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
