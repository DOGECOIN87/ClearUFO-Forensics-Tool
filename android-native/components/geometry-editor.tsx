import { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import { Btn } from '@/components/clearufo';
import { parseGeometry, type GeometryParam } from '@/lib/viewer/geometry';
import { C, mono } from '@/lib/ui/theme';

const examples: Record<GeometryParam['type'], string> = {
  point: '{"x":20,"y":20}', rect: '{"x":10,"y":10,"w":50,"h":30}',
  line: '[{"x":10,"y":10},{"x":50,"y":30}]',
  points: '[{"x":10,"y":10},{"x":50,"y":30}]',
  curve: '[{"x":0,"y":0},{"x":255,"y":255}]',
};

export function GeometryEditor({ def, value, onChange }: { def: GeometryParam; value: unknown; onChange: (value: unknown) => void }) {
  const serialized = JSON.stringify(value === undefined ? def.default : value);
  const [text, setText] = useState(serialized);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(serialized); setError(null); }, [serialized]);
  return <View style={{ gap: 6 }}>
    <Text style={{ color: C.muted, fontSize: 11, fontWeight: '600' }}>{def.label} · {def.type === 'curve' ? 'curve coordinates' : 'image coordinates (pixels)'}</Text>
    <TextInput value={text} onChangeText={setText} multiline autoCorrect={false} autoCapitalize="none"
      accessibilityLabel={`${def.label} geometry JSON`}
      style={[{ color: C.text, backgroundColor: C.black, borderColor: C.line, borderWidth: 1, borderRadius: 8, padding: 10, minHeight: 50, textAlignVertical: 'top' }, mono]} />
    <Text style={{ color: C.muted, fontSize: 11 }}>Example: {examples[def.type]}</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: C.error }}>{error}</Text> : null}
    <Btn title="Apply geometry" secondary onPress={() => {
      const parsed = parseGeometry(def, text);
      if (parsed.error) { setError(parsed.error); return; }
      setError(null); onChange(parsed.value);
    }} />
  </View>;
}
