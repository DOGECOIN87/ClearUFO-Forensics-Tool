// Provider-neutral model of an assistant conversation. Adapters (providers.ts) translate it to the
// OpenAI Chat Completions and Anthropic Messages wire formats.

export type ProviderId = "openai" | "anthropic" | "gemini" | "openrouter" | "ollama" | "lmstudio" | "custom";

export interface AiConfig { provider: ProviderId; baseUrl: string; apiKey: string; model: string }

/** An image for a multimodal model (base64, no data: prefix). */
export interface ImagePart { mime: string; data: string }

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, any>;
  /** The raw argument text when it was not a JSON object (reported back to the model as an error). */
  badArgs?: string;
}

export interface Msg {
  role: "user" | "assistant" | "tool";
  text?: string;
  images?: ImagePart[];
  /** assistant: tools the model asked for */
  toolCalls?: ToolCall[];
  /** tool: the call this message answers */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/** JSON-schema description of a tool, as sent to the model. */
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ChatRequest {
  system: string;
  messages: Msg[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Streaming text as it arrives. */
  onText?: (delta: string) => void;
}

export interface ChatResult { text: string; toolCalls: ToolCall[]; stop: string }
