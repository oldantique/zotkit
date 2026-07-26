import { PROVIDER_PRESETS, type ProviderModel, type ProviderProfile } from "./providers";
import type { SshCodexProfile } from "./ssh-codex";

export interface ProviderSettingsState {
  providers: ProviderProfile[];
  keyMask: Record<string, string>;
  statusText: string | null;
  busy: boolean;
  sshProfiles: SshCodexProfile[];
  codexTarget: string;
}

export interface ProviderSettingsCallbacks {
  onSave(profile: ProviderProfile, apiKey: string | null): void;
  onDelete(providerId: string): void;
  onTest(profile: ProviderProfile, apiKey: string | null): void;
  onClose(): void;
  onSaveSsh(profile: SshCodexProfile, password: string | null): void;
  onDeleteSsh(profileId: string): void;
  onSelectCodexTarget(target: string): void;
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
const SSH_HINT = "首次连接请先在终端 ssh user@host 一次以确认主机指纹。远程模式仅支持 Ask（只读）。";

interface FormSnapshot {
  name: string;
  wire: "openai" | "anthropic";
  baseUrl: string;
  models: string;
  defaultModel: string;
  key: string;
}

interface SshFormSnapshot {
  name: string;
  host: string;
  port: string;
  user: string;
  auth: "key" | "password";
  keyPath: string;
  password: string;
  remoteCodexPath: string;
}

export class ProviderSettingsView {
  private readonly host: HTMLElement;
  private readonly callbacks: ProviderSettingsCallbacks;
  private state: ProviderSettingsState = {
    providers: [],
    keyMask: {},
    statusText: null,
    busy: false,
    sshProfiles: [],
    codexTarget: "local",
  };
  private editingId = "";
  private formSnapshot: FormSnapshot | null = null;
  private sshEditingId = "";
  private sshFormSnapshot: SshFormSnapshot | null = null;

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

    // Snapshot form state before clearing
    const existingForm = this.host.querySelector<HTMLElement>(".zc-provider-form");
    if (existingForm) {
      this.formSnapshot = {
        name: this.host.querySelector<HTMLInputElement>(".zc-provider-name")?.value || "",
        wire: (this.host.querySelector<HTMLSelectElement>(".zc-provider-wire")?.value || "openai") as "openai" | "anthropic",
        baseUrl: this.host.querySelector<HTMLInputElement>(".zc-provider-baseurl")?.value || "",
        models: this.host.querySelector<HTMLTextAreaElement>(".zc-provider-models")?.value || "",
        defaultModel: this.host.querySelector<HTMLInputElement>(".zc-provider-default")?.value || "",
        key: this.host.querySelector<HTMLInputElement>(".zc-provider-key")?.value || "",
      };
    }
    const existingSshForm = this.host.querySelector<HTMLElement>(".zc-ssh-form");
    if (existingSshForm) {
      this.sshFormSnapshot = {
        name: this.host.querySelector<HTMLInputElement>(".zc-ssh-name")?.value || "",
        host: this.host.querySelector<HTMLInputElement>(".zc-ssh-host")?.value || "",
        port: this.host.querySelector<HTMLInputElement>(".zc-ssh-port")?.value || "",
        user: this.host.querySelector<HTMLInputElement>(".zc-ssh-user")?.value || "",
        auth: (this.host.querySelector<HTMLSelectElement>(".zc-ssh-auth")?.value || "key") as "key" | "password",
        keyPath: this.host.querySelector<HTMLInputElement>(".zc-ssh-keypath")?.value || "",
        password: this.host.querySelector<HTMLInputElement>(".zc-ssh-password")?.value || "",
        remoteCodexPath: this.host.querySelector<HTMLInputElement>(".zc-ssh-remote-path")?.value || "",
      };
    }

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

    const form = this.buildForm(doc);
    this.host.appendChild(form);

