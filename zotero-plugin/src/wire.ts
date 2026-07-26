export interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  text: string;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: WireToolCall[];
  /** Present on tool result messages. */
  toolCallId?: string;
}
export interface WireToolCall { id: string; name: string; argumentsJson: string; }
export interface WireToolSpec { name: string; description: string; inputSchema: Record<string, unknown>; }
export type WireEvent =
  | { type: "textDelta"; delta: string }
  | { type: "toolCalls"; calls: WireToolCall[] }
  | { type: "stop"; reason: "end" | "toolCalls" }
  | { type: "error"; message: string };
export interface WireRequest { url: string; headers: Record<string, string>; body: string; }
export interface WireRequestParams { model: string; effort: string | null; }
export interface WireParser { push(chunk: string): WireEvent[]; end(): WireEvent[]; }
export interface WireAdapter {
  buildRequest(
    baseUrl: string,
    apiKey: string,
    messages: WireMessage[],
    tools: WireToolSpec[],
    params: WireRequestParams,
  ): WireRequest;
  createParser(): WireParser;
}
