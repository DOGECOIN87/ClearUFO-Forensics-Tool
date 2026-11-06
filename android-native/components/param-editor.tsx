// The parameter controls of a filter. The controls are generated from the catalog of the browser
// workbench, so a filter that has a new parameter in the reference also has it here.
import { StyleSheet, Text, TextInput, View } from "react-native";

import { GeometryEditor } from "@/components/geometry-editor";
import { Body, Chip, NumberField, Segmented, Toggle } from "@/components/clearufo";
import type { ParamDef } from "@/lib/shared/filters";
import type { ParamValues } from "@/lib/shared/types";
import { C, S, mono } from "@/lib/ui/theme";

export function ParamEditor({
  def,
  values,
  onChange,
}: {
  def: ParamDef;
  values: ParamValues;
  onChange: (key: string, value: unknown) => void;
}) {
  switch (def.type) {
    case "number":
    case "int": {
      const value = Number(values[def.key] ?? def.default);
      return (
        <NumberField
          label={def.label}
          value={Number.isFinite(value) ? value : def.default}
          onChange={(v) => onChange(def.key, v)}
          min={def.min}
          max={def.max}
          step={def.step ?? (def.type === "int" ? 1 : 0.01)}
          decimals={def.decimals ?? 0}
          unit={def.unit}
        />
      );
    }
    case "select": {
      const value = String(values[def.key] ?? def.default);
      if (def.options.length <= 3) {
        return (
          <View style={styles.field}>
            <Text style={styles.label}>{def.label}</Text>
            <Segmented options={def.options} value={value} onChange={(v) => onChange(def.key, v)} />
          </View>
        );
      }
      return (
        <View style={styles.field}>
          <Text style={styles.label}>{def.label}</Text>
          <View style={styles.chips}>
            {def.options.map(([key, label]) => (
              <Chip key={key} title={label} active={value === key} onPress={() => onChange(def.key, key)} />
            ))}
          </View>
        </View>
      );
    }
    case "bool":
      return (
        <Toggle
          label={def.label}
          value={Boolean(values[def.key] ?? def.default)}
          onChange={(v) => onChange(def.key, v)}
        />
      );
    case "color":
      return (
        <View style={styles.field}>
          <Text style={styles.label}>{def.label}</Text>
          <TextInput
            value={String(values[def.key] ?? def.default)}
            onChangeText={(v) => onChange(def.key, v)}
            style={[styles.input, mono]}
            autoCapitalize="none"
            placeholderTextColor={C.dim}
          />
        </View>
      );
    case "text":
      return (
        <View style={styles.field}>
          <Text style={styles.label}>{def.label}</Text>
          <TextInput
            value={String(values[def.key] ?? def.default)}
            onChangeText={(v) => onChange(def.key, v)}
            multiline={def.multiline}
            style={[styles.input, def.multiline ? styles.inputMulti : null]}
            placeholderTextColor={C.dim}
          />
        </View>
      );
    case "frame": {
      const value = Number(values[def.key] ?? def.default);
      return (
        <NumberField
          label={def.label}
          value={Number.isFinite(value) ? value : def.default}
          onChange={(v) => onChange(def.key, Math.round(v))}
          min={0}
          max={def.allowLast ? 100000 : 100000}
          step={1}
          decimals={0}
        />
      );
    }
    case "action":
      return <Body>{def.label} is run from the viewer.</Body>;
    case "info":
    case "fileinfo":
      return <Body>{def.label} is shown in the provenance panel.</Body>;
    case "psf":
      return <Body>The point spread function is selected in the PSF panel of the browser workbench.</Body>;
    case "source":
      return <Body>The source of the chain is the evidence that is open in this session.</Body>;
    case "image":
      return <Body>Images are added from the viewer overlay of the browser workbench.</Body>;
    case "chain":
    case "chains":
      return <Body>Linked chains are configured in the project file of the case.</Body>;
    case "rect":
    case "point":
    case "points":
    case "line":
    case "curve":
      return <GeometryEditor def={def} value={values[def.key]} onChange={(value) => onChange(def.key, value)} />;
    default:
      return null;
  }
}

const styles = StyleSheet.create({
  field: { gap: 6 },
  label: { color: C.muted, fontSize: 11, fontWeight: "600" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: S.sm },
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
  inputMulti: { minHeight: 72, textAlignVertical: "top" },
});
