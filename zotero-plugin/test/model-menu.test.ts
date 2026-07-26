// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { defaultSelectableModel, modelBackend, renderModelOptions } from "../src/model-menu";

describe("modelBackend", () => {
  it("classifies by the engine: prefix", () => {
    expect(modelBackend("engine:p1:deepseek-chat")).toBe("engine");
    expect(modelBackend("gpt-5")).toBe("codex");
  });
});

describe("renderModelOptions", () => {
  it("groups engine and codex models into labelled optgroups", () => {
    const select = document.createElement("select");
    renderModelOptions(select, [
      { id: "engine:p1:deepseek-chat", label: "DeepSeek · Chat" },
      { id: "gpt-5", label: "GPT-5" },
    ], "engine:p1:deepseek-chat");
    const groups = [...select.querySelectorAll("optgroup")].map((group) => group.label);
    expect(groups).toEqual(["内置引擎", "Codex（订阅）"]);
    expect(select.value).toBe("engine:p1:deepseek-chat");
  });

  it("omits an empty group", () => {
    const select = document.createElement("select");
    renderModelOptions(select, [{ id: "gpt-5", label: "GPT-5" }], "gpt-5");
    expect([...select.querySelectorAll("optgroup")].map((group) => group.label)).toEqual(["Codex（订阅）"]);
  });
});

describe("defaultSelectableModel", () => {
  it("skips the literal \"codex\" placeholder id", () => {
    expect(defaultSelectableModel([
      { id: "codex", label: "Codex（订阅）" },
      { id: "gpt-5", label: "GPT-5" },
    ])).toBe("gpt-5");
  });

  it("prefers the isDefault entry over plain first-match", () => {
    expect(defaultSelectableModel([
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 mini", isDefault: true },
      { id: "codex", label: "Codex（订阅）" },
    ])).toBe("gpt-5-mini");
  });

  it("falls back to the first non-placeholder model when none is isDefault", () => {
    expect(defaultSelectableModel([
      { id: "codex", label: "Codex（订阅）" },
      { id: "engine:p1:deepseek-chat", label: "DeepSeek · Chat" },
      { id: "engine:p1:deepseek-reasoner", label: "DeepSeek · Reasoner" },
    ])).toBe("engine:p1:deepseek-chat");
  });

  it("returns \"\" when the placeholder is the only entry", () => {
    expect(defaultSelectableModel([{ id: "codex", label: "Codex（订阅）" }])).toBe("");
  });

  it("returns \"\" for an empty model list", () => {
    expect(defaultSelectableModel([])).toBe("");
  });
});
