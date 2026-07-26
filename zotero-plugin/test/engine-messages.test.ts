import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_WINDOW,
  OUTPUT_TOKEN_RESERVE,
  buildTurnMessages,
  engineModelId,
  estimateTokens,
  resolveEngineModel,
} from "../src/engine-messages";
import type { ProviderProfile } from "../src/providers";

const providers: ProviderProfile[] = [{
  id: "p1",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [
    { id: "deepseek-chat", label: "Chat" },
    { id: "deepseek-reasoner", label: "Reasoner" },
  ],
  defaultModel: "deepseek-chat",
}];

describe("estimateTokens", () => {
  it("uses ceil(chars / 3)", () => {
    expect(estimateTokens("abcd")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("buildTurnMessages", () => {
  it("orders system, kept history, then context-wrapped user text", () => {
    const messages = buildTurnMessages({
      developerInstructions: "You are the research assistant.",
      history: [
        { role: "user", text: "第一问" },
        { role: "assistant", text: "第一答" },
      ],
      additionalContext: { "Zotero Reader": { kind: "untrusted", value: "page text" } },
      userText: "第二问",
      contextWindow: DEFAULT_CONTEXT_WINDOW,
    });
    expect(messages[0]).toEqual({ role: "system", text: "You are the research assistant." });
    expect(messages[1]).toEqual({ role: "user", text: "第一问" });
    expect(messages[2]).toEqual({ role: "assistant", text: "第一答" });
    expect(messages[3]!.role).toBe("user");
    expect(messages[3]!.text).toContain("[Zotero Reader]");
    expect(messages[3]!.text).toContain("page text");
    expect(messages[3]!.text.endsWith("第二问")).toBe(true);
  });

  it("drops oldest pairs when over budget and never splits a pair", () => {
    const bigText = "x".repeat(3 * 1000);
    const history = [
      { role: "user" as const, text: `老:${bigText}` },
      { role: "assistant" as const, text: `老答:${bigText}` },
      { role: "user" as const, text: "新问" },
      { role: "assistant" as const, text: "新答" },
    ];
    const contextWindow = OUTPUT_TOKEN_RESERVE + estimateTokens("current") + 500;
    const messages = buildTurnMessages({
      developerInstructions: null,
      history,
      additionalContext: null,
      userText: "current",
      contextWindow,
    });
    const texts = messages.map((message) => message.text);
    expect(texts).toContain("新问");
    expect(texts).toContain("新答");
    expect(texts.some((text) => text.startsWith("老:"))).toBe(false);
    expect(texts.some((text) => text.startsWith("老答:"))).toBe(false);
    const firstHistory = messages.find((message) => message.text !== "current");
    expect(firstHistory?.role).toBe("user");
  });
});

describe("resolveEngineModel", () => {
  it("resolves the default model when modelId is null", () => {
    const resolved = resolveEngineModel(null, providers);
    expect(resolved.model.id).toBe("deepseek-chat");
  });

  it("parses engine:<provider>:<model> ids", () => {
    const resolved = resolveEngineModel(engineModelId("p1", "deepseek-reasoner"), providers);
    expect(resolved.provider.id).toBe("p1");
    expect(resolved.model.id).toBe("deepseek-reasoner");
  });

  it("throws readable errors", () => {
    expect(() => resolveEngineModel(null, [])).toThrow(/尚未配置任何模型服务/);
    expect(() => resolveEngineModel("engine:nope:m", providers)).toThrow(/找不到对应的模型服务/);
    expect(() => resolveEngineModel("engine:p1:nope", providers)).toThrow(/不在.*模型列表/);
  });
});
