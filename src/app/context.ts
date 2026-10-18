import type { WorkspaceHandle } from "@danfessler/trellis";
import type { ViewerPanel } from "../panels/ViewerPanel";
import type { Emitter } from "../ui/dom";
import type { Actions } from "./actions";
import type { AudioEngine } from "./audio";
import type { EngineClient } from "./engineClient";
import type { MediaElementFrames } from "./mtVideo";
import type { Player } from "./player";
import type { Store } from "./store";

export type BusEvents = { zoom: [number]; view: [null]; frameTable: [string]; focusSettings: []; layout: [string] };

/** A command of the application (menus, filters, panels…): the command palette and the assistant run them. */
export interface AppCommand {
  id: string;
  label: string;
  group: string;
  kind: "menu" | "filter" | "panel" | "player";
  shortcut?: string;
  disabled?: boolean;
  keywords?: string;
  run: () => void | Promise<void>;
}

export interface AppCtx {
  store: Store;
  engine: EngineClient;
  actions: Actions;
  bus: Emitter<BusEvents>;
  player: Player;
  audio: AudioEngine;
  mtVideo: MediaElementFrames;
  viewer(): ViewerPanel | null;
  ws(): WorkspaceHandle | null;
  openViewer(chainId?: string): void;
  newProject(): void;
  updateTitle(): void;
  applyTheme(): void;
  /** Re-evaluates the workspace layout (desktop or compact) after a resize or a preference change. */
  applyLayoutMode(): void;
  /** Every command of the application (menus, filters, panels, player). */
  commands(): AppCommand[];
  /** Show the AI Assistant panel and focus its input (optionally with text to complete). */
  focusAi(prefill?: string): void;
  /** MCP: servers used by the assistant, control by external AI applications (set up by the App). */
  mcp?: import("../mcp").Mcp;
}
