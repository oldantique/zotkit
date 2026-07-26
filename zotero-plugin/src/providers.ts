import { prefString, setPrefString } from "./platform";
import { streamRequest, type StreamRequestOptions, type StreamResult } from "./http-stream";
import { OpenAIWire } from "./wire-openai";

export interface ProviderModel {
  id: string;
  label: string;
  contextWindow?: number;
  supportsReasoningEffort?: boolean;
}

export interface ProviderProfile {
  id: string;
  name: string;
  wire: "openai" | "anthropic";
  baseUrl: string;
  models: ProviderModel[];
  defaultModel: string;
}

export type ProviderPreset = Omit<ProviderProfile, "id">;

export const PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  {
    name: "DeepSeek",
    wire: "openai" as const,
    baseUrl: "https://api.deepseek.com",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 65536 },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", contextWindow: 65536 },
    ],
    defaultModel: "deepseek-chat",
  },
  {
    name: "Kimi（月之暗面开放平台）",
    wire: "openai" as const,
    baseUrl: "https://api.moonshot.cn/v1",
    models: [{ id: "kimi-k2-0711-preview", label: "Kimi K2", contextWindow: 131072 }],
    defaultModel: "kimi-k2-0711-preview",
  },
  {
    // Subscription endpoint is Anthropic-compatible; its URL tracks Moonshot's
    // docs, so the preset ships without one and the form requires it.
    name: "Kimi For Coding（订阅）",
    wire: "anthropic" as const,
    baseUrl: "",
    models: [{ id: "kimi-k2-0711-preview", label: "Kimi K2（订阅）", contextWindow: 131072 }],
    defaultModel: "kimi-k2-0711-preview",
  },
  {
    name: "OpenRouter",
    wire: "openai" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    defaultModel: "",
  },
  {
    name: "Ollama（本地）",
    wire: "openai" as const,
    baseUrl: "http://localhost:11434/v1",
    models: [],
    defaultModel: "",
  },
  {
    name: "OpenAI",
    wire: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "gpt-5-mini", label: "GPT-5 mini", supportsReasoningEffort: true }],
    defaultModel: "gpt-5-mini",
  },
  {
    name: "Anthropic",
    wire: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    models: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200000 }],
    defaultModel: "claude-sonnet-5",
  },
]);

export function loadProviders(): ProviderProfile[] {
  try {
    const parsed = JSON.parse(prefString("providers", "[]")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProviderProfile);
  }
  catch {
    return [];
  }
}

export function saveProviders(profiles: ProviderProfile[]): void {
  setPrefString("providers", JSON.stringify(profiles));
}

export function providerKeyRealm(providerId: string): string {
  return `zotkit-provider:${providerId}`;
}

/** One minimal streamed completion against the profile; resolves with a readable success line. */
export async function testProvider(
  profile: ProviderProfile,
  apiKey: string,
  streamImpl: (options: StreamRequestOptions) => Promise<StreamResult> = streamRequest,
): Promise<string> {
  const model = profile.models.find((candidate) => candidate.id === profile.defaultModel)
    ?? profile.models[0];
  if (!model) throw new Error("请先在模型列表里至少配置一个模型");
  if (!profile.baseUrl) throw new Error("请填写 baseUrl");
  // Anthropic wire arrives in Task 11; until then connectivity tests use the
  // OpenAI wire and anthropic-wire profiles surface a readable notice.
  if (profile.wire === "anthropic") throw new Error("Anthropic 兼容服务的连通性测试将在后续版本提供");
  const wire = new OpenAIWire();
  const request = wire.buildRequest(
    profile.baseUrl,
    apiKey,
    [{ role: "user", text: "ping" }],
    [],
    { model: model.id, effort: null },
  );
  const controller = new AbortController();
  let sawChunk = false;
  const result = await streamImpl({
    url: request.url,
    headers: request.headers,
    body: request.body,
    signal: controller.signal,
    onChunk: () => {
      sawChunk = true;
      controller.abort();
    },
  }).catch((error: unknown) => {
    if ((error as Error)?.name === "AbortError" && sawChunk) {
      return { status: 200, ok: true, errorBody: null } satisfies StreamResult;
    }
    throw error;
  });
  if (!result.ok) throw new Error(connectivityError(result));
  return `连接成功：${profile.name} · ${model.id}`;
}

export function connectivityError(result: StreamResult): string {
  if (result.status === 401) return "API key 无效或已过期（HTTP 401）";
  if (result.status === 402 || result.status === 403) return `余额不足或没有权限（HTTP ${result.status}）`;
  if (result.status === 404) return "模型名或 baseUrl 不存在（HTTP 404）";
  if (result.status === 429) return "请求被限流（HTTP 429），请稍后重试";
  const detail = extractErrorMessage(result.errorBody);
  return detail
    ? `模型服务返回 HTTP ${result.status}：${detail}`
    : `模型服务返回 HTTP ${result.status}`;
}

function extractErrorMessage(errorBody: string | null): string | null {
  if (!errorBody) return null;
  try {
    const parsed = JSON.parse(errorBody) as { error?: { message?: unknown }; message?: unknown };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string") return message.slice(0, 200);
  }
  catch { /* not JSON */ }
  return errorBody.slice(0, 200);
}

function isProviderProfile(value: unknown): value is ProviderProfile {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string"
    && typeof record.name === "string"
    && (record.wire === "openai" || record.wire === "anthropic")
    && typeof record.baseUrl === "string"
    && Array.isArray(record.models)
    && typeof record.defaultModel === "string";
}
