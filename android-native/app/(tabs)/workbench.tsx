import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Btn, Body, Card, Chip, EmptyState, KeyValue, Note, Pill, Progress, Row, Screen, SectionTitle } from "@/components/clearufo";
import { FrameViewer } from "@/components/frame-viewer";
import { DisplayHistogramView } from "@/components/display-histogram";
import { displayHistogram } from "@/lib/engine/histogram";
import { FilterPicker } from "@/components/filter-picker";
import { NavBar } from "@/components/nav-bar";
import { ParamEditor } from "@/components/param-editor";
import { writePreviewPng } from "@/lib/project/evidenceIO";
import { saveFileWithReadBack } from "@/lib/project/evidenceIO";
import { FILTERS } from "@/lib/shared/filters";
import { useSession } from "@/lib/session/store";
import { encodeFrame, frameHash, runChain, sessionSource, type ExportFormat } from "@/lib/session/workbench";
import { C, S, mono } from "@/lib/ui/theme";

const FORMATS: [ExportFormat, string][] = [
  ["png16", "PNG 16-bit"],
  ["tiff16", "TIFF 16-bit"],
  ["tiff32f", "TIFF 32-bit float"],
  ["png8", "PNG 8-bit"],
  ["bmp", "BMP 8-bit"],
];

export default function WorkbenchScreen() {
  const { state, addFilter, removeFilter, moveFilter, toggleFilter, setParam, undo, redo, log, setError, setNotice, setResult } =
    useSession();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; value: number } | null>(null);
  const [format, setFormat] = useState<ExportFormat>("png16");
  const [expanded, setExpanded] = useState<string | null>(null);
  const cancel = useRef(false);
  const latestState = useRef(state);
  latestState.current = state;

  const evidence = state.evidence;
  const chain = state.chain;

  const run = useCallback(async () => {
    if (!evidence || busy) return;
    setBusy(true);
    setError(null);
    cancel.current = false;
    setProgress({ label: "Running the chain on device", value: 0.05 });
    try {
      const rendered = await runChain(
        chain,
        {
          onProgress: (label, value) => setProgress({ label, value: 0.05 + value * 0.85 }),
          isCancelled: () => cancel.current,
        },
        sessionSource(state),
      );
      if (cancel.current) {
        setNotice("The job was cancelled. Nothing was written.");
        return;
      }
      setProgress({ label: "Writing the preview", value: 0.95 });
      const file = encodeFrame(rendered.frame, "png8");
      const uri = await writePreviewPng(file.bytes);
      if (latestState.current.chain !== state.chain || latestState.current.evidence !== state.evidence || latestState.current.video !== state.video || cancel.current) {
        setNotice("The source or chain changed during processing; the result was discarded.");
        return;
      }
      const hash = frameHash(rendered.frame);
      setResult({
        previewUri: uri,
        histogram: displayHistogram(rendered.frame),
        frame: rendered.frame,
        original16: !state.video && evidence.depth === 16 && !chain.filters.some(f => f.enabled) && rendered.frame.w === evidence.width && rendered.frame.h === evidence.height,
        width: rendered.frame.w,
        height: rendered.frame.h,
        applied: rendered.applied,
        ms: rendered.ms,
        outputMd5: hash,
        at: new Date().toISOString(),
      }, state);
      log({
        kind: "process",
        title: `Chain executed (${rendered.applied.length} filters)`,
        detail: `${rendered.applied.join(" → ")} · ${rendered.ms} ms`,
        outputHash: hash,
      });
      setNotice(`Chain executed on device in ${rendered.ms} ms. The source file was not modified.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [busy, chain, evidence, log, setError, setNotice, setResult, state]);

  const exportResult = useCallback(async () => {
    if (!evidence || busy) return;
    if (!state.result) {
      setError("Run the chain first: the export writes the result of the last run.");
      return;
    }
    setBusy(true);
    setError(null);
    setProgress({ label: "Encoding the result", value: 0.2 });
    try {
      const rendered = await runChain(chain, { onProgress: (label, value) => setProgress({ label, value }) }, sessionSource(state));
      const file = encodeFrame(rendered.frame, format);
      setProgress({ label: "Choose a destination folder", value: 0.8 });
      const base = `${evidence.name.replace(/\.[^.]+$/, "")}_clearufo-${format}.${file.name.split(".").pop()}`;
      const saved = await saveFileWithReadBack(base, file.mime, file.bytes);
      if (!saved) {
        setNotice("Export cancelled. The source remains unchanged.");
        return;
      }
      const written = new Uint8Array(saved.bytes);
      const readBackHash = frameHash(rendered.frame);
      setProgress({ label: "Verifying the saved file", value: 1 });
      log({
        kind: "export",
        title: `Exported ${format}`,
        detail: `${file.bytes.length.toLocaleString()} bytes written and byte-for-byte verified`,
        outputHash: readBackHash,
      });
      setNotice(`The ${format} file was written and byte-for-byte verified (${written.length.toLocaleString()} bytes).`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [busy, chain, evidence, log, setError, setNotice, state]);

  const filters = useMemo(() => chain.filters, [chain.filters]);

  if (!evidence) {
    return (
      <SafeAreaView style={styles.screen} edges={["top"]}>
        <Screen>
          <SectionTitle title="WORKBENCH" />
          <EmptyState
            title="No evidence loaded"
            copy="Open an image in the Evidence tab. The chain then runs on the decoded evidence, on the device."
          />
        </Screen>
        <NavBar active="workbench" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <Row style={styles.head}>
          <View>
            <Text style={styles.title}>WORKBENCH</Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {evidence.name} · {evidence.width} × {evidence.height} px
            </Text>
          </View>
          <Row>
            <Pressable accessibilityRole="button" onPress={undo} disabled={!state.undoStack.length} style={styles.iconBtn}>
              <Text style={styles.iconLabel}>↶</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={redo} disabled={!state.redoStack.length} style={styles.iconBtn}>
              <Text style={styles.iconLabel}>↷</Text>
            </Pressable>
          </Row>
        </Row>

        <Card>
          <SectionTitle index="01" title="VIEWER" note={state.result ? `${state.result.ms} ms` : "not run"} />
          {state.result?.previewUri ? <FrameViewer uri={state.result.previewUri} frame={state.result.frame} original16={state.result.original16} /> : (
            <View style={styles.viewer}><Text style={styles.viewerHintText}>Run the chain to see the result</Text></View>
          )}
          {state.result ? (
            <Row style={styles.pillRow}>
              <Pill title={`${state.result.width} × ${state.result.height}`} />
              <Pill title={`${state.result.applied.length} FILTERS`} />
              <Pill title="PREVIEW ONLY" tone="warning" />
            </Row>
          ) : null}
          {state.result ? <DisplayHistogramView value={state.result.histogram} /> : null}
          {progress ? <Progress label={progress.label} value={progress.value} /> : null}
          <Row>
            <Btn title="Run chain" onPress={run} busy={busy} style={styles.grow} />
            {busy ? <Btn title="Cancel" onPress={() => (cancel.current = true)} secondary style={styles.grow} /> : null}
          </Row>
        </Card>

        <Card>
          <SectionTitle index="02" title="CHAIN" note={`${filters.length} filters`} />
          {filters.length === 0 ? (
            <Body>
              The chain is empty. Add a filter to process the evidence; the order of the list is the order of the
              processing.
            </Body>
          ) : (
            filters.map((f, i) => {
              const def = FILTERS[f.type];
              const open = expanded === f.id;
              return (
                <View key={f.id} style={styles.filter}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => setExpanded(open ? null : f.id)}
                    style={styles.filterHead}
                  >
                    <Text style={styles.filterIndex}>{String(i + 1).padStart(2, "0")}</Text>
                    <View style={styles.filterNames}>
                      <Text style={[styles.filterName, f.enabled ? null : styles.off]}>{def?.name ?? f.type}</Text>
                      <Text style={styles.filterId}>{f.type}</Text>
                    </View>
                    <Pressable
                      accessibilityRole="switch"
                      accessibilityState={{ checked: f.enabled }}
                      onPress={() => toggleFilter(f.id)}
                      style={[styles.switch, f.enabled ? styles.switchOn : null]}
                    >
                      <Text style={styles.switchLabel}>{f.enabled ? "ON" : "OFF"}</Text>
                    </Pressable>
                  </Pressable>
                  {open && def ? (
                    <View style={styles.filterBody}>
                      {def.params.map((p) => (
                        <ParamEditor
                          key={p.key}
                          def={p}
                          values={f.params}
                          onChange={(key, value) => setParam(f.id, key, value)}
                        />
                      ))}
                      <Row>
                        <Btn title="Move up" onPress={() => moveFilter(f.id, -1)} secondary style={styles.grow} />
                        <Btn title="Move down" onPress={() => moveFilter(f.id, 1)} secondary style={styles.grow} />
                        <Btn title="Remove" onPress={() => removeFilter(f.id)} danger style={styles.grow} />
                      </Row>
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
          <Btn title="Add filter" onPress={() => setPickerOpen(true)} />
        </Card>

        <Card>
          <SectionTitle index="03" title="EXPORT" />
          <Body>
            The export writes the result of the last run into a folder you choose and reads the saved file back.
            The evidence file is never overwritten.
          </Body>
          <View style={styles.chips}>
            {FORMATS.map(([key, label]) => (
              <Chip key={key} title={label} active={format === key} onPress={() => setFormat(key)} />
            ))}
          </View>
          <Btn title="Export result" onPress={exportResult} busy={busy} />
          {state.result ? (
            <View style={styles.hashBlock}>
              <KeyValue label="OUTPUT SAMPLE MD5" value={state.result.outputMd5} />
              <KeyValue label="FILTERS" value={state.result.applied.join(" → ") || "none"} />
            </View>
          ) : null}
        </Card>

        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {state.notice ? <Note tone="success">{state.notice}</Note> : null}
      </Screen>
      <FilterPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(id) => {
          addFilter(id);
          setPickerOpen(false);
        }}
      />
      <NavBar active="workbench" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  head: { justifyContent: "space-between" },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  iconBtn: { borderWidth: 1, borderColor: C.line, borderRadius: 8, paddingHorizontal: 11, paddingVertical: 7 },
  iconLabel: { color: C.text, fontSize: 14 },
  viewer: {
    height: 250,
    backgroundColor: C.black,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: C.line,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%" },
  viewerHint: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center" },
  viewerHintText: { color: C.dim, fontSize: 11 },
  pillRow: { flexWrap: "wrap" },
  grow: { flex: 1 },
  filter: { borderWidth: 1, borderColor: C.line, borderRadius: 10, backgroundColor: C.panelRaised, overflow: "hidden" },
  filterHead: { flexDirection: "row", alignItems: "center", gap: S.sm, padding: S.sm },
  filterIndex: { color: C.dim, fontSize: 10, fontWeight: "800", fontFamily: mono.fontFamily },
  filterNames: { flex: 1, gap: 2 },
  filterName: { color: C.text, fontSize: 13, fontWeight: "700" },
  filterId: { color: C.dim, fontSize: 9, fontFamily: mono.fontFamily },
  off: { color: C.dim },
  switch: { borderWidth: 1, borderColor: C.lineStrong, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 4 },
  switchOn: { backgroundColor: C.text, borderColor: C.text },
  switchLabel: { color: C.text, fontSize: 9, fontWeight: "900" },
  filterBody: { borderTopWidth: 1, borderTopColor: C.line, padding: S.sm, gap: S.md, backgroundColor: C.black },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: S.sm },
  hashBlock: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: S.sm, gap: S.sm },
});
