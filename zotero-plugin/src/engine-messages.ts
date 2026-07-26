import type { AdditionalContextEntry } from "./protocol";
import type { WireMessage } from "./wire";
import type { ProviderModel, ProviderProfile } from "./providers";

export const DEFAULT_CONTEXT_WINDOW = 131072;
export const OUTPUT_TOKEN_RESERVE = 8192;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface EngineHistoryMessage {
  role: "user" | "assistant";
  text: string;
}

export interface BuildTurnMessagesInput {
  developerInstructions: string | null;
  history: EngineHistoryMessage[];
  additionalContext: Record<string, AdditionalContextEntry> | null | undefined;
  userText: string;
  contextWindow: number;
}

export function formatAdditionalContext(
  additionalContext: Record<string, AdditionalContextEntry> | null | undefined,
): string {
  if (!additionalContext) return "";
  return Object.entries(additionalContext)
    .map(([name, entry]) => `[${name}]\n${entry.value}`)
    .join("\n\n");
}

/**
 * Assembles the wire messages for one engine turn. The per-turn Reader
 * attachment is ephemeral (rebuilt fresh every turn, exactly like the codex
 * path), so history keeps only the raw user/assistant texts. Over budget,
 * whole user/assistant pairs drop oldest-first; system and the current user
 * message are never dropped.
 */
export function buildTurnMessages(input: BuildTurnMessagesInput): WireMessage[] {
  const system: WireMessage | null = input.developerInstructions
    ? { role: "system", text: input.developerInstructions }
    : null;
  const contextBlock = formatAdditionalContext(input.additionalContext);
  const currentText = contextBlock ? `${contextBlock}\n\n${input.userText}` : input.userText;
  const current: WireMessage = { role: "user", text: currentText };
  const budget = Math.max(
    0,
    input.contextWindow
      - OUTPUT_TOKEN_RESERVE
      - estimateTokens(system?.text ?? "")
      - estimateTokens(currentText),
  );
  const kept: WireMessage[] = [];
  let used = 0;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index]!;
    const cost = estimateTokens(message.text);
    if (used + cost > budget) break;
    used += cost;
    kept.unshift({ role: message.role, text: message.text });
  }
  while (kept.length && kept[0]!.role === "assistant") kept.shift();
  return [...(system ? [system] : []), ...kept, current];
}

export function engineModelId(providerId: string, modelId: string): string {
  return `engine:${providerId}:${modelId}`;
}

export interface EngineModelRef {
  provider: ProviderProfile;
  model: ProviderModel;
}

export function resolveEngineModel(
  modelId: string | null | undefined,
  providers: ProviderProfile[],
): EngineModelRef {
  if (!providers.length) throw new Error("尚未配置任何模型服务，请在设置中添加");
  if (!modelId) {
    const provider = providers[0]!;
    const model = provider.models.find((candidate) => candidate.id === provider.defaultModel)
      ?? provider.models[0];
    if (!model) throw new Error(`模型服务 ${provider.name} 没有配置模型`);
    return { provider, model };
  }
  const match = /^engine:([^:]+):(.+)$/.exec(modelId);
  if (!match) throw new Error(`无法识别的引擎模型：${modelId}`);
  const provider = providers.find((candidate) => candidate.id === match[1]);
  if (!provider) throw new Error("找不到对应的模型服务，请检查设置");
  const model = provider.models.find((candidate) => candidate.id === match[2]);
  if (!model) throw new Error(`模型 ${match[2]} 不在 ${provider.name} 的模型列表里`);
  return { provider, model };
}
