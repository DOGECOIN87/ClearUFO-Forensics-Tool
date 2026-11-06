import { useCallback, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { NavBar } from "@/components/nav-bar";
import { Body, Btn, Card, Chip, EmptyState, KeyValue, Note, Pill, Progress, Row, Screen, SectionTitle } from "@/components/clearufo";
import { decodeStill } from "@/lib/codecs/still";
import { pickImageEvidence } from "@/lib/project/evidenceIO";
import { hashBytes, registerEvidence } from "@/lib/session/workbench";
import { useSession } from "@/lib/session/store";
import { C, S, mono } from "@/lib/ui/theme";

export default function EvidenceScreen() {
  const { state, setEvidence, log, setError, setNotice } = useSession();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; value: number } | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);

  const openEvidence = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress({ label: "Reading the file", value: 0.05 });
    try {
      const picked = await pickImageEvidence();
      if (!picked) {
        setProgress(null);
        return;
      }
      setProgress({ label: "Hashing the original bytes", value: 0.35 });
      const hashes = hashBytes(picked.bytes);
      setProgress({ label: "Decoding on device", value: 0.7 });
      const decoded = decodeStill(picked.bytes);
      const evidence = {
        name: picked.name,
        uri: picked.uri,
        bytes: picked.bytes,
        ...hashes,
        format: decoded.format,
        decoder: decoded.engine,
        depth: decoded.depth,
        width: decoded.frame.w,
        height: decoded.frame.h,
        opened: new Date().toISOString(),
      };
      registerEvidence(evidence);
      setEvidence(evidence);
      setPreviewUri(null);
      setProgress({ label: "Preparing the preview", value: 0.95 });
      log({
        kind: "source",
        title: `Opened ${picked.name}`,
        detail: `${decoded.format.toUpperCase()} · ${decoded.frame.w} × ${decoded.frame.h} px · ${decoded.depth}-bit · decoded with ${decoded.engine}`,
        outputHash: hashes.md5,
      });
      setNotice("Source opened. The original bytes are kept for hashing; the file itself is never changed.");
      setProgress(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }, [log, setError, setEvidence, setNotice]);

  const evidence = state.evidence;

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View style={styles.topline}>
          <View>
            <Text style={styles.wordmark}>ClearUFO</Text>
            <Text style={styles.kicker}>FORENSIC WORKBENCH / ANDROID</Text>
          </View>
          <View style={styles.offlineBadge}>
            <View style={styles.offlineDot} />
            <Text style={styles.offlineText}>OFFLINE</Text>
          </View>
        </View>

        <Card>
          <SectionTitle index="01" title="SOURCE EVIDENCE" note={evidence ? evidence.format.toUpperCase() : undefined} />
          {evidence ? (
            <>
              <Text style={styles.filename} numberOfLines={2}>
                {evidence.name}
              </Text>
              <Text style={styles.meta}>
                {evidence.bytes.length.toLocaleString()} bytes · {evidence.width} × {evidence.height} px · {evidence.depth}-bit
              </Text>
              <Row style={styles.pillRow}>
                <Pill title="SOURCE UNCHANGED" tone="success" />
                <Pill title={evidence.decoder.toUpperCase()} />
              </Row>
              <View style={styles.hashBlock}>
                <KeyValue label="MD5" value={evidence.md5} />
                <KeyValue label="SHA-1" value={evidence.sha1} />
                <KeyValue label="SHA-256" value={evidence.sha256} />
              </View>
            </>
          ) : (
            <Body>
              Open a local image file. The app reads the bytes, hashes them and decodes the image on the device.
              The original file is never written to.
            </Body>
          )}
          <Btn title={evidence ? "Open another file" : "Open image evidence"} onPress={openEvidence} busy={busy} />
          {progress ? <Progress label={progress.label} value={progress.value} /> : null}
        </Card>

        <Card>
          <SectionTitle index="02" title="EVIDENCE VIEWER" />
          {evidence ? (
            <View style={styles.imageFrame}>
              <Image source={{ uri: previewUri ?? "" }} resizeMode="contain" style={styles.image} />
              <View style={styles.imageOverlay}>
                <Text style={[styles.overlayText, mono]}>
                  {evidence.width} × {evidence.height}
                </Text>
              </View>
            </View>
          ) : (
            <EmptyState title="No evidence loaded" copy="The viewer shows the local file only; nothing is uploaded." />
          )}
        </Card>

        {evidence ? (
          <Card>
            <SectionTitle index="03" title="WHAT HAPPENS NEXT" />
            <Body>
              Open the workbench to build the processing chain. Every filter runs on the device, the preview is
              generated from the decoded evidence and the export is written to a folder you choose.
            </Body>
            <Pressable
              accessibilityRole="button"
              onPress={() => setNotice("Use the Workbench tab to build the chain.")}
              style={styles.next}
            >
              <Text style={styles.nextLabel}>Workbench ›</Text>
            </Pressable>
          </Card>
        ) : null}

        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {state.notice ? <Note tone="success">{state.notice}</Note> : null}
      </Screen>
      <NavBar active="evidence" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  topline: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 4 },
  wordmark: { color: C.text, fontSize: 26, fontWeight: "900", letterSpacing: -1 },
  kicker: { color: C.muted, fontSize: 10, fontWeight: "700", letterSpacing: 1.4, marginTop: 2 },
  offlineBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  offlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.success },
  offlineText: { color: C.text, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  filename: { color: C.text, fontSize: 16, fontWeight: "700" },
  meta: { color: C.muted, fontSize: 11, lineHeight: 16 },
  pillRow: { flexWrap: "wrap" },
  hashBlock: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: S.sm, gap: S.sm },
  imageFrame: {
    height: 260,
    backgroundColor: C.black,
    borderRadius: 9,
    overflow: "hidden",
    borderColor: C.line,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  image: { width: "100%", height: "100%" },
  imageOverlay: { position: "absolute", left: 8, bottom: 8, backgroundColor: "#000000aa", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4 },
  overlayText: { color: C.muted, fontSize: 10 },
  next: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: S.sm },
  nextLabel: { color: C.text, fontSize: 13, fontWeight: "800" },
});
