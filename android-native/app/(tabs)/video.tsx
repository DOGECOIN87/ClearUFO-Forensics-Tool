import { useCallback, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Body, Btn, Card, EmptyState, KeyValue, Note, Pill, Progress, Row, Screen, SectionTitle } from "@/components/clearufo";
import { NavBar } from "@/components/nav-bar";
import { pickVideoEvidence } from "@/lib/project/videoIO";
import { writePreviewPng } from "@/lib/project/evidenceIO";
import { useSession } from "@/lib/session/store";
import { openVideo } from "@/lib/session/video";
import { encodeFrame, runChain, sessionSource } from "@/lib/session/workbench";
import { C, S, mono } from "@/lib/ui/theme";

export default function VideoScreen() {
  const { state, setVideo, log, setError, setNotice } = useSession();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ label: string; value: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [processedUri, setProcessedUri] = useState<string | null>(null);

  const video = state.video;

  const open = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setProgress({ label: "Reading the video file", value: 0.2 });
    try {
      const picked = await pickVideoEvidence();
      if (!picked) {
        setProgress(null);
        return;
      }
      setProgress({ label: "Reading the frame table", value: 0.6 });
      const session = await openVideo(picked.name, picked.uri, picked.size);
      setVideo(session);
      setFrame(0);
      setPreviewUri(null);
      setProcessedUri(null);
      log({
        kind: "source",
        title: `Opened ${picked.name}`,
        detail: `${session.info.container ?? session.kind.toUpperCase()} · ${session.info.codec ?? "?"} · ${session.info.frameCount} frames · ${session.info.fps.toFixed(3)} fps`,
      });
      setNotice(
        session.decodable
          ? "The video is open. The frames are decoded on the device."
          : `The frame table of the video was read exactly (${session.info.frameCount} frames), but ${session.limitation}`,
      );
      setProgress(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }, [log, setError, setNotice, setVideo]);

  const showFrame = useCallback(
    async (index: number) => {
      if (!video) return;
      const i = Math.max(0, Math.min((video.info.frameCount || 1) - 1, index));
      setFrame(i);
      try {
        const f = await video.provider.getFrame(i);
        const file = encodeFrame(f, "png8");
        setPreviewUri(await writePreviewPng(file.bytes));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [setError, video],
  );

  const processFrame = useCallback(async () => {
    if (!video || busy) return;
    setBusy(true);
    setError(null);
    setProgress({ label: "Running the chain on the frame", value: 0.3 });
    try {
      const rendered = await runChain(state.chain, { onProgress: (label, value) => setProgress({ label, value }) }, sessionSource(state), frame);
      setProgress({ label: "Writing the preview", value: 0.95 });
      const file = encodeFrame(rendered.frame, "png8");
      setProcessedUri(await writePreviewPng(file.bytes));
      log({
        kind: "process",
        title: `Frame ${frame + 1} processed`,
        detail: rendered.applied.join(" → "),
      });
      setNotice(`Frame ${frame + 1} was processed on the device in ${rendered.ms} ms.`);
      setProgress(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }, [busy, frame, log, setError, setNotice, state]);

  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <Screen>
        <View>
          <Text style={styles.title}>VIDEO</Text>
          <Text style={styles.subtitle}>The frame table of the file is read on the device.</Text>
        </View>

        <Card>
          <SectionTitle index="01" title="SOURCE" />
          {video ? (
            <>
              <Text style={styles.filename} numberOfLines={2}>
                {video.name}
              </Text>
              <Row style={styles.pillRow}>
                <Pill title={(video.info.container ?? video.kind).toUpperCase()} />
                <Pill title={(video.info.codec ?? "?").toUpperCase()} />
                <Pill title={video.decodable ? "DECODED ON DEVICE" : "FRAME TABLE ONLY"} tone={video.decodable ? "success" : "warning"} />
              </Row>
              <View style={styles.hashBlock}>
                <KeyValue label="Frames" value={String(video.info.frameCount)} mono={false} />
                <KeyValue label="Frame rate" value={`${video.info.fps.toFixed(3)} fps`} mono={false} />
                <KeyValue label="Duration" value={`${video.info.duration.toFixed(3)} s`} mono={false} />
                <KeyValue label="Size" value={`${video.info.width} × ${video.info.height} px`} mono={false} />
                <KeyValue label="File size" value={video.size.toLocaleString() + " bytes"} mono={false} />
                <KeyValue label="Video tracks" value={String(video.info.videoStreams ?? 1)} mono={false} />
                <KeyValue label="Audio tracks" value={String(video.info.audioStreams ?? 0)} mono={false} />
                {video.info.metadata.map(([k, v]) => (
                  <KeyValue key={k} label={k} value={v} />
                ))}
              </View>
            </>
          ) : (
            <Body>
              Open an AVI or an MP4 file. The app reads the structure of the file with its own demuxer: the number
              of frames, their type, their size, their offset and their timestamp.
            </Body>
          )}
          <Btn title={video ? "Open another video" : "Open video file"} onPress={open} busy={busy} />
          {progress ? <Progress label={progress.label} value={progress.value} /> : null}
        </Card>

        {video ? (
          <Card>
            <SectionTitle index="02" title="FRAMES" note={`${frame + 1} / ${video.info.frameCount}`} />
            <Row>
              <Btn title="◀" onPress={() => showFrame(frame - 1)} secondary style={styles.grow} />
              <Btn title="▶" onPress={() => showFrame(frame + 1)} secondary style={styles.grow} />
            </Row>
            {previewUri ? (
              <View style={styles.viewer}>
                <Image source={{ uri: previewUri }} resizeMode="contain" style={styles.image} />
              </View>
            ) : (
              <EmptyState
                title="No frame shown"
                copy={video.decodable ? "Step to a frame to decode it." : "This file cannot be decoded on the device in this build."}
              />
            )}
            {video.table ? (
              <View style={styles.hashBlock}>
                <KeyValue label="Timestamp of the frame" value={`${(video.table.pts[frame] ?? 0).toFixed(3)} s`} />
                <KeyValue label="Size of the frame" value={`${(video.table.bytes[frame] ?? 0).toLocaleString()} bytes`} />
                <KeyValue label="Type" value={video.table.types[frame] === 1 ? "I (key frame)" : "P (predicted frame)"} mono={false} />
              </View>
            ) : null}
            {video.limitation ? <Note tone="warning">{video.limitation}</Note> : null}
          </Card>
        ) : null}

        {video && video.decodable ? (
          <Card>
            <SectionTitle index="03" title="PROCESS THE FRAME" />
            <Body>
              The chain of the workbench runs on the selected frame. The preview is only a preview: the video file is
              never changed.
            </Body>
            {processedUri ? (
              <View style={styles.viewer}>
                <Image source={{ uri: processedUri }} resizeMode="contain" style={styles.image} />
              </View>
            ) : null}
            <Btn title={`Process frame ${frame + 1}`} onPress={processFrame} busy={busy} />
          </Card>
        ) : null}

        {state.error ? <Note tone="error">{state.error}</Note> : null}
        {state.notice ? <Note tone="success">{state.notice}</Note> : null}
      </Screen>
      <NavBar active="video" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  title: { color: C.text, fontSize: 20, fontWeight: "900", letterSpacing: -0.4 },
  subtitle: { color: C.muted, fontSize: 11, marginTop: 2 },
  filename: { color: C.text, fontSize: 15, fontWeight: "700" },
  pillRow: { flexWrap: "wrap" },
  hashBlock: { borderTopWidth: 1, borderTopColor: C.line, paddingTop: S.sm, gap: S.sm },
  grow: { flex: 1 },
  viewer: { height: 220, backgroundColor: C.black, borderRadius: 9, borderWidth: 1, borderColor: C.line, overflow: "hidden" },
  image: { width: "100%", height: "100%" },
});
