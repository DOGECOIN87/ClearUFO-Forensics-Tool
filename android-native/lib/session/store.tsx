// The state of the app: the loaded evidence, the processing chain, the history and the undo stack.
//
// Everything lives in memory while the case is open; the case itself is written to the device with
// the project file (see lib/project/caseStore.ts). The evidence bytes are never modified: the
// source is decoded once and kept as it was read.
import { createContext, useCallback, useContext, useMemo, useReducer, type ReactNode } from "react";

import type { FilterInstance, ParamValues } from "@/lib/shared/types";
import { FILTERS, defaultParams } from "@/lib/shared/filters";
import type { VideoSession } from "./video";

export interface EvidenceState {
  /** Name of the file as it was picked. */
  name: string;
  /** Document URI of the original file (Android), kept for relinking. */
  uri?: string;
  /** The original bytes, exactly as they were read. */
  bytes: Uint8Array;
  md5: string;
  sha1: string;
  sha256: string;
  /** Format reported by the decoder (png, jpeg, bmp, tiff). */
  format: string;
  /** Decoder that produced the frame (part of the provenance). */
  decoder: string;
  /** Stored sample depth of the source. */
  depth: number;
  width: number;
  height: number;
  /** When the evidence was opened. */
  opened: string;
}

export interface HistoryEntry {
  time: string;
  title: string;
  detail: string;
  /** Hash of the produced output, when there was one. */
  outputHash?: string;
  kind: "source" | "process" | "export" | "case";
}

export interface ChainState {
  id: string;
  name: string;
  filters: FilterInstance[];
}

export interface SessionState {
  evidence: EvidenceState | null;
  /** The video that is open (the frame table and the decoder of the file). */
  video: VideoSession | null;
  chain: ChainState;
  /** The filter the examiner is editing (null = the whole chain). */
  selectedFilter: string | null;
  history: HistoryEntry[];
  /** The chain before the last change (for undo). */
  undoStack: ChainState[];
  redoStack: ChainState[];
  /** Output of the last render: preview file and provenance. */
  result: {
    previewUri: string | null;
    width: number;
    height: number;
    applied: string[];
    ms: number;
    outputMd5: string;
    at: string;
  } | null;
  error: string | null;
  notice: string | null;
}

export const CHAIN_ID = "chain-1";

const initialChain: ChainState = { id: CHAIN_ID, name: "Evidence", filters: [] };

export const initialState: SessionState = {
  evidence: null,
  video: null,
  chain: initialChain,
  selectedFilter: null,
  history: [],
  undoStack: [],
  redoStack: [],
  result: null,
  error: null,
  notice: null,
};

type Action =
  | { type: "evidence"; evidence: EvidenceState }
  | { type: "clearEvidence" }
  | { type: "video"; video: VideoSession | null }
  | { type: "chain"; chain: ChainState; undo?: boolean }
  | { type: "select"; id: string | null }
  | { type: "history"; entry: HistoryEntry }
  | { type: "result"; result: SessionState["result"] }
  | { type: "error"; message: string | null }
  | { type: "notice"; message: string | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case "evidence":
      return {
        ...state,
        evidence: action.evidence,
        chain: { ...initialChain, filters: [] },
        undoStack: [],
        redoStack: [],
        result: null,
        error: null,
        notice: null,
      };
    case "clearEvidence":
      return { ...state, evidence: null, chain: { ...initialChain, filters: [] }, result: null };
    case "video":
      return { ...state, video: action.video };
    case "chain":
      return {
        ...state,
        chain: action.chain,
        undoStack: action.undo === false ? state.undoStack : [...state.undoStack, state.chain].slice(-40),
        redoStack: action.undo === false ? state.redoStack : [],
        result: null,
      };
    case "select":
      return { ...state, selectedFilter: action.id };
    case "history":
      return { ...state, history: [action.entry, ...state.history].slice(0, 200) };
    case "result":
      return { ...state, result: action.result };
    case "error":
      return { ...state, error: action.message };
    case "notice":
      return { ...state, notice: action.message };
    case "undo": {
      const previous = state.undoStack[state.undoStack.length - 1];
      if (!previous) return state;
      return {
        ...state,
        chain: previous,
        undoStack: state.undoStack.slice(0, -1),
        redoStack: [...state.redoStack, state.chain].slice(-40),
        result: null,
      };
    }
    case "redo": {
      const next = state.redoStack[state.redoStack.length - 1];
      if (!next) return state;
      return {
        ...state,
        chain: next,
        undoStack: [...state.undoStack, state.chain].slice(-40),
        redoStack: state.redoStack.slice(0, -1),
        result: null,
      };
    }
    case "reset":
      return { ...initialState };
    default:
      return state;
  }
}

