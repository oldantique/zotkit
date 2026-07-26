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
    onSaveSsh: vi.fn(),
    onDeleteSsh: vi.fn(),
    onSelectCodexTarget: vi.fn(),
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
      sshProfiles: [],
      codexTarget: "local",
    });
    expect(host.textContent).toContain("DeepSeek");
    expect(host.textContent).toContain("····1234");
    expect(host.textContent).toContain("将发送到你配置的这个端点");
  });

  it("fills the form from a preset and submits a new profile", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [],
      keyMask: {},
      statusText: null,
      busy: false,
      sshProfiles: [],
      codexTarget: "local",
    });
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
      sshProfiles: [],
      codexTarget: "local",
    });
    host.querySelector<HTMLButtonElement>(".zc-provider-edit")!.click();
    host.querySelector<HTMLButtonElement>(".zc-provider-save")!.click();
    const [saved, apiKey] = callbacks.onSave.mock.calls[0]!;
    expect(saved.id).toBe("p1");
    expect(apiKey).toBeNull();
  });

  it("preserves form state across re-renders when busy state changes", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: false,
      sshProfiles: [],
      codexTarget: "local",
    });
    // Click edit to fill form with provider data
    host.querySelector<HTMLButtonElement>(".zc-provider-edit")!.click();
    // Type new values into the form
    const nameInput = host.querySelector<HTMLInputElement>(".zc-provider-name")!;
    const keyInput = host.querySelector<HTMLInputElement>(".zc-provider-key")!;
    nameInput.value = "Modified Name";
    keyInput.value = "sk-new-key";
    // Call setState with busy: true (this triggers re-render)
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: true,
      sshProfiles: [],
      codexTarget: "local",
    });
    // Assert the typed values are still there after re-render
    expect(host.querySelector<HTMLInputElement>(".zc-provider-name")!.value).toBe("Modified Name");
    expect(host.querySelector<HTMLInputElement>(".zc-provider-key")!.value).toBe("sk-new-key");
    // Restore busy to false so we can click save
    view.setState({
      providers: [profile],
      keyMask: { p1: "····1234" },
      statusText: null,
      busy: false,
      sshProfiles: [],
      codexTarget: "local",
    });
    // Assert saving submits the typed values (not null for key)
    host.querySelector<HTMLButtonElement>(".zc-provider-save")!.click();
    const [saved, apiKey] = callbacks.onSave.mock.calls[0]!;
    expect(saved.name).toBe("Modified Name");
    expect(apiKey).toBe("sk-new-key");
  });

  it("renders the SSH section and submits a password-auth profile", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [],
      keyMask: {},
      statusText: null,
      busy: false,
      sshProfiles: [],
      codexTarget: "local",
    });
    expect(host.textContent).toContain("远程 Codex");
    host.querySelector<HTMLInputElement>(".zc-ssh-host")!.value = "lab.example.edu";
    host.querySelector<HTMLInputElement>(".zc-ssh-user")!.value = "eric";
    host.querySelector<HTMLSelectElement>(".zc-ssh-auth")!.value = "password";
    // Trailing whitespace can be a meaningful part of an SSH password — it
    // must reach onSaveSsh intact, unlike API keys which are trimmed.
    host.querySelector<HTMLInputElement>(".zc-ssh-password")!.value = "hunter2 ";
    host.querySelector<HTMLButtonElement>(".zc-ssh-save")!.click();
    const [profile, password] = callbacks.onSaveSsh.mock.calls[0]!;
    expect(profile.host).toBe("lab.example.edu");
    expect(profile.auth).toBe("password");
    expect(password).toBe("hunter2 ");
    expect(host.textContent).not.toContain("hunter2");
  });

  it("reports codex target selection", () => {
    const { host, view, callbacks } = mount();
    view.setState({
      providers: [], keyMask: {}, statusText: null, busy: false,
      sshProfiles: [{
        id: "s1", name: "lab", host: "h", port: 22, user: "u",
        auth: "key", remoteCodexPath: "codex",
      }],
      codexTarget: "local",
    });
    const radios = host.querySelectorAll<HTMLInputElement>(".zc-ssh-target");
    expect(radios.length).toBe(2); // 本机 + s1
    radios[1]!.click();
    expect(callbacks.onSelectCodexTarget).toHaveBeenCalledWith("s1");
  });
});
