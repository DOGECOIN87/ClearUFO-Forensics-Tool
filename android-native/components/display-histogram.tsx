import { Text, View } from 'react-native';
import Svg, { Polyline } from 'react-native-svg';
import type { DisplayHistogram } from '@/lib/engine/histogram';
import { C, mono } from '@/lib/ui/theme';

const channels = [ ['R', '#ff7777'], ['G', '#80d98a'], ['B', '#79aaff'], ['L', '#eeeeee'] ] as const;

export function DisplayHistogramView({ value }: { value: DisplayHistogram }) {
  let max = 1;
  for (let i = 0; i < 1024; i++) max = Math.max(max, value.hist[i]);
  return <View accessibilityLabel="Display histogram for red, green, blue and luma">
    <Text style={{ color: C.muted, marginBottom: 6 }}>8-bit display histogram · linear scale</Text>
    <Svg viewBox="0 0 255 80" width="100%" height={100} preserveAspectRatio="none">
      {channels.map(([name, color], c) => {
        const points = Array.from({ length: 256 }, (_, x) => `${x},${80 - 78 * value.hist[c * 256 + x] / max}`).join(' ');
        return <Polyline key={name} points={points} fill="none" stroke={color} strokeWidth={1} />;
      })}
    </Svg>
    <Text style={[{ color: C.muted, marginTop: 6 }, mono]}>R / G / B / L · any channel at 0: {value.low} · at 255: {value.high}</Text>
  </View>;
}
