// The catalogue of the filters: the examiner searches the filters of the browser workbench and adds
// one to the chain. The list is the catalog of the reference (85 filters in 17 categories), with the
// filters that this build can execute marked.
import { useMemo, useState } from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { Btn, Chip } from "@/components/clearufo";
import { IMPLEMENTED_IDS } from "@/lib/engine/filters/registry";
import { CATEGORIES, FILTER_LIST, type FilterDef } from "@/lib/shared/filters";
import { C, S, mono } from "@/lib/ui/theme";

export function FilterPicker({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);

  const implemented = useMemo(() => new Set(IMPLEMENTED_IDS), []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return FILTER_LIST.filter((f) => {
      if (category && f.category !== category) return false;
      if (!q) return true;
      return (
        f.name.toLowerCase().includes(q) ||
        f.id.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} transparent>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>ADD FILTER</Text>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
              <Text style={styles.closeLabel}>Close</Text>
            </Pressable>
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search the filters"
            placeholderTextColor={C.dim}
            style={[styles.search, mono]}
            autoCapitalize="none"
          />
          <View style={styles.categories}>
            <Chip title="All" active={category === null} onPress={() => setCategory(null)} />
            {CATEGORIES.map((c) => (
              <Chip key={c.name} title={c.name} active={category === c.name} onPress={() => setCategory(c.name)} />
            ))}
          </View>
          <FlatList
            data={list}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            renderItem={({ item }) => <FilterRow def={item} enabled={implemented.has(item.id)} onPick={onPick} />}
          />
        </View>
      </View>
    </Modal>
  );
}

function FilterRow({ def, enabled, onPick }: { def: FilterDef; enabled: boolean; onPick: (id: string) => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={!enabled}
      onPress={() => onPick(def.id)}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null, enabled ? null : styles.off]}
    >
      <View style={styles.rowHead}>
        <Text style={styles.name}>{def.name}</Text>
        <Text style={styles.id}>{def.id}</Text>
      </View>
      <Text style={styles.description} numberOfLines={2}>
        {def.description}
      </Text>
      {!enabled ? <Text style={styles.missing}>Not executable in this build</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "#000000cc", justifyContent: "flex-end" },
  sheet: { backgroundColor: C.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: S.lg, maxHeight: "88%", gap: S.sm },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { color: C.text, fontSize: 12, fontWeight: "800", letterSpacing: 1.2 },
  close: { paddingHorizontal: S.sm, paddingVertical: 4 },
  closeLabel: { color: C.muted, fontSize: 12 },
  search: {
    backgroundColor: C.black,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: 8,
    color: C.text,
    paddingHorizontal: 10,
    paddingVertical: 9,
    fontSize: 12,
  },
  categories: { flexDirection: "row", flexWrap: "wrap", gap: S.sm, paddingBottom: S.xs },
  list: { flexGrow: 0 },
  row: { paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line, gap: 3 },
  pressed: { opacity: 0.7 },
  off: { opacity: 0.45 },
  rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: S.sm },
  name: { color: C.text, fontSize: 13, fontWeight: "700" },
  id: { color: C.dim, fontSize: 9, fontFamily: mono.fontFamily },
  description: { color: C.muted, fontSize: 11, lineHeight: 15 },
  missing: { color: C.warning, fontSize: 10 },
});
