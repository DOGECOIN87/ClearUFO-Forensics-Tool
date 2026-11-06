// The native building blocks of the workbench screens: panels, rows, buttons, chips and the
// readouts for hashes and measurements. Everything is a plain React Native view, so the app runs
// without a WebView and without any platform service that could reach the network.
import { useState as useStateText, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";

import { C, S, mono } from "@/lib/ui/theme";

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionTitle({ index, title, note }: { index?: string; title: string; note?: string }) {
  return (
    <View style={styles.sectionRow}>
      {index ? <Text style={styles.sectionIndex}>{index}</Text> : null}
      <Text style={styles.sectionTitle}>{title}</Text>
      {note ? <Text style={styles.sectionNote}>{note}</Text> : null}
    </View>
  );
}

export function Btn({
  title,
  onPress,
  disabled,
  secondary,
  danger,
  busy,
  style,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
  danger?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const tone = danger ? styles.buttonDanger : secondary ? styles.buttonSecondary : styles.buttonPrimary;
  const label = danger ? styles.buttonTextDanger : secondary ? styles.buttonTextSecondary : styles.buttonText;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        tone,
        pressed && !disabled ? styles.pressed : null,
        disabled || busy ? styles.disabled : null,
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={secondary ? C.text : C.black} /> : null}
      <Text style={[styles.buttonLabel, label]}>{title}</Text>
    </Pressable>
  );
}

export function Chip({
  title,
  onPress,
  active,
  tone,
}: {
  title: string;
  onPress: () => void;
  active?: boolean;
  tone?: "default" | "success" | "warning" | "error";
}) {
  const color =
    tone === "success" ? C.success : tone === "warning" ? C.warning : tone === "error" ? C.error : C.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: Boolean(active) }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active ? styles.chipActive : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.chipLabel, { color: active ? C.black : color }]}>{title}</Text>
    </Pressable>
  );
}

export function Pill({ title, tone = "default" }: { title: string; tone?: "default" | "success" | "warning" | "error" }) {
  const color =
    tone === "success" ? C.success : tone === "warning" ? C.warning : tone === "error" ? C.error : C.muted;
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillLabel, { color }]}>{title}</Text>
    </View>
  );
}

export function KeyValue({ label, value, mono: useMono = true, tone }: { label: string; value: string; mono?: boolean; tone?: "success" | "warning" | "error" }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text selectable style={[styles.kvValue, useMono ? mono : null, tone ? { color: tone === "success" ? C.success : tone === "warning" ? C.warning : C.error } : null]}>
        {value}
      </Text>
    </View>
  );
}

