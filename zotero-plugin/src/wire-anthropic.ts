import type {
  WireAdapter,
  WireEvent,
  WireMessage,
  WireParser,
  WireRequest,
  WireRequestParams,
  WireToolSpec,
} from "./wire";

const THINKING_BUDGETS: Record<string, number> = { low: 4096, medium: 8192, high: 16384 };

/** Anthropic-compatible messages wire (Anthropic API, Kimi For Coding subscription endpoint). */
export class AnthropicWire implements WireAdapter {
  buildRequest(
    baseUrl: string,
    apiKey: string,
    messages: WireMessage[],
    tools: WireToolSpec[],
    params: WireRequestParams,
  ): WireRequest {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const url = trimmed.endsWith("/v1") ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
    const system = messages.find((message) => message.role === "system")?.text;
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: 8192,
      stream: true,
      messages: toAnthropicMessages(messages),
    };
    if (system) body.system = system;
    if (tools.length) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }
    const budget = params.effort ? THINKING_BUDGETS[params.effort] : undefined;
    if (budget) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      // Anthropic requires max_tokens > budget_tokens; add the output reserve
      // on top of the thinking budget instead of the flat default above.
      body.max_tokens = budget + 8192;
    }
    return {
      url,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    };
  }

  createParser(): WireParser {
    return new AnthropicStreamParser();
  }
}

function toAnthropicMessages(messages: WireMessage[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId || "",
        content: message.text,
      };
      const previous = output[output.length - 1];
      if (previous && previous.role === "user" && Array.isArray(previous.content)
        && (previous.content as Array<{ type?: string }>).every((item) => item.type === "tool_result")) {
        (previous.content as unknown[]).push(block);
      }
      else {
        output.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: unknown[] = [];
      if (message.text) content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        let input: unknown = {};
        try { input = JSON.parse(call.argumentsJson || "{}"); } catch { /* keep {} */ }
        content.push({ type: "tool_use", id: call.id, name: call.name, input });
      }
      output.push({ role: "assistant", content });
      continue;
    }
    // An interrupted-before-first-token turn can leave a synthesized empty
    // assistant message in history (see engine-client.ts's abort handling);
    // Anthropic rejects an assistant text block with no content, so drop it.
    if (message.role === "assistant" && !message.text) continue;
    output.push({ role: message.role, content: [{ type: "text", text: message.text }] });
  }
  return output;
}

class AnthropicStreamParser implements WireParser {
  private buffer = "";
  private stopped = false;
  private readonly toolBlocks = new Map<number, { id: string; name: string; argumentsJson: string }>();

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
      this.flushStop(events, this.toolBlocks.size ? "toolCalls" : "end");
    }
    return events;
  }

  private consumeLine(line: string, events: WireEvent[]): void {
    if (this.stopped || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    }
    catch {
      this.stopped = true;
      events.push({ type: "error", message: "模型服务返回了无法解析的流式数据" });
      return;
    }
    const type = parsed.type;
    if (type === "error") {
      const errorRecord = parsed.error as Record<string, unknown> | undefined;
      this.stopped = true;
      events.push({
        type: "error",
        message: typeof errorRecord?.message === "string" ? errorRecord.message : "模型服务返回错误",
      });
      return;
    }
    if (type === "content_block_start") {
      const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
      const block = parsed.content_block as Record<string, unknown> | undefined;
      if (block?.type === "tool_use") {
        this.toolBlocks.set(blockIndex, {
          id: typeof block.id === "string" ? block.id : `tool-${blockIndex}`,
          name: typeof block.name === "string" ? block.name : "",
          argumentsJson: "",
        });
      }
      return;
    }
    if (type === "content_block_delta") {
      const blockIndex = typeof parsed.index === "number" ? parsed.index : 0;
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        events.push({ type: "textDelta", delta: delta.text });
      }
      else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const block = this.toolBlocks.get(blockIndex);
        if (block) block.argumentsJson += delta.partial_json;
      }
      return;
    }
    if (type === "message_delta") {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      const stopReason = delta?.stop_reason;
      if (stopReason === "tool_use") {
        this.stopped = true;
        this.flushStop(events, "toolCalls");
      }
      else if (stopReason === "end_turn" || stopReason === "max_tokens") {
        this.stopped = true;
        this.flushStop(events, "end");
      }
    }
  }

  private flushStop(events: WireEvent[], reason: "end" | "toolCalls"): void {
    if (this.toolBlocks.size) {
      const calls = [...this.toolBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([position, block]) => ({
          id: block.id || `tool-${position}`,
          name: block.name,
          argumentsJson: block.argumentsJson || "{}",
        }));
      this.toolBlocks.clear();
      events.push({ type: "toolCalls", calls });
      events.push({ type: "stop", reason: "toolCalls" });
      return;
    }
    events.push({ type: "stop", reason });
  }
}
