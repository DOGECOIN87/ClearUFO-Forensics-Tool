// Assistant settings. API keys are kept apart from the other settings: by default only for this browser tab
// (sessionStorage), on this device (localStorage) only when the user asks to remember them.
import { providerInfo } from "./providers";
import type { AiConfig, ProviderId } from "./types";

export interface AiSettings {
  provider: ProviderId;
  /** Server address per provider (default: the provider's own). */
  baseUrls: Partial<Record<ProviderId, string>>;
  models: Partial<Record<ProviderId, string>>;
  /** Keep the API key on this device (otherwise: until the tab is closed). */
  remember: boolean;
  /** agent: may change the project; ask: read-only (answers and advice). */
  mode: "agent" | "ask";
  /** Changes to the project: applied directly (undoable) or after the user approves each one. */
  approval: "auto" | "ask";
  /** May the assistant see frames (sent to the provider)? */
  frames: "ask" | "allow" | "never";
  /** Tool steps per request before the assistant stops and reports. */
  maxSteps: number;
}

export const DEFAULT_AI: AiSettings = { provider: "openai", baseUrls: {}, models: {}, remember: false, mode: "agent", approval: "auto", frames: "ask", maxSteps: 40 };

const KEY = "lucid.ai.settings";
const keyName = (p: ProviderId) => `lucid.ai.key.${p}`;
const memKeys: Partial<Record<ProviderId, string>> = {};

export function loadAiSettings(): AiSettings {
  try {
    const s = { ...DEFAULT_AI, ...JSON.parse(localStorage.getItem(KEY) || "{}") } as AiSettings;
    s.baseUrls = { ...s.baseUrls }; s.models = { ...s.models };
    return s;
  } catch { return { ...DEFAULT_AI, baseUrls: {}, models: {} }; }
}

export function saveAiSettings(s: AiSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable (sandboxed page) */ }
}

export function getKey(p: ProviderId): string {
  if (memKeys[p]) return memKeys[p]!;
  try { return localStorage.getItem(keyName(p)) ?? sessionStorage.getItem(keyName(p)) ?? ""; } catch { return ""; }
}

export function setKey(p: ProviderId, key: string, remember: boolean) {
  memKeys[p] = key;
  try {
    localStorage.removeItem(keyName(p)); sessionStorage.removeItem(keyName(p));
    if (key) (remember ? localStorage : sessionStorage).setItem(keyName(p), key);
  } catch { /* kept in memory only */ }
}

/** Forget every stored key (Settings › Forget keys). */
export function forgetKeys() {
  for (const k of Object.keys(memKeys) as ProviderId[]) delete memKeys[k];
  try {
    for (const st of [localStorage, sessionStorage]) for (let i = st.length - 1; i >= 0; i--) { const k = st.key(i); if (k?.startsWith("lucid.ai.key.")) st.removeItem(k); }
  } catch { /* unavailable */ }
}

export function configOf(s: AiSettings): AiConfig {
  return { provider: s.provider, baseUrl: s.baseUrls[s.provider] || providerInfo(s.provider).baseUrl, apiKey: getKey(s.provider), model: s.models[s.provider] ?? "" };
}

/** What is missing before the assistant can be used, or null. */
export function configProblem(cfg: AiConfig): string | null {
  if (!cfg.baseUrl) return "Enter the server address";
  if (providerInfo(cfg.provider).needsKey && !cfg.apiKey) return "Enter your API key";
  if (!cfg.model) return "Choose a model";
  return null;
}