export function Progress({ label, value, tone = "default" }: { label: string; value: number; tone?: "default" | "success" | "warning" | "error" }) {
  const color = tone === "success" ? C.success : tone === "warning" ? C.warning : tone === "error" ? C.error : C.text;
  return (
    <View style={styles.progress}>
      <View style={styles.progressHead}>
        <Text style={styles.progressLabel}>{label}</Text>
        <Text style={[styles.progressValue, mono]}>{Math.round(Math.max(0, Math.min(1, value)) * 100)}%</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${Math.max(2, Math.min(100, value * 100))}%`, backgroundColor: color }]} />
      </View>
    </View>
  );
}

export function EmptyState({ title, copy }: { title: string; copy: string }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyMark}>
        <View style={styles.emptyMarkInner} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{copy}</Text>
    </View>
  );
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "success" | "warning" | "error" }) {
  const color = tone === "success" ? C.success : tone === "warning" ? C.warning : tone === "error" ? C.error : C.muted;
  return (
    <View style={[styles.note, { borderLeftColor: color }]}>
      <Text style={[styles.noteText, { color }]}>{children}</Text>
    </View>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.segmented}>
      {options.map(([key, label]) => (
        <Pressable
          key={key}
          accessibilityRole="button"
          accessibilityState={{ selected: value === key }}
          onPress={() => onChange(key)}
          style={[styles.segment, value === key ? styles.segmentActive : null]}
        >
          <Text style={[styles.segmentLabel, value === key ? styles.segmentLabelActive : null]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: C.lineStrong, true: C.text }}
        thumbColor={value ? C.black : C.muted}
      />
    </View>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  decimals = 0,
  unit,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  unit?: string;
}) {
  const [text, setText] = useStateText(String(value));
  const commit = (raw: string) => {
    const n = Number(raw.replace(",", "."));
    if (!Number.isFinite(n)) return;
    onChange(Math.max(min, Math.min(max, n)));
  };
  return (
    <View style={styles.field}>
      <View style={styles.fieldHead}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <Text style={[styles.fieldValue, mono]}>
          {value.toFixed(decimals)}
          {unit ? ` ${unit}` : ""}
        </Text>
      </View>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          commit(t);
        }}
        onBlur={() => setText(String(value))}
        keyboardType="numbers-and-punctuation"
        style={[styles.input, mono]}
        placeholderTextColor={C.dim}
      />
      <View style={styles.sliderRow}>
        <Text style={[styles.sliderBound, mono]}>{min}</Text>
        <SliderInput value={value} min={min} max={max} step={step} onChange={onChange} />
        <Text style={[styles.sliderBound, mono]}>{max}</Text>
      </View>
    </View>
  );
}

/** A minimal slider built from pressable segments (no native slider needed, works everywhere). */
function SliderInput({
  value,
  min,
  max,
  step,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  const ratio = max === min ? 0 : (value - min) / (max - min);
  return (
    <View style={styles.sliderTrack}>
      <View style={[styles.sliderFill, { width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }]} />
      <Pressable
        accessibilityRole="adjustable"
        accessibilityValue={{ min, max, now: value }}
        onPress={() => undefined}
        style={[styles.sliderKnob, { left: `${Math.max(0, Math.min(1, ratio)) * 100}%` }]}
      />
      <View style={styles.sliderSteps}>
        {Array.from({ length: 11 }, (_, i) => (
          <Pressable
            key={i}
            accessibilityRole="button"
            accessibilityLabel={`Set ${labelOf(min, max, step, i)}`}
            onPress={() => onChange(labelOf(min, max, step, i))}
            style={styles.sliderStep}
          />
        ))}
      </View>
    </View>
  );
}

const labelOf = (min: number, max: number, step: number, i: number) => {
  const v = min + ((max - min) * i) / 10;
  return Math.round(v / step) * step;
};

export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

export function Body({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.body, style]}>{children}</Text>;
}

export function Mono({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return (
    <Text selectable style={[styles.body, mono, style]}>
      {children}
    </Text>
  );
}

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  if (!scroll) return <View style={styles.screen}>{children}</View>;
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.screenContent}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.background },
  screenContent: { padding: S.lg, paddingBottom: 120, gap: S.md },
  card: { backgroundColor: C.panel, borderColor: C.line, borderWidth: 1, borderRadius: 14, padding: S.md, gap: S.md },
  sectionRow: { flexDirection: "row", alignItems: "center", gap: S.sm },
  sectionIndex: { color: C.dim, fontSize: 11, fontWeight: "800", letterSpacing: 1.1 },
  sectionTitle: { color: C.text, fontSize: 12, fontWeight: "800", letterSpacing: 1.1, flexShrink: 1 },
  sectionNote: { color: C.dim, fontSize: 10, marginLeft: "auto" },
  button: {
    minHeight: 46,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: S.sm,
    paddingHorizontal: S.md,
  },
  buttonPrimary: { backgroundColor: C.text },
  buttonSecondary: { backgroundColor: C.panelRaised, borderWidth: 1, borderColor: C.lineStrong },
  buttonDanger: { backgroundColor: "#2a1414", borderWidth: 1, borderColor: "#5b2828" },
  buttonLabel: { fontSize: 13, fontWeight: "800" },
  buttonText: { color: C.black },
  buttonTextSecondary: { color: C.text },
  buttonTextDanger: { color: C.error },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
  chip: {
    borderWidth: 1,
    borderColor: C.lineStrong,
    borderRadius: 999,
    paddingHorizontal: 11,
    paddingVertical: 7,
    backgroundColor: C.panelRaised,
  },
  chipActive: { backgroundColor: C.text, borderColor: C.text },
  chipLabel: { fontSize: 11, fontWeight: "700" },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  pillLabel: { fontSize: 9, fontWeight: "900", letterSpacing: 0.8 },
  kv: { gap: 3 },
  kvLabel: { color: C.dim, fontSize: 9, fontWeight: "800", letterSpacing: 1 },
  kvValue: { color: C.text, fontSize: 11, lineHeight: 16 },
  progress: { gap: 6 },
  progressHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  progressLabel: { color: C.text, fontSize: 12, fontWeight: "600" },
  progressValue: { color: C.muted, fontSize: 11 },
  progressTrack: { height: 4, backgroundColor: C.line, borderRadius: 3, overflow: "hidden" },
  progressFill: { height: "100%", backgroundColor: C.text },
  empty: { alignItems: "center", justifyContent: "center", gap: S.sm, paddingVertical: S.xl },
  emptyMark: { width: 52, height: 52, borderWidth: 1, borderColor: C.lineStrong, alignItems: "center", justifyContent: "center", transform: [{ rotate: "45deg" }] },
  emptyMarkInner: { width: 24, height: 24, borderWidth: 1, borderColor: C.muted },
  emptyTitle: { color: C.text, fontSize: 14, fontWeight: "700" },
  emptyCopy: { color: C.dim, fontSize: 11, textAlign: "center", maxWidth: 260 },
  note: { borderLeftWidth: 2, paddingLeft: S.sm, paddingVertical: 2 },
  noteText: { fontSize: 11, lineHeight: 16 },
  segmented: { flexDirection: "row", borderWidth: 1, borderColor: C.line, borderRadius: 9, overflow: "hidden" },
  segment: { flex: 1, paddingVertical: 9, alignItems: "center", backgroundColor: C.panelRaised },
  segmentActive: { backgroundColor: C.text },
  segmentLabel: { color: C.muted, fontSize: 11, fontWeight: "700" },
  segmentLabelActive: { color: C.black },
  toggleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: S.md },
  toggleLabel: { color: C.text, fontSize: 12, flex: 1 },
  field: { gap: 6 },
  fieldHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  fieldLabel: { color: C.muted, fontSize: 11, fontWeight: "600" },
  fieldValue: { color: C.text, fontSize: 11 },
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
  sliderRow: { flexDirection: "row", alignItems: "center", gap: S.sm },
  sliderBound: { color: C.dim, fontSize: 9, width: 34 },
  sliderTrack: { flex: 1, height: 22, justifyContent: "center" },
  sliderFill: { position: "absolute", height: 3, backgroundColor: C.text, borderRadius: 2, left: 0 },
  sliderKnob: { position: "absolute", width: 14, height: 14, borderRadius: 7, backgroundColor: C.text, marginLeft: -7 },
  sliderSteps: { flexDirection: "row", justifyContent: "space-between", position: "absolute", left: 0, right: 0, height: 22, alignItems: "center" },
  sliderStep: { width: 22, height: 22 },
  row: { flexDirection: "row", alignItems: "center", gap: S.sm },
  body: { color: C.muted, fontSize: 12, lineHeight: 18 },
});
