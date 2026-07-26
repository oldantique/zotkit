import { PROVIDER_PRESETS, type ProviderModel, type ProviderProfile } from "./providers";

export interface ProviderSettingsState {
  providers: ProviderProfile[];
  keyMask: Record<string, string>;
  statusText: string | null;
  busy: boolean;
}

export interface ProviderSettingsCallbacks {
  onSave(profile: ProviderProfile, apiKey: string | null): void;
  onDelete(providerId: string): void;
  onTest(profile: ProviderProfile, apiKey: string | null): void;
  onClose(): void;
}

export function parseModelLines(text: string): ProviderModel[] {
  const models: ProviderModel[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const [id = "", label = "", contextWindow = "", effort = ""] = line.split("|").map((part) => part.trim());
    if (!id) continue;
    const model: ProviderModel = { id, label: label || id };
    const parsedWindow = Number.parseInt(contextWindow, 10);
    if (Number.isFinite(parsedWindow) && parsedWindow > 0) model.contextWindow = parsedWindow;
    if (effort === "effort") model.supportsReasoningEffort = true;
    models.push(model);
  }
  return models;
}

export function formatModelLines(models: ProviderModel[]): string {
  return models.map((model) => [
    model.id,
    model.label,
    model.contextWindow ? String(model.contextWindow) : "",
    model.supportsReasoningEffort ? "effort" : "",
  ].join("|").replace(/\|+$/, "")).join("\n");
}

const EGRESS_NOTICE = "对话内容（含论文摘录、批注）将发送到你配置的这个端点。请仅使用你信任的服务。";

export class ProviderSettingsView {
  private readonly host: HTMLElement;
  private readonly callbacks: ProviderSettingsCallbacks;
  private state: ProviderSettingsState = { providers: [], keyMask: {}, statusText: null, busy: false };
  private editingId = "";

  constructor(host: HTMLElement, callbacks: ProviderSettingsCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    this.host.classList.add("zc-provider-settings");
    this.render();
  }

  setState(state: ProviderSettingsState): void {
    this.state = state;
    this.render();
  }

  destroy(): void {
    this.host.replaceChildren();
  }

  private render(): void {
    const doc = this.host.ownerDocument;
    this.host.replaceChildren();

    const header = doc.createElement("div");
    header.className = "zc-provider-header";
    const title = doc.createElement("strong");
    title.textContent = "模型服务";
    const close = doc.createElement("button");
    close.className = "zc-provider-close";
    close.textContent = "关闭";
    close.addEventListener("click", () => this.callbacks.onClose());
    header.append(title, close);
    this.host.appendChild(header);

    const list = doc.createElement("div");
    list.className = "zc-provider-list";
    for (const provider of this.state.providers) {
      const row = doc.createElement("div");
      row.className = "zc-provider-row";
      const label = doc.createElement("span");
      label.textContent = `${provider.name} · ${provider.wire} · ${provider.baseUrl || "（未填 baseUrl）"}`;
      const mask = doc.createElement("span");
      mask.className = "zc-provider-mask";
      mask.textContent = this.state.keyMask[provider.id] || "未保存 key";
      const edit = doc.createElement("button");
      edit.className = "zc-provider-edit";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => {
        this.editingId = provider.id;
        this.fillForm(provider);
      });
      const remove = doc.createElement("button");
      remove.className = "zc-provider-delete";
      remove.textContent = "删除";
      remove.addEventListener("click", () => this.callbacks.onDelete(provider.id));
      row.append(label, mask, edit, remove);
      list.appendChild(row);
    }
    this.host.appendChild(list);

    this.host.appendChild(this.buildForm(doc));

    if (this.state.statusText) {
      const status = doc.createElement("div");
      status.className = "zc-provider-status";
      status.textContent = this.state.statusText;
      this.host.appendChild(status);
    }

