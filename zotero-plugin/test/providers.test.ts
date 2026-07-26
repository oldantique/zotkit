import { afterEach, describe, expect, it } from "vitest";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import { deleteSecret, maskSecret, readSecret, saveSecret } from "../src/secrets";
import { setPrefString } from "../src/platform";
import {
  PROVIDER_PRESETS,
  loadProviders,
  providerKeyRealm,
  saveProviders,
  testProvider,
  type ProviderProfile,
} from "../src/providers";

const profile: ProviderProfile = {
  id: "p-deepseek",
  name: "DeepSeek",
  wire: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [{ id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 65536 }],
  defaultModel: "deepseek-chat",
};

afterEach(() => {
  saveProviders([]);
});

describe("secrets (memory fallback outside Gecko)", () => {
  it("round-trips and masks a secret", async () => {
    await saveSecret(providerKeyRealm("p1"), "p1", "sk-abcdef1234");
    expect(await readSecret(providerKeyRealm("p1"), "p1")).toBe("sk-abcdef1234");
    expect(maskSecret("sk-abcdef1234")).toBe("····1234");
    await deleteSecret(providerKeyRealm("p1"), "p1");
    expect(await readSecret(providerKeyRealm("p1"), "p1")).toBeNull();
  });
});

describe("providers", () => {
  it("round-trips profiles through the pref", () => {
    saveProviders([profile]);
    expect(loadProviders()).toEqual([profile]);
  });

  it("tolerates corrupted pref JSON", () => {
    setPrefString("providers", "{not json");
    expect(loadProviders()).toEqual([]);
  });

  it("ships the spec'd presets", () => {
    const names = PROVIDER_PRESETS.map((preset) => preset.name);
    expect(names).toEqual(expect.arrayContaining([
      "DeepSeek", "Kimi（月之暗面开放平台）", "Kimi For Coding（订阅）",
      "OpenRouter", "Ollama（本地）", "OpenAI", "Anthropic",
    ]));
    const kimiSub = PROVIDER_PRESETS.find((preset) => preset.name.startsWith("Kimi For Coding"));
    expect(kimiSub?.wire).toBe("anthropic");
    expect(kimiSub?.baseUrl).toBe("");
  });

  it("reports readable connectivity results", async () => {
    const ok = await testProvider(profile, "sk-x", async (options) => {
      options.onChunk("data: {}\n");
      return { status: 200, ok: true, errorBody: null };
    });
    expect(ok).toMatch(/连接成功/);
    await expect(testProvider(profile, "sk-x", async () => ({
      status: 401, ok: false, errorBody: null,
    }))).rejects.toThrow(/401/);
  });
});
