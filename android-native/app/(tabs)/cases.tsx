import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Btn, Card, EmptyState, KeyValue, Note, Pill, Row, Screen, SectionTitle } from "@/components/clearufo";
import { NavBar } from "@/components/nav-bar";
import { buildProjectDoc, deleteCase, listCases, saveCase, type StoredCase } from "@/lib/project/caseStore";
import { useSession } from "@/lib/session/store";
import { SOURCE_ID } from "@/lib/session/workbench";
import { C, S, mono } from "@/lib/ui/theme";

export default function CasesScreen() {
  const { state, log, setNotice, setError } = useSession();
  const [cases, setCases] = useState<StoredCase[]>([]);
  const [name, setName] = useState("");
  const [caseNumber, setCaseNumber] = useState("");
  const [examiner, setExaminer] = useState("");

  const refresh = useCallback(async () => {
    setCases(await listCases());
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  const save = useCallback(async () => {
    try {
      const evidence = state.evidence;
      const doc = buildProjectDoc({
        name: name.trim() || (evidence ? evidence.name : "Case"),
        chains: [state.chain],
        sources: evidence
          ? {
              [SOURCE_ID]: {
                id: SOURCE_ID,
                kind: "image",
                name: evidence.name,
                files: [{ name: evidence.name, size: evidence.bytes.length, lastModified: Date.now(), type: evidence.format }],
                md5: evidence.md5,
                sha1: evidence.sha1,
                sha256: evidence.sha256,
              },
            }
          : {},
        caseInfo: { caseNumber, examiner },
      });
      const id = await saveCase(doc);
      await refresh();
      log({
        kind: "case",
        title: `Case saved: ${doc.name}`,
        detail: `${state.chain.filters.length} filters · ${caseNumber || "no case number"}`,
      });
      setNotice(`The case was saved on the device (${id}).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [caseNumber, examiner, log, name, refresh, setError, setNotice, state.chain, state.evidence]);

  const remove = useCallback(
    async (id: string) => {
      await deleteCase(id);
      await refresh();
      setNotice("The case was removed from the device.");
    },
    [refresh, setNotice],
  );

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>CASES</Text>
          <Text style={styles.subtitle}>Case files are stored on the device only. Nothing is uploaded.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="NEW CASE" />
          <Text style={styles.label}>Case name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder={state.evidence?.name ?? "Case name"}
            placeholderTextColor={C.dim}
            style={styles.input}
          />
          <Text style={styles.label}>Case number</Text>
          <TextInput value={caseNumber} onChangeText={setCaseNumber} placeholder="e.g. 2026-114" placeholderTextColor={C.dim} style={styles.input} />
          <Text style={styles.label}>Examiner</Text>
          <TextInput value={examiner} onChangeText={setExaminer} placeholder="Name" placeholderTextColor={C.dim} style={styles.input} />
          <Btn title="Save case on device" onPress={save} />
        </Card>

        <Card>
          <SectionTitle index="02" title="CASES ON THIS DEVICE" note={`${cases.length}`} />
          {cases.length === 0 ? (
            <EmptyState title="No cases yet" copy="A case keeps the chains, the parameters and the hashes of the evidence." />
          ) : (
            cases.map((c) => (
              <View key={c.id} style={styles.case}>
                <Row style={styles.caseHead}>
                  <Text style={styles.caseName} numberOfLines={1}>
                    {c.doc.name}
                  </Text>
                  <Pill title={`${c.doc.chains[0]?.filters.length ?? 0} FILTERS`} />
                </Row>
                <KeyValue label="Case number" value={c.doc.caseInfo.caseNumber || "—"} mono={false} />
                <KeyValue label="Examiner" value={c.doc.caseInfo.examiner || "—"} mono={false} />
                <KeyValue label="Modified" value={new Date(c.doc.modified).toLocaleString()} />
                <KeyValue label="Evidence MD5" value={Object.values(c.doc.sources)[0]?.md5 ?? "—"} />
                <Pressable accessibilityRole="button" onPress={() => remove(c.id)} style={styles.delete}>
                  <Text style={styles.deleteLabel}>Delete case</Text>
                </Pressable>
              </View>
            ))
          )}
        </Card>

        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {state.notice ? <Note tone="success">{state.notice}</Note> : null}
        <Body>The case file uses the same schema as the browser workbench (schema 3), so it can be exchanged with it.</Body>
      </Screen>
      <NavBar active="cases" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  label: { color: C.dim, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  input: {
    backgroundColor: C.black,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 8,
    color: C.text,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 12,
  },
  case: { borderWidth: 1, borderColor: C.line, borderRadius: 10, padding: S.sm, gap: 6, backgroundColor: C.panelRaised },
  caseHead: { justifyContent: "space-between" },
  caseName: { color: C.text, fontSize: 14, fontWeight: "700", flex: 1 },
  delete: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: S.sm },
  deleteLabel: { color: C.error, fontSize: 11, fontWeight: "700" },
});
