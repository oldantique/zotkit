import type {
  WireAdapter,
  WireEvent,
  WireMessage,
  WireParser,
  WireRequest,
  WireRequestParams,
  WireToolSpec,
} from "./wire";

/** OpenAI-compatible chat-completions wire (DeepSeek, Moonshot, OpenRouter, Ollama, OpenAI). */
export class OpenAIWire implements WireAdapter {
  buildRequest(
    baseUrl: string,
    apiKey: string,
    messages: WireMessage[],
    tools: WireToolSpec[],
    params: WireRequestParams,
  ): WireRequest {
    const body: Record<string, unknown> = {
      model: params.model,
      stream: true,
      messages: messages.map(toOpenAIMessage),
    };
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }));
    }
    if (params.effort) body.reasoning_effort = params.effort;
    return {
      url: `${baseUrl.replace(/\/+$/, "")}/chat/completions`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    };
  }

  createParser(): WireParser {
    return new OpenAIStreamParser();
  }
}

function toOpenAIMessage(message: WireMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.text || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId || "", content: message.text };
  }
  return { role: message.role, content: message.text };
}

class OpenAIStreamParser implements WireParser {
  private buffer = "";
  private stopped = false;
  private readonly toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>();

  push(chunk: string): WireEvent[] {
    this.buffer += chunk;
    const events: WireEvent[] = [];
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line, events);
    }
    return events;
  }

  end(): WireEvent[] {
    const events: WireEvent[] = [];
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.consumeLine(rest, events);
    if (!this.stopped) {
      this.stopped = true;
      this.flushStop(events, this.toolCalls.size ? "toolCalls" : "end");
    }
    return events;
  }

  private consumeLine(line: string, events: WireEvent[]): void {
    if (this.stopped || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      this.stopped = true;
      this.flushStop(events, this.toolCalls.size ? "toolCalls" : "end");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    }
    catch {
      this.stopped = true;
      events.push({ type: "error", message: "模型服务返回了无法解析的流式数据" });
      return;
    }
    const errorRecord = parsed.error as Record<string, unknown> | undefined;
    if (errorRecord) {
      this.stopped = true;
      events.push({
        type: "error",
        message: typeof errorRecord.message === "string" ? errorRecord.message : "模型服务返回错误",
      });
      return;
    }
    const choice = Array.isArray(parsed.choices)
      ? parsed.choices[0] as Record<string, unknown> | undefined
      : undefined;
    if (!choice) return;
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (typeof delta?.content === "string" && delta.content) {
      events.push({ type: "textDelta", delta: delta.content });
    }
    for (const raw of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
      const record = raw as Record<string, unknown>;
      const callIndex = typeof record.index === "number" ? record.index : 0;
      const current = this.toolCalls.get(callIndex) ?? { id: "", name: "", argumentsJson: "" };
      if (typeof record.id === "string" && record.id) current.id = record.id;
      const fn = record.function as Record<string, unknown> | undefined;
      if (typeof fn?.name === "string" && fn.name) current.name = fn.name;
      if (typeof fn?.arguments === "string") current.argumentsJson += fn.arguments;
      this.toolCalls.set(callIndex, current);
    }
    const finish = choice.finish_reason;
    if (finish === "tool_calls" || finish === "stop") {
      this.stopped = true;
      this.flushStop(events, finish === "tool_calls" ? "toolCalls" : "end");
    }
  }

  private flushStop(events: WireEvent[], reason: "end" | "toolCalls"): void {
    if (this.toolCalls.size) {
      const calls = [...this.toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([position, call]) => ({
          id: call.id || `call-${position}`,
          name: call.name,
          argumentsJson: call.argumentsJson || "{}",
        }));
      this.toolCalls.clear();
      events.push({ type: "toolCalls", calls });
      events.push({ type: "stop", reason: "toolCalls" });
      return;
    }
    events.push({ type: "stop", reason });
  }
}
