import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { EvidenceVideoPreview } from "@/components/evidence-video-preview";
import { type EvidenceHashProgress } from "@/lib/engine/hash";
import { hashVideoEvidence, pickPngEvidence, pickVideoEvidence, savePngWithReadBack, writePreviewPng, type PickedPngEvidence, type PickedVideoEvidence } from "@/lib/project/evidenceIO";
import { runNegativeExport, verifyPngExport, type NegativeExport, type PipelineProgress } from "@/lib/engine/imagePipeline";

const C = {
  background: "#080808",
  panel: "#151515",
  panelRaised: "#1b1b1b",
  line: "#393939",
  text: "#f2f2f2",
  muted: "#a5a5a5",
  dim: "#757575",
  success: "#3ad16b",
  warning: "#ffb020",
  error: "#ff5a5a",
};

function SectionTitle({ index, title }: { index: string; title: string }) {
  return (
    <View style={styles.sectionTitleRow}>
      <Text style={styles.sectionIndex}>{index}</Text>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function HashLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.hashRow}>
      <Text style={styles.hashLabel}>{label}</Text>
      <Text selectable style={styles.hashValue}>{value}</Text>
    </View>
  );
}

function ActionButton({
  title,
  onPress,
  disabled,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary ? styles.secondaryButton : styles.primaryButton,
        pressed && !disabled ? styles.pressed : null,
        disabled ? styles.disabledButton : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryButtonText : null]}>{title}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const [evidence, setEvidence] = useState<PickedPngEvidence | null>(null);
  const [result, setResult] = useState<NegativeExport | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [savedUri, setSavedUri] = useState<string | null>(null);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [videoEvidence, setVideoEvidence] = useState<PickedVideoEvidence | null>(null);
  const [videoHashes, setVideoHashes] = useState<Awaited<ReturnType<typeof hashVideoEvidence>> | null>(null);
  const [videoHashProgress, setVideoHashProgress] = useState<EvidenceHashProgress | null>(null);
  const [videoHashing, setVideoHashing] = useState(false);
  const videoHashCancelled = useRef(false);
  const mediaBusy = busy || videoHashing;

  const chooseEvidence = async () => {
    setError(null);
    setNotice(null);
    try {
      const picked = await pickPngEvidence();
      if (!picked) return;
      setEvidence(picked);
      setResult(null);
      setPreviewUri(null);
      setSavedUri(null);
      setNotice("Source selected. Original file bytes are retained for hashing and are never overwritten.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const chooseVideo = async () => {
    if (mediaBusy) return;
    setError(null);
    setNotice(null);
    try {
      const picked = await pickVideoEvidence();
      if (!picked) return;
      setVideoEvidence(picked);
      setVideoHashes(null);
      setVideoHashProgress({ bytesRead: 0, totalBytes: picked.size });
      setVideoHashing(true);
      videoHashCancelled.current = false;
      const hashes = await hashVideoEvidence(
        picked.uri,
        picked.size,
        setVideoHashProgress,
        () => videoHashCancelled.current,
      );
      if (hashes.byteLength === 0) throw new Error("The selected video is empty.");
      setVideoEvidence({ ...picked, size: hashes.byteLength });
      setVideoHashes(hashes);
      setNotice("Original video bytes hashed locally. Playback is a platform-decoder review preview only; video frames are not yet forensically decoded or processed.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (videoHashCancelled.current || message.includes("hashing cancelled")) {
        setNotice("Video hashing cancelled. The source was not changed and no source hash is shown.");
      } else {
        setError(message);
      }
    } finally {
      videoHashCancelled.current = false;
      setVideoHashing(false);
      setVideoHashProgress(null);
    }
  };

  const processAndSave = async () => {
    if (!evidence || mediaBusy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress({ label: "Starting on-device processing", fraction: 0 });
    try {
      const output = await runNegativeExport(evidence.bytes, setProgress);
      const preview = await writePreviewPng(output.outputBytes);
      setPreviewUri(preview);
      setProgress({ label: "Choose a destination folder", fraction: 1 });
      const baseName = `${evidence.name.replace(/\.png$/i, "")}_clearufo-negative-16bit`;
      const saved = await savePngWithReadBack(baseName, output.outputBytes);
      if (!saved) {
        setNotice("Export cancelled. The source remains unchanged; the verified preview is still available in this session.");
        setResult(output);
        return;
      }
      setProgress({ label: "Verifying the saved file", fraction: 1 });
      const verification = verifyPngExport(saved.bytes, output.expectedSamples, output.samplesHash);
      if (!verification.ok) {
        throw new Error(`Saved-file verification failed: ${verification.message}`);
      }
      setResult(output);
      setSavedUri(saved.uri);
      setNotice("The saved 16-bit PNG was read back and verified. The original evidence file was not modified.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const imageUri = previewUri ?? evidence?.uri ?? null;
  const isProcessed = Boolean(previewUri);
  const statusColor = error ? C.error : result?.verifiedInMemory ? C.success : C.muted;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topline}>
          <View>
            <Text style={styles.wordmark}>ClearUFO</Text>
            <Text style={styles.kicker}>FORENSIC WORKBENCH / ANDROID</Text>
          </View>
          <View style={styles.offlineBadge}><View style={styles.offlineDot} /><Text style={styles.offlineText}>OFFLINE</Text></View>
        </View>

        <View style={styles.hero}>
          <Text style={styles.heroTitle}>Evidence first.</Text>
          <Text style={styles.heroCopy}>Review local image and video evidence. Verified processing is limited to the explicitly supported workflows below.</Text>
        </View>

        <View style={styles.card}>
          <SectionTitle index="01" title="SOURCE EVIDENCE" />
          {evidence ? (
            <>
              <Text style={styles.filename} numberOfLines={2}>{evidence.name}</Text>
              <Text style={styles.meta}>{evidence.bytes.length.toLocaleString()} bytes · PNG · original remains unchanged</Text>
              <View style={styles.hashBlock}>
                <HashLine label="MD5" value={result?.sourceHashes.md5 ?? "Computed during processing"} />
                <HashLine label="SHA-1" value={result?.sourceHashes.sha1 ?? "Computed during processing"} />
                <HashLine label="SHA-256" value={result?.sourceHashes.sha256 ?? "Computed during processing"} />
              </View>
            </>
          ) : (
            <Text style={styles.bodyCopy}>Choose a PNG from this device. The app hashes the original bytes and never edits the source file.</Text>
          )}
          <ActionButton title={evidence ? "Choose another PNG" : "Open PNG evidence"} onPress={chooseEvidence} disabled={mediaBusy} secondary />
        </View>

        <View style={styles.viewerCard}>
          <SectionTitle index="02" title={isProcessed ? "NEGATIVE PREVIEW" : "EVIDENCE VIEWER"} />
          {imageUri ? (
            <View style={styles.imageFrame}>
              <Image source={{ uri: imageUri }} resizeMode="contain" style={styles.image} />
            </View>
          ) : (
            <View style={styles.emptyViewer}>
              <View style={styles.targetOuter}><View style={styles.targetInner} /></View>
              <Text style={styles.emptyTitle}>No evidence loaded</Text>
              <Text style={styles.emptyCopy}>The viewer shows a local file preview only.</Text>
            </View>
          )}
          {result ? (
            <View style={styles.dimensionsRow}>
              <Text style={styles.meta}>{result.width} × {result.height} px · {result.sourceDepth}-bit source</Text>
              <Text style={[styles.verification, { color: statusColor }]}>PIXELS VERIFIED</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.card}>
          <SectionTitle index="03" title="VIDEO EVIDENCE · REVIEW PREVIEW" />
          {videoEvidence ? (
            <>
              <View style={styles.videoFrame}>
                <EvidenceVideoPreview key={videoEvidence.uri} uri={videoEvidence.uri} />
              </View>
              <Text style={styles.filename} numberOfLines={2}>{videoEvidence.name}</Text>
              <Text style={styles.meta}>
                {videoEvidence.size === null ? "Size not reported" : `${videoEvidence.size.toLocaleString()} bytes`}
                {videoEvidence.mimeType ? ` · ${videoEvidence.mimeType}` : " · video"} · source is read-only
              </Text>
              {videoHashes ? (
                <View style={styles.hashBlock}>
                  <HashLine label="SOURCE MD5 · ORIGINAL FILE BYTES" value={videoHashes.md5} />
                  <HashLine label="SOURCE SHA-1 · ORIGINAL FILE BYTES" value={videoHashes.sha1} />
                  <HashLine label="SOURCE SHA-256 · ORIGINAL FILE BYTES" value={videoHashes.sha256} />
                </View>
              ) : null}
              {videoHashing && videoHashProgress ? (
                <View style={styles.progressBox}>
                  <ActivityIndicator color={C.text} />
                  <View style={styles.progressTextBox}>
                    <Text style={styles.progressLabel}>
                      Hashing {videoHashProgress.bytesRead.toLocaleString()}
                      {videoHashProgress.totalBytes === null ? "" : ` / ${videoHashProgress.totalBytes.toLocaleString()}`} bytes
                    </Text>
                    <View style={styles.progressTrack}>
                      <View style={[styles.progressFill, { width: `${videoHashProgress.totalBytes ? Math.max(3, Math.min(100, (videoHashProgress.bytesRead / videoHashProgress.totalBytes) * 100)) : 3}%` }]} />
                    </View>
                  </View>
                </View>
              ) : null}
              <Text style={styles.videoWarning}>
                Playback uses Android’s platform decoder for review only. This build does not yet expose verified frame/PTS decoding, video filters, temporal analysis, or video export.
              </Text>
            </>
          ) : (
            <Text style={styles.bodyCopy}>Choose a local video. The file is hashed in bounded chunks and is not copied into app memory or uploaded.</Text>
          )}
          <ActionButton title={videoEvidence ? "Choose another video" : "Open local video"} onPress={chooseVideo} disabled={mediaBusy} secondary />
          {videoHashing ? (
            <ActionButton title="Cancel video hashing" onPress={() => { videoHashCancelled.current = true; }} disabled={false} secondary />
          ) : null}
        </View>

        <View style={styles.card}>
          <SectionTitle index="04" title="PROCESS & EXPORT · PNG ONLY" />
          <Text style={styles.bodyCopy}>Run the reference Negative formula on the device, export a 16-bit RGB PNG, then decode the saved file and compare every sample.</Text>
          {busy && progress ? (
            <View style={styles.progressBox}>
              <ActivityIndicator color={C.text} />
              <View style={styles.progressTextBox}>
                <Text style={styles.progressLabel}>{progress.label}</Text>
                <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${Math.max(3, Math.min(100, progress.fraction * 100))}%` }]} /></View>
              </View>
            </View>
          ) : null}
          <ActionButton title={busy ? "Processing on device…" : "Apply Negative · Save 16-bit PNG"} onPress={processAndSave} disabled={!evidence || mediaBusy} />
          {result ? (
            <View style={styles.resultBox}>
              <Text style={styles.resultLabel}>OUTPUT SAMPLE MD5</Text>
              <Text selectable style={styles.hashValue}>{result.samplesHash}</Text>
              <Text style={[styles.resultStatus, { color: savedUri ? C.success : C.warning }]}>
                {savedUri ? "Saved file read-back verified" : "In-memory export verified · not saved"}
              </Text>
            </View>
          ) : null}
          {savedUri ? <Text selectable style={styles.savedPath}>Saved locally: {savedUri}</Text> : null}
        </View>

        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        <Text style={styles.footnote}>Offline and local-only. Verified processing currently supports PNG Negative export; videos are hashable and viewable as a platform-decoded preview only. This is not yet feature parity with the original software.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  content: { paddingHorizontal: 18, paddingTop: 20, paddingBottom: 36, gap: 14 },
  topline: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 8 },
  wordmark: { color: C.text, fontSize: 27, fontWeight: "900", letterSpacing: -1.1 },
  kicker: { color: C.muted, fontSize: 10, fontWeight: "700", letterSpacing: 1.5, marginTop: 2 },
  offlineBadge: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: C.line, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 6 },
  offlineDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.success },
  offlineText: { color: C.text, fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  hero: { borderLeftWidth: 2, borderLeftColor: C.text, paddingLeft: 12, paddingVertical: 4, marginVertical: 2 },
  heroTitle: { color: C.text, fontSize: 21, fontWeight: "800", letterSpacing: -0.5 },
  heroCopy: { color: C.muted, fontSize: 13, lineHeight: 19, marginTop: 4, maxWidth: 320 },
  card: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 12 },
  viewerCard: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 12 },
  sectionTitleRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  sectionIndex: { color: C.dim, fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  sectionTitle: { color: C.text, fontSize: 12, fontWeight: "800", letterSpacing: 1.1 },
  filename: { color: C.text, fontSize: 16, fontWeight: "700" },
  meta: { color: C.muted, fontSize: 11, lineHeight: 16 },
  bodyCopy: { color: C.muted, fontSize: 13, lineHeight: 19 },
  hashBlock: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: 7, gap: 7 },
  hashRow: { gap: 4 },
  hashLabel: { color: C.dim, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  hashValue: { color: C.text, fontFamily: "monospace", fontSize: 10, lineHeight: 15 },
  button: { minHeight: 48, borderRadius: 10, alignItems: "center", justifyContent: "center", paddingHorizontal: 14, marginTop: 2 },
  primaryButton: { backgroundColor: C.text },
  secondaryButton: { backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.line },
  pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  disabledButton: { opacity: 0.42 },
  buttonText: { color: "#050505", fontSize: 13, fontWeight: "800", textAlign: "center" },
  secondaryButtonText: { color: C.text },
  imageFrame: { height: 265, backgroundColor: "#050505", borderRadius: 9, overflow: "hidden", borderColor: C.line, borderWidth: 1 },
  image: { width: "100%", height: "100%" },
  videoFrame: { height: 230, backgroundColor: "#050505", borderRadius: 9, overflow: "hidden", borderColor: C.line, borderWidth: 1 },
  videoWarning: { color: C.warning, fontSize: 11, lineHeight: 16 },
  emptyViewer: { height: 230, backgroundColor: "#0b0b0b", borderRadius: 9, borderColor: C.line, borderWidth: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  targetOuter: { width: 56, height: 56, borderColor: "#606060", borderWidth: 1, alignItems: "center", justifyContent: "center", transform: [{ rotate: "45deg" }] },
  targetInner: { width: 26, height: 26, borderColor: C.text, borderWidth: 1 },
  emptyTitle: { color: C.text, fontSize: 14, fontWeight: "700" },
  emptyCopy: { color: C.dim, fontSize: 11 },
  dimensionsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  verification: { fontSize: 9, fontWeight: "900", letterSpacing: 0.9 },
  progressBox: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, backgroundColor: C.panelRaised },
  progressTextBox: { flex: 1, gap: 7 },
  progressLabel: { color: C.text, fontSize: 12, fontWeight: "600" },
  progressTrack: { height: 4, backgroundColor: C.line, borderRadius: 4, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: C.text },
  resultBox: { padding: 11, backgroundColor: C.panelRaised, borderRadius: 9, gap: 5 },
  resultLabel: { color: C.dim, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  resultStatus: { fontSize: 11, fontWeight: "700", marginTop: 3 },
  savedPath: { color: C.dim, fontFamily: "monospace", fontSize: 9, lineHeight: 13 },
  error: { color: C.error, backgroundColor: "#241111", borderColor: "#5b2828", borderWidth: 1, borderRadius: 9, padding: 12, fontSize: 12, lineHeight: 18 },
  notice: { color: C.muted, fontSize: 11, lineHeight: 16, paddingHorizontal: 3 },
  footnote: { color: C.dim, fontSize: 10, lineHeight: 15, textAlign: "center", paddingHorizontal: 12, paddingTop: 4 },
});
