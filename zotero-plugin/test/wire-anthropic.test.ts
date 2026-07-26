import { describe, expect, it } from "vitest";
import { AnthropicWire } from "../src/wire-anthropic";
import type { WireEvent } from "../src/wire";

const wire = new AnthropicWire();

function drain(chunks: string[]): WireEvent[] {
  const parser = wire.createParser();
  const events: WireEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.end());
  return events;
}

describe("AnthropicWire.buildRequest", () => {
  it("builds a messages request with system, tools and merged tool results", () => {
    const request = wire.buildRequest(
      "https://api.anthropic.com",
      "sk-ant",
      [
        { role: "system", text: "sys" },
        { role: "user", text: "问" },
        { role: "assistant", text: "先查", toolCalls: [{ id: "t1", name: "zotero_page", argumentsJson: "{\"page\":2}" }] },
        { role: "tool", text: "第二页内容", toolCallId: "t1" },
      ],
      [{ name: "zotero_page", description: "read", inputSchema: { type: "object" } }],
      { model: "claude-sonnet-5", effort: null },
    );
    expect(request.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request.headers["x-api-key"]).toBe("sk-ant");
    expect(request.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(request.body);
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(8192);
    expect(body.tools[0].input_schema).toEqual({ type: "object" });
    expect(body.messages[1].content).toEqual([
      { type: "text", text: "先查" },
      { type: "tool_use", id: "t1", name: "zotero_page", input: { page: 2 } },
    ]);
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "第二页内容" }],
    });
  });

  it("maps effort onto a thinking budget and raises max_tokens above it", () => {
    const request = wire.buildRequest("https://api.kimi.example/anthropic", "k", [
      { role: "user", text: "q" },
    ], [], { model: "kimi-k2", effort: "high" });
    const body = JSON.parse(request.body);
    // Anthropic requires max_tokens > budget_tokens; the thinking budget
    // itself stays exactly the effort-mapped value (16384 for high) while
    // max_tokens becomes that budget plus the flat output reserve (8192).
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(body.max_tokens).toBe(24576);
  });

  it("skips an empty-text plain assistant message instead of emitting an empty text block", () => {
    const request = wire.buildRequest("https://api.anthropic.com", "sk-ant", [
      { role: "user", text: "问" },
      { role: "assistant", text: "" },
      { role: "user", text: "问二" },
    ], [], { model: "claude-sonnet-5", effort: null });
    const body = JSON.parse(request.body);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "问" }] },
      { role: "user", content: [{ type: "text", text: "问二" }] },
    ]);
  });
});

describe("AnthropicWire parser", () => {
  it("streams text deltas and stops on end_turn", () => {
    const events = drain([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ]);
    const text = events.filter((event) => event.type === "textDelta")
      .map((event) => (event as { delta: string }).delta).join("");
    expect(text).toBe("你好");
    expect(events.at(-1)).toEqual({ type: "stop", reason: "end" });
  });

  it("assembles a tool_use block from indexed json deltas", () => {
    const events = drain([
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t9","name":"zotero_page"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"page\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"5}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    ]);
    const toolEvent = events.find((event) => event.type === "toolCalls") as { calls: unknown[] } | undefined;
    expect(toolEvent?.calls).toEqual([{ id: "t9", name: "zotero_page", argumentsJson: "{\"page\":5}" }]);
    expect(events.at(-1)).toEqual({ type: "stop", reason: "toolCalls" });
  });

  it("surfaces error events", () => {
    const events = drain([
      'event: error\ndata: {"type":"error","error":{"message":"overloaded"}}\n\n',
    ]);
    expect(events[0]).toEqual({ type: "error", message: "overloaded" });
  });
});
