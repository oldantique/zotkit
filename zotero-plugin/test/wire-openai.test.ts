import { describe, expect, it } from "vitest";
import { OpenAIWire } from "../src/wire-openai";
import type { WireEvent } from "../src/wire";

const wire = new OpenAIWire();

function sse(lines: string[]): string {
  return lines.map((line) => `data: ${line}\n\n`).join("");
}

function drain(chunks: string[]): WireEvent[] {
  const parser = wire.createParser();
  const events: WireEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

describe("OpenAIWire.buildRequest", () => {
  it("builds a chat-completions request with tools and bearer auth", () => {
    const request = wire.buildRequest(
      "https://api.deepseek.com/",
      "sk-test",
      [
        { role: "system", text: "sys" },
        { role: "user", text: "你好" },
        { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "zotero_page", argumentsJson: '{"page":3}' }] },
        { role: "tool", text: "page text", toolCallId: "c1" },
      ],
      [{ name: "zotero_page", description: "read page", inputSchema: { type: "object" } }],
      { model: "deepseek-chat", effort: null },
    );
    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(request.body);
    expect(body.model).toBe("deepseek-chat");
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.messages[2].tool_calls[0].function.name).toBe("zotero_page");
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "page text" });
    expect(body.tools[0].function.parameters).toEqual({ type: "object" });
  });

  it("includes reasoning_effort only when provided", () => {
    const request = wire.buildRequest("https://api.openai.com/v1", "k", [{ role: "user", text: "hi" }], [], {
      model: "gpt-5-mini", effort: "high",
    });
    expect(JSON.parse(request.body).reasoning_effort).toBe("high");
  });
});

describe("OpenAIWire parser", () => {
  it("streams text deltas split across chunks", () => {
    const payload = sse([
      '{"choices":[{"delta":{"content":"你"}}]}',
      '{"choices":[{"delta":{"content":"好"},"finish_reason":null}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      "[DONE]",
    ]);
    const middle = Math.floor(payload.length / 2);
    const events = drain([payload.slice(0, middle), payload.slice(middle)]);
    const text = events.filter((event) => event.type === "textDelta")
      .map((event) => (event as { delta: string }).delta).join("");
    expect(text).toBe("你好");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
  });

  it("assembles parallel tool calls from indexed deltas", () => {
    const events = drain([sse([
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c0","function":{"name":"a","arguments":"{\\"x\\":"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c1","function":{"name":"b","arguments":"{}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}',
      '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    ])]);
    const toolEvent = events.find((event) => event.type === "toolCalls") as { calls: unknown[] } | undefined;
    expect(toolEvent?.calls).toEqual([
      { id: "c0", name: "a", argumentsJson: '{"x":1}' },
      { id: "c1", name: "b", argumentsJson: "{}" },
    ]);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "toolCalls" });
  });

  it("surfaces provider error payloads and stops", () => {
    const events = drain([sse(['{"error":{"message":"Invalid model"}}'])]);
    expect(events[0]).toEqual({ type: "error", message: "Invalid model" });
  });
});
