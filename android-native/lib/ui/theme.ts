// The visual language of the app: the graphite surfaces and the white accents of the ClearUFO
// workbench, adapted for a phone. Colour carries hierarchy and status, never decoration.

export const C = {
  background: "#080808",
  panel: "#121212",
  panelRaised: "#161616",
  panelHigh: "#1c1c1c",
  line: "#2e2e2e",
  lineStrong: "#3d3d3d",
  text: "#f2f2f2",
  muted: "#a5a5a5",
  dim: "#757575",
  success: "#3ad16b",
  warning: "#ffb020",
  error: "#ff5a5a",
  accent: "#f2f2f2",
  black: "#050505",
} as const;

export const S = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const T = {
  mono: "monospace",
} as const;

/** Monospaced text for hashes, coordinates and measurements. */
export const mono = { fontFamily: T.mono } as const;