    const notice = doc.createElement("p");
    notice.className = "zc-provider-egress";
    notice.textContent = EGRESS_NOTICE;
    this.host.appendChild(notice);
  }

  private buildForm(doc: Document): HTMLElement {
    const form = doc.createElement("div");
    form.className = "zc-provider-form";

    const preset = doc.createElement("select");
    preset.className = "zc-provider-preset";
    const placeholder = doc.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "从预设开始…";
    preset.appendChild(placeholder);
    for (const candidate of PROVIDER_PRESETS) {
      const option = doc.createElement("option");
      option.value = candidate.name;
      option.textContent = candidate.name;
      preset.appendChild(option);
    }
    preset.addEventListener("change", () => {
      const chosen = PROVIDER_PRESETS.find((candidate) => candidate.name === preset.value);
      if (chosen) {
        this.editingId = "";
        this.fillForm({ ...chosen, id: "" });
      }
    });

    const name = input(doc, "zc-provider-name", "名称");
    const baseUrl = input(doc, "zc-provider-baseurl", "baseUrl（如 https://api.deepseek.com）");
    const wire = doc.createElement("select");
    wire.className = "zc-provider-wire";
    for (const value of ["openai", "anthropic"]) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = value === "openai" ? "OpenAI 兼容" : "Anthropic 兼容";
      wire.appendChild(option);
    }
    const models = doc.createElement("textarea");
    models.className = "zc-provider-models";
    models.placeholder = "每行一个模型：id|显示名|contextWindow|effort";
    const defaultModel = input(doc, "zc-provider-default", "默认模型 id");
    const key = input(doc, "zc-provider-key", "API key（留空 = 保留已存的）");
    key.type = "password";

    const test = doc.createElement("button");
    test.className = "zc-provider-test";
    test.textContent = "测试连接";
    test.disabled = this.state.busy;
    test.addEventListener("click", () => {
      this.callbacks.onTest(this.collect(form), keyValue(form));
    });

    const save = doc.createElement("button");
    save.className = "zc-provider-save";
    save.textContent = "保存";
    save.disabled = this.state.busy;
    save.addEventListener("click", () => {
      this.callbacks.onSave(this.collect(form), keyValue(form));
    });

    form.append(preset, name, wire, baseUrl, models, defaultModel, key, test, save);
    return form;
  }

  private fillForm(profile: ProviderProfile): void {
    const query = <T extends HTMLElement>(selector: string) =>
      this.host.querySelector<T>(selector)!;
    query<HTMLInputElement>(".zc-provider-name").value = profile.name;
    query<HTMLSelectElement>(".zc-provider-wire").value = profile.wire;
    query<HTMLInputElement>(".zc-provider-baseurl").value = profile.baseUrl;
    query<HTMLTextAreaElement>(".zc-provider-models").value = formatModelLines(profile.models);
    query<HTMLInputElement>(".zc-provider-default").value = profile.defaultModel;
    query<HTMLInputElement>(".zc-provider-key").value = "";
  }

  private collect(form: HTMLElement): ProviderProfile {
    const query = <T extends HTMLElement>(selector: string) => form.querySelector<T>(selector)!;
    const models = parseModelLines(query<HTMLTextAreaElement>(".zc-provider-models").value);
    const defaultModel = query<HTMLInputElement>(".zc-provider-default").value.trim()
      || models[0]?.id || "";
    return {
      id: this.editingId,
      name: query<HTMLInputElement>(".zc-provider-name").value.trim(),
      wire: query<HTMLSelectElement>(".zc-provider-wire").value === "anthropic" ? "anthropic" : "openai",
      baseUrl: query<HTMLInputElement>(".zc-provider-baseurl").value.trim(),
      models,
      defaultModel,
    };
  }
}

function input(doc: Document, className: string, placeholder: string): HTMLInputElement {
  const element = doc.createElement("input");
  element.className = className;
  element.placeholder = placeholder;
  return element;
}

function keyValue(form: HTMLElement): string | null {
  const value = form.querySelector<HTMLInputElement>(".zc-provider-key")!.value.trim();
  return value ? value : null;
}
