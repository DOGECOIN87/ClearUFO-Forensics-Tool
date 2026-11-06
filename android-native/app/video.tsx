import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import { SafeAreaView } from "react-native-safe-area-context";
import { VideoView, useVideoPlayer } from "expo-video";

const C = {
  background: "#080808", panel: "#151515", raised: "#202020", line: "#3a3a3a",
  text: "#f2f2f2", muted: "#a5a5a5", dim: "#757575", accent: "#55d98a", warning: "#ffb020",
};

const formatTime = (seconds: number) => {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec}`;
};

function ControlButton({ title, onPress, disabled = false, selected = false }: { title: string; onPress: () => void; disabled?: boolean; selected?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.controlButton, selected && styles.selectedButton, disabled && styles.disabled, pressed && styles.pressed]}>
      <Text style={styles.controlText}>{title}</Text>
    </Pressable>
  );
}

export default function VideoTimelineScreen() {
  const router = useRouter();
  const [sourceUri, setSourceUri] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fps, setFps] = useState(30);
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const player = useVideoPlayer(sourceUri, (instance) => {
    instance.timeUpdateEventInterval = 0.1;
    instance.loop = false;
    instance.keepScreenOnWhilePlaying = true;
  });

  useEffect(() => {
    const timeSubscription = player.addListener("timeUpdate", ({ currentTime: nextTime }) => setCurrentTime(nextTime));
    const statusSubscription = player.addListener("statusChange", ({ status, error: playerError }) => {
      if (status === "readyToPlay") setDuration(player.duration || 0);
      if (status === "error") setError(playerError?.message || "The video could not be decoded on this device.");
    });
    const playingSubscription = player.addListener("playingChange", ({ isPlaying }) => setPlaying(isPlaying));
    return () => { timeSubscription.remove(); statusSubscription.remove(); playingSubscription.remove(); };
  }, [player]);

  const boundedDuration = Math.max(0, duration || player.duration || 0);
  const progress = boundedDuration > 0 ? Math.min(1, Math.max(0, currentTime / boundedDuration)) : 0;
  const inOutLabel = useMemo(() => {
    if (inPoint === null && outPoint === null) return "Full clip";
    return `${formatTime(inPoint ?? 0)} → ${formatTime(outPoint ?? boundedDuration)}`;
  }, [inPoint, outPoint, boundedDuration]);

  const chooseVideo = async () => {
    setError(null);
    const result = await DocumentPicker.getDocumentAsync({ type: ["video/*"], multiple: false, copyToCacheDirectory: true });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    setSourceUri(asset.uri);
    setFileName(asset.name || "video evidence");
    setCurrentTime(0); setDuration(0); setInPoint(null); setOutPoint(null);
  };

  const seekTo = (time: number) => {
    if (!boundedDuration) return;
    const min = inPoint ?? 0;
    const max = outPoint ?? boundedDuration;
    player.currentTime = Math.min(max, Math.max(min, time));
    setCurrentTime(player.currentTime);
  };
  const step = (direction: number) => { player.pause(); seekTo(currentTime + direction / fps); };
  const togglePlay = () => { if (playing) player.pause(); else player.play(); };
  const setMarker = (which: "in" | "out") => {
    if (which === "in") setInPoint(Math.min(currentTime, outPoint ?? boundedDuration));
    else setOutPoint(Math.max(currentTime, inPoint ?? 0));
  };
  const clearMarkers = () => { setInPoint(null); setOutPoint(null); };
  const changeSpeed = () => {
    const next = speed === 0.5 ? 1 : speed === 1 ? 2 : 0.5;
    setSpeed(next); player.playbackRate = next;
  };
  const seekFromTimeline = (event: { nativeEvent: { locationX: number } }, width: number) => {
    const fraction = Math.min(1, Math.max(0, event.nativeEvent.locationX / Math.max(1, width)));
    seekTo(fraction * boundedDuration);
  };

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <ControlButton title="‹ Evidence" onPress={() => router.back()} />
          <View style={styles.headerTitle}><Text style={styles.wordmark}>VIDEO / TIMELINE</Text><Text style={styles.kicker}>NATIVE PLAYER · OFFLINE</Text></View>
          <View style={styles.statusDot} />
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>VIDEO EVIDENCE</Text>
          <Text style={styles.body}>{fileName ? `${fileName} · local source` : "Open a local video file. Playback stays on-device; no upload or account is used."}</Text>
          <ControlButton title={fileName ? "Choose another video" : "Open video evidence"} onPress={chooseVideo} />
        </View>
        <View style={styles.viewer}>
          {sourceUri ? <VideoView player={player} style={styles.video} contentFit="contain" nativeControls={false} /> : <View style={styles.empty}><Text style={styles.emptyTitle}>No video loaded</Text><Text style={styles.dim}>Select a local file to start the timeline.</Text></View>}
        </View>
        <View style={styles.card}>
          <View style={styles.rowBetween}><Text style={styles.sectionTitle}>TRANSPORT</Text><Text style={styles.timecode}>{formatTime(currentTime)} / {formatTime(boundedDuration)}</Text></View>
          <View style={styles.transportRow}>
            <ControlButton title="|‹" onPress={() => seekTo(0)} disabled={!sourceUri} />
            <ControlButton title="−1f" onPress={() => step(-1)} disabled={!sourceUri} />
            <ControlButton title={playing ? "Pause" : "Play"} onPress={togglePlay} disabled={!sourceUri} selected={playing} />
            <ControlButton title="+1f" onPress={() => step(1)} disabled={!sourceUri} />
            <ControlButton title="›|" onPress={() => seekTo(boundedDuration)} disabled={!sourceUri} />
          </View>
          <Pressable style={styles.timeline} onLayout={(e) => { (e.currentTarget as unknown as { timelineWidth?: number }).timelineWidth = e.nativeEvent.layout.width; }} onPress={(e) => { const width = (e.currentTarget as unknown as { timelineWidth?: number }).timelineWidth || 1; seekFromTimeline(e, width); }}>
            <View style={styles.track}><View style={[styles.inRange, { left: `${((inPoint ?? 0) / Math.max(1, boundedDuration)) * 100}%`, right: `${100 - ((outPoint ?? boundedDuration) / Math.max(1, boundedDuration)) * 100}%` }]} /><View style={[styles.playhead, { left: `${progress * 100}%` }]} /></View>
          </Pressable>
          <View style={styles.rangeRow}><Text style={styles.dim}>IN {formatTime(inPoint ?? 0)}</Text><Text style={styles.rangeLabel}>{inOutLabel}</Text><Text style={styles.dim}>OUT {formatTime(outPoint ?? boundedDuration)}</Text></View>
          <View style={styles.transportRow}><ControlButton title="Set In" onPress={() => setMarker("in")} disabled={!sourceUri} /><ControlButton title="Set Out" onPress={() => setMarker("out")} disabled={!sourceUri} /><ControlButton title="Clear Range" onPress={clearMarkers} disabled={inPoint === null && outPoint === null} /><ControlButton title={`${speed}×`} onPress={changeSpeed} disabled={!sourceUri} /></View>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>FRAME NAVIGATION</Text>
          <View style={styles.rowBetween}><Text style={styles.body}>Frame step</Text><Text style={styles.timecode}>{Math.round(currentTime * fps)} · {fps} fps</Text></View>
          <View style={styles.transportRow}><ControlButton title="−10f" onPress={() => step(-10)} disabled={!sourceUri} /><ControlButton title="−1f" onPress={() => step(-1)} disabled={!sourceUri} /><ControlButton title="+1f" onPress={() => step(1)} disabled={!sourceUri} /><ControlButton title="+10f" onPress={() => step(10)} disabled={!sourceUri} /></View>
          <View style={styles.fpsRow}><Text style={styles.dim}>Assumed frame rate for stepping</Text><ControlButton title={`${fps} fps`} onPress={() => setFps(fps === 30 ? 25 : fps === 25 ? 60 : 30)} /></View>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.footnote}>Timeline controls are active for the selected local clip. Exact codec/frame-index conformance and lossless video export are the next native engine stage.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background }, content: { padding: 18, gap: 14, paddingBottom: 40 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, headerTitle: { alignItems: "center" },
  wordmark: { color: C.text, fontSize: 14, fontWeight: "900", letterSpacing: 1.3 }, kicker: { color: C.muted, fontSize: 9, letterSpacing: 1.1, marginTop: 3 }, statusDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: C.accent },
  card: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: 14, gap: 12 }, sectionTitle: { color: C.text, fontSize: 12, fontWeight: "900", letterSpacing: 1.1 }, body: { color: C.muted, fontSize: 13, lineHeight: 19 },
  viewer: { height: 245, backgroundColor: "#030303", borderColor: C.line, borderWidth: 1, borderRadius: 12, overflow: "hidden" }, video: { flex: 1 }, empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8 }, emptyTitle: { color: C.text, fontSize: 16, fontWeight: "800" }, dim: { color: C.dim, fontSize: 11 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }, timecode: { color: C.text, fontFamily: "monospace", fontSize: 11 }, transportRow: { flexDirection: "row", flexWrap: "wrap", gap: 7 }, controlButton: { minHeight: 42, borderRadius: 9, borderWidth: 1, borderColor: C.line, backgroundColor: C.raised, paddingHorizontal: 11, alignItems: "center", justifyContent: "center" }, selectedButton: { borderColor: C.accent, backgroundColor: "#173323" }, controlText: { color: C.text, fontSize: 12, fontWeight: "800" }, disabled: { opacity: 0.4 }, pressed: { opacity: 0.75 },
  timeline: { height: 32, justifyContent: "center" }, track: { height: 8, backgroundColor: "#3a3a3a", borderRadius: 4, position: "relative", overflow: "visible" }, inRange: { position: "absolute", top: 0, bottom: 0, backgroundColor: C.accent, borderRadius: 4 }, playhead: { position: "absolute", top: -6, width: 3, height: 20, backgroundColor: C.text, marginLeft: -1.5 }, rangeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 5 }, rangeLabel: { flex: 1, textAlign: "center", color: C.accent, fontSize: 10, fontWeight: "800" }, fpsRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, error: { color: "#ff5a5a", backgroundColor: "#241111", borderWidth: 1, borderColor: "#5b2828", borderRadius: 9, padding: 12, fontSize: 12, lineHeight: 18 }, footnote: { color: C.dim, fontSize: 10, lineHeight: 15, textAlign: "center", paddingHorizontal: 8 },
});