    // Restore form state if it was snapshotted (but not if fillForm was just called)
    if (this.formSnapshot) {
      const query = <T extends HTMLElement>(selector: string) =>
        form.querySelector<T>(selector);
      const nameInput = query<HTMLInputElement>(".zc-provider-name");
      const wireSelect = query<HTMLSelectElement>(".zc-provider-wire");
      const baseUrlInput = query<HTMLInputElement>(".zc-provider-baseurl");
      const modelsTextarea = query<HTMLTextAreaElement>(".zc-provider-models");
      const defaultModelInput = query<HTMLInputElement>(".zc-provider-default");
      const keyInput = query<HTMLInputElement>(".zc-provider-key");

      if (nameInput) nameInput.value = this.formSnapshot.name;
      if (wireSelect) wireSelect.value = this.formSnapshot.wire;
      if (baseUrlInput) baseUrlInput.value = this.formSnapshot.baseUrl;
      if (modelsTextarea) modelsTextarea.value = this.formSnapshot.models;
      if (defaultModelInput) defaultModelInput.value = this.formSnapshot.defaultModel;
      if (keyInput) keyInput.value = this.formSnapshot.key;
    }

    const sshSection = this.buildSshSection(doc);
    this.host.appendChild(sshSection);

    // Restore SSH form state if it was snapshotted (but not if fillSshForm was just called)
    if (this.sshFormSnapshot) {
      const query = <T extends HTMLElement>(selector: string) =>
        sshSection.querySelector<T>(selector);
      const nameInput = query<HTMLInputElement>(".zc-ssh-name");
      const hostInput = query<HTMLInputElement>(".zc-ssh-host");
      const portInput = query<HTMLInputElement>(".zc-ssh-port");
      const userInput = query<HTMLInputElement>(".zc-ssh-user");
      const authSelect = query<HTMLSelectElement>(".zc-ssh-auth");
      const keyPathInput = query<HTMLInputElement>(".zc-ssh-keypath");
      const passwordInput = query<HTMLInputElement>(".zc-ssh-password");
      const remotePathInput = query<HTMLInputElement>(".zc-ssh-remote-path");

      if (nameInput) nameInput.value = this.sshFormSnapshot.name;
      if (hostInput) hostInput.value = this.sshFormSnapshot.host;
      if (portInput) portInput.value = this.sshFormSnapshot.port;
      if (userInput) userInput.value = this.sshFormSnapshot.user;
      if (authSelect) authSelect.value = this.sshFormSnapshot.auth;
      if (keyPathInput) keyPathInput.value = this.sshFormSnapshot.keyPath;
      if (passwordInput) passwordInput.value = this.sshFormSnapshot.password;
      if (remotePathInput) remotePathInput.value = this.sshFormSnapshot.remoteCodexPath;
    }

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
    // Clear the snapshot since user explicitly chose a preset/edit, overriding any typed values
    this.formSnapshot = null;

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

  private buildSshSection(doc: Document): HTMLElement {
    const section = doc.createElement("div");
    section.className = "zc-ssh-section";

    const heading = doc.createElement("strong");
    heading.className = "zc-ssh-heading";
    heading.textContent = "远程 Codex（SSH）";
    section.appendChild(heading);

    const targets = doc.createElement("div");
    targets.className = "zc-ssh-targets";
    targets.appendChild(this.buildTargetOption(doc, "local", "本机"));
    for (const profile of this.state.sshProfiles) {
      targets.appendChild(this.buildTargetOption(doc, profile.id, profile.name || profile.host));
    }
    section.appendChild(targets);

    const list = doc.createElement("div");
    list.className = "zc-ssh-list";
    for (const profile of this.state.sshProfiles) {
      const row = doc.createElement("div");
      row.className = "zc-ssh-row";
      const label = doc.createElement("span");
      label.textContent = `${profile.name || profile.host} · ${profile.user}@${profile.host}:${profile.port || 22} · ${profile.auth === "key" ? "密钥" : "密码"}`;
      const edit = doc.createElement("button");
      edit.className = "zc-ssh-edit";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => {
        this.sshEditingId = profile.id;
        this.fillSshForm(profile);
      });
      const remove = doc.createElement("button");
      remove.className = "zc-ssh-delete";
      remove.textContent = "删除";
      remove.addEventListener("click", () => this.callbacks.onDeleteSsh(profile.id));
      row.append(label, edit, remove);
      list.appendChild(row);
    }
    section.appendChild(list);

    const form = this.buildSshForm(doc);
    section.appendChild(form);

    const hint = doc.createElement("p");
    hint.className = "zc-ssh-hint";
    hint.textContent = SSH_HINT;
    section.appendChild(hint);

    return section;
  }