export interface SessionApi {
  state: SessionState;
  dispatch: React.Dispatch<Action>;
  setEvidence: (e: EvidenceState) => void;
  setVideo: (v: VideoSession | null) => void;
  setChain: (chain: ChainState, undo?: boolean) => void;
  addFilter: (type: string) => void;
  removeFilter: (id: string) => void;
  moveFilter: (id: string, delta: number) => void;
  toggleFilter: (id: string) => void;
  setParam: (id: string, key: string, value: unknown) => void;
  resetChain: () => void;
  undo: () => void;
  redo: () => void;
  log: (entry: Omit<HistoryEntry, "time">) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string | null) => void;
  setResult: (result: SessionState["result"]) => void;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const setChain = useCallback((chain: ChainState, undo = true) => dispatch({ type: "chain", chain, undo }), []);

  const api = useMemo<SessionApi>(() => {
    const withFilters = (filters: FilterInstance[]) => {
      const chain = { ...state.chain, filters };
      dispatch({ type: "chain", chain });
    };
    return {
      state,
      dispatch,
      setEvidence: (evidence) => dispatch({ type: "evidence", evidence }),
      setVideo: (video) => dispatch({ type: "video", video }),
      setChain,
      addFilter: (type: string) => {
        const def = FILTERS[type];
        if (!def) return;
        const filter: FilterInstance = {
          id: `f${Date.now().toString(36)}${Math.floor(Math.random() * 1000).toString(36)}`,
          type,
          enabled: true,
          params: defaultParams(def) as ParamValues,
        };
        withFilters([...state.chain.filters, filter]);
        dispatch({ type: "select", id: filter.id });
      },
      removeFilter: (id: string) => {
        withFilters(state.chain.filters.filter((f) => f.id !== id));
        if (state.selectedFilter === id) dispatch({ type: "select", id: null });
      },
      moveFilter: (id: string, delta: number) => {
        const list = [...state.chain.filters];
        const i = list.findIndex((f) => f.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        const [item] = list.splice(i, 1);
        list.splice(j, 0, item);
        withFilters(list);
      },
      toggleFilter: (id: string) => {
        withFilters(state.chain.filters.map((f) => (f.id === id ? { ...f, enabled: !f.enabled } : f)));
      },
      setParam: (id: string, key: string, value: unknown) => {
        withFilters(
          state.chain.filters.map((f) => (f.id === id ? { ...f, params: { ...f.params, [key]: value } } : f)),
        );
      },
      resetChain: () => {
        dispatch({ type: "chain", chain: { ...state.chain, filters: [] } });
        dispatch({ type: "select", id: null });
      },
      undo: () => dispatch({ type: "undo" }),
      redo: () => dispatch({ type: "redo" }),
      log: (entry) => dispatch({ type: "history", entry: { ...entry, time: new Date().toISOString() } }),
      setError: (message) => dispatch({ type: "error", message }),
      setNotice: (message) => dispatch({ type: "notice", message }),
      setResult: (result) => dispatch({ type: "result", result }),
    };
  }, [state, setChain]);

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside the SessionProvider");
  return ctx;
}
