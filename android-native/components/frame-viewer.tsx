import { useEffect, useRef, useState } from "react";
import { Image, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import type { Frame } from "@/lib/engine/frame";
import { imageBounds, imagePixel, pinchPan, type Viewport } from "@/lib/viewer/coordinates";
import { C, mono } from "@/lib/ui/theme";
import { Btn } from "@/components/clearufo";

type Touch = { locationX: number; locationY: number };
function center(touches: readonly Touch[]) {
  return { x: touches.reduce((s, p) => s + p.locationX, 0) / touches.length, y: touches.reduce((s, p) => s + p.locationY, 0) / touches.length };
}
function distance(t: readonly Touch[]) { return Math.hypot(t[0].locationX - t[1].locationX, t[0].locationY - t[1].locationY); }

type Gesture = { count: number; x: number; y: number; distance: number; viewport: Viewport };
export function FrameViewer({ uri, frame }: { uri: string; frame: Frame }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [sample, setSample] = useState<{ x: number; y: number } | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const viewport: Viewport = { ...size, imageWidth: frame.w, imageHeight: frame.h, ...transform };
  const current = useRef(viewport); current.current = viewport;
  useEffect(() => { setTransform({ zoom: 1, panX: 0, panY: 0 }); setSample(null); gesture.current = null; }, [uri, frame]);
  const start = (touches: readonly Touch[]) => {
    if (!touches.length) { gesture.current = null; return; }
    const c = center(touches.slice(0, 2));
    gesture.current = { count: touches.length, ...c, distance: touches.length >= 2 ? distance(touches) : 0, viewport: current.current };
  };
  const move = (e: GestureResponderEvent) => {
    const touches = e.nativeEvent.touches;
    if (!touches.length) return;
    const g = gesture.current;
    if (!g || (g.count >= 2) !== (touches.length >= 2)) { start(touches); return; }
    const c = center(touches.slice(0, 2));
    if (touches.length >= 2 && g.distance > 0) {
      const zoom = Math.max(1, Math.min(16, g.viewport.zoom * distance(touches) / g.distance));
      setTransform({ zoom, ...pinchPan(g.viewport, g.x, g.y, c.x, c.y, zoom) });
    } else {
      setTransform({ zoom: g.viewport.zoom, panX: g.viewport.panX + c.x - g.x, panY: g.viewport.panY + c.y - g.y });
      setSample(imagePixel(g.viewport, g.x, g.y));
    }
  };
  const bounds = size.width && size.height ? imageBounds(viewport) : null;
  const i = sample ? (sample.y * frame.w + sample.x) * 4 : 0;
  const rgb = sample ? Array.from(frame.d.slice(i, i + 3)) : null;
  const format = (n: number) => Number.isFinite(n) ? String(Number(n.toFixed(4))) : String(n);
  return <View style={{ gap: 8 }}>
    <View style={styles.viewport} onLayout={e => setSize(e.nativeEvent.layout)}
      onStartShouldSetResponder={() => true} onMoveShouldSetResponder={() => true}
      onResponderGrant={e => { start(e.nativeEvent.touches); const t = e.nativeEvent.touches[0]; if (t) setSample(imagePixel(current.current, t.locationX, t.locationY)); }}
      onResponderMove={move} onResponderRelease={() => { gesture.current = null; }} onResponderTerminate={() => { gesture.current = null; }}>
      {bounds ? <View pointerEvents="none" style={{ position: "absolute", left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}><Image source={{ uri }} resizeMode="stretch" style={{ width: "100%", height: "100%" }} /></View> : null}
    </View>
    <Text style={{ color: C.muted, fontSize: 11 }}>Drag to pan · pinch to zoom · touch to sample the last result</Text>
    <Text selectable style={[{ color: C.text, fontSize: 12 }, mono]}>{sample && rgb ? `(${sample.x}, ${sample.y})  R ${format(rgb[0])}  G ${format(rgb[1])}  B ${format(rgb[2])}\nBT.601 luma ${format(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])}` : "Touch the image for a sample"}</Text>
    <Text style={{ color: C.muted, fontSize: 11 }}>Processed float samples, nominal 0–255; not original file values.</Text>
    <Btn title={`Reset view (${transform.zoom.toFixed(1)}×)`} secondary onPress={() => setTransform({ zoom: 1, panX: 0, panY: 0 })} />
  </View>;
}
const styles = StyleSheet.create({ viewport: { height: 250, backgroundColor: C.black, borderRadius: 9, borderWidth: 1, borderColor: C.line, overflow: "hidden" } });
