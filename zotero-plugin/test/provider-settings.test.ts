// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  ProviderSettingsView,
  formatModelLines,
  parseModelLines,
} from "../src/provider-settings";
import type { ProviderProfile } from "../src/providers";

const profile: ProviderProfile = {
  id: "p1",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [{ id: "deepseek-chat", label: "Chat", contextWindow: 65536 }],
  defaultModel: "deepseek-chat",
};

function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const callbacks = {
    onSave: vi.fn(),
    onDelete: vi.fn(),
    onTest: vi.fn(),
    onClose: vi.fn(),
  };
  const view = new ProviderSettingsView(host, callbacks);
  return { host, view, callbacks };
}

describe("parseModelLines", () => {
  it("parses id|label|contextWindow|effort lines", () => {
    expect(parseModelLines("m1|Model One|131072|effort\nm2|Model Two\n\n")).toEqual([
      { id: "m1", label: "Model One", contextWindow: 131072, supportsReasoningEffort: true },
      { id: "m2", label: "Model Two" },
    ]);
  });

  it("round-trips through formatModelLines", () => {
    const models = parseModelLines(formatModelLines(profile.models));
    expect(models).toEqual(profile.models);
  });
});

describe("ProviderSettingsView", () => {
  it("lists providers with masked keys and never renders a raw key", () => {
    const { host, view } = mount();
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: false,
    });
    expect(host.textContent).toContain("DeepSeek");
    expect(host.textContent).toContain("····1234");
    expect(host.textContent).toContain("将发送到你配置的这个端点");
  });

  it("fills the form from a preset and submits a new profile", () => {
    const { host, view, callbacks } = mount();
    view.setState({ providers: [], keyMask: {}, statusText: null, busy: false });
    const presetSelect = host.querySelector<HTMLSelectElement>(".zc-provider-preset")!;
    presetSelect.value = "DeepSeek";
    presetSelect.dispatchEvent(new Event("change", { bubbles: true }));
    const baseUrl = host.querySelector<HTMLInputElement>(".zc-provider-baseurl")!;
    expect(baseUrl.value).toBe("https://api.deepseek.com");
    const keyInput = host.querySelector<HTMLInputElement>(".zc-provider-key")!;
    keyInput.value = "sk-secret";
    host.querySelector<HTMLButtonElement>(".zc-provider-save")!.click();
    expect(callbacks.onSave).toHaveBeenCalledTimes(1);
    const [saved, apiKey] = callbacks.onSave.mock.calls[0]!;
    expect(saved.id).toBe("");
    expect(saved.name).toBe("DeepSeek");
    expect(saved.models.length).toBeGreaterThan(0);
    expect(apiKey).toBe("sk-secret");
  });

  it("editing keeps the stored key when the key input stays empty", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: false,
    });
    host.querySelector<HTMLButtonElement>(".zc-provider-edit")!.click();
    host.querySelector<HTMLButtonElement>(".zc-provider-save")!.click();
    const [saved, apiKey] = callbacks.onSave.mock.calls[0]!;
    expect(saved.id).toBe("p1");
    expect(apiKey).toBeNull();
  });
});