  private buildTargetOption(doc: Document, value: string, label: string): HTMLElement {
    const wrapper = doc.createElement("label");
    wrapper.className = "zc-ssh-target-option";
    const radio = doc.createElement("input");
    radio.type = "radio";
    radio.name = "zc-ssh-target";
    radio.className = "zc-ssh-target";
    radio.value = value;
    radio.checked = this.state.codexTarget === value;
    radio.addEventListener("change", () => {
      if (radio.checked) this.callbacks.onSelectCodexTarget(value);
    });
    const text = doc.createElement("span");
    text.textContent = label;
    wrapper.append(radio, text);
    return wrapper;
  }

  private buildSshForm(doc: Document): HTMLElement {
    const form = doc.createElement("div");
    form.className = "zc-ssh-form";

    const name = input(doc, "zc-ssh-name", "名称");
    const host = input(doc, "zc-ssh-host", "host（如 lab.example.edu）");
    const port = input(doc, "zc-ssh-port", "端口（默认 22）");
    const user = input(doc, "zc-ssh-user", "用户名");
    const auth = doc.createElement("select");
    auth.className = "zc-ssh-auth";
    for (const value of ["key", "password"] as const) {
      const option = doc.createElement("option");
      option.value = value;
      option.textContent = value === "key" ? "密钥" : "密码";
      auth.appendChild(option);
    }
    const keyPath = input(doc, "zc-ssh-keypath", "私钥路径（留空 = 用 ssh-agent/默认密钥）");
    const password = input(doc, "zc-ssh-password", "密码（留空 = 保留已存的）");
    password.type = "password";
    const remoteCodexPath = input(doc, "zc-ssh-remote-path", "远端 codex 路径（默认 codex，建议绝对路径）");

    const save = doc.createElement("button");
    save.className = "zc-ssh-save";
    save.textContent = "保存";
    save.disabled = this.state.busy;
    save.addEventListener("click", () => {
      this.callbacks.onSaveSsh(this.collectSsh(form), sshPasswordValue(form));
    });

    form.append(name, host, port, user, auth, keyPath, password, remoteCodexPath, save);
    return form;
  }

  private fillSshForm(profile: SshCodexProfile): void {
    // Clear the snapshot since user explicitly chose to edit, overriding any typed values
    this.sshFormSnapshot = null;

    const query = <T extends HTMLElement>(selector: string) =>
      this.host.querySelector<T>(selector)!;
    query<HTMLInputElement>(".zc-ssh-name").value = profile.name;
    query<HTMLInputElement>(".zc-ssh-host").value = profile.host;
    query<HTMLInputElement>(".zc-ssh-port").value = profile.port ? String(profile.port) : "";
    query<HTMLInputElement>(".zc-ssh-user").value = profile.user;
    query<HTMLSelectElement>(".zc-ssh-auth").value = profile.auth;
    query<HTMLInputElement>(".zc-ssh-keypath").value = profile.keyPath || "";
    query<HTMLInputElement>(".zc-ssh-password").value = "";
    query<HTMLInputElement>(".zc-ssh-remote-path").value = profile.remoteCodexPath || "";
  }

  private collectSsh(form: HTMLElement): SshCodexProfile {
    const query = <T extends HTMLElement>(selector: string) => form.querySelector<T>(selector)!;
    const parsedPort = Number.parseInt(query<HTMLInputElement>(".zc-ssh-port").value.trim(), 10);
    const keyPath = query<HTMLInputElement>(".zc-ssh-keypath").value.trim();
    const profile: SshCodexProfile = {
      id: this.sshEditingId,
      name: query<HTMLInputElement>(".zc-ssh-name").value.trim(),
      host: query<HTMLInputElement>(".zc-ssh-host").value.trim(),
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22,
      user: query<HTMLInputElement>(".zc-ssh-user").value.trim(),
      auth: query<HTMLSelectElement>(".zc-ssh-auth").value === "password" ? "password" : "key",
      remoteCodexPath: query<HTMLInputElement>(".zc-ssh-remote-path").value.trim() || "codex",
    };
    if (keyPath) profile.keyPath = keyPath;
    return profile;
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

function sshPasswordValue(form: HTMLElement): string | null {
  const value = form.querySelector<HTMLInputElement>(".zc-ssh-password")!.value.trim();
  return value ? value : null;
}
