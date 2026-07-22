// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SidebarView, type SidebarCallbacks } from "../src/sidebar";
import { renderMarkdown } from "../src/markdown";

function callbacks(): SidebarCallbacks {
  return {
    onSend: vi.fn(),
    onStop: vi.fn(),
    onNewThread: vi.fn(),
    onSelectThread: vi.fn(),
    onLogin: vi.fn(),
    onLogout: vi.fn(),
    onOpenTerminal: vi.fn(),
    onRefreshContext: vi.fn(),
    onInsertSelection: vi.fn(),
    onModelChange: vi.fn(),
    onEffortChange: vi.fn()
  };
}

describe("SidebarView", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("keeps the advanced Terminal reachable when app-server is unavailable", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const handlers = callbacks();
    const view = new SidebarView(body, handlers);
    view.setState({ phase: "unavailable", error: "app-server is unavailable" });

    const button = [...body.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent === "打开高级 Terminal")!;
    button.click();

    expect(handlers.onOpenTerminal).toHaveBeenCalledOnce();
  });

  it("renders the current paper, streamed answer, tools, and safe controls", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const view = new SidebarView(body, callbacks());
    view.setState({
      phase: "ready",
      accountLabel: "ChatGPT",
      context: {
        key: "ABC123",
        title: "A Test Paper",
        pageLabel: "7",
        pagesCount: 20,
        selectionText: "selected theorem"
      },
      entries: [
        { id: "u1", kind: "user", text: "Explain this" },
        { id: "t1", kind: "tool", title: "zotero_get_current_page", text: "page 7", state: "complete" },
        { id: "a1", kind: "assistant", text: "**Result:** page 7" }
      ],
      models: [{ id: "gpt-5", label: "GPT-5" }],
      threads: [],
      selectedModel: "gpt-5",
      effort: "high",
      running: false
    });

    expect(body.textContent).toContain("A Test Paper");
    expect(body.textContent).toContain("选区 16 字");
    expect(body.textContent).toContain("zotero_get_current_page");
    expect(body.querySelector("strong")?.textContent).toBe("Result:");
    expect(body.textContent).toContain("只读");
    expect(body.querySelector<HTMLButtonElement>('button[title="打开高级 CLI 终端"]')?.textContent).toContain("Terminal");
    expect(body.textContent).toContain("Research Chat");
    for (const title of ["对话历史", "新对话", "打开高级 CLI 终端", "账户", "刷新 Reader 上下文", "发送"]) {
      expect(body.querySelector(`button[title="${title}"] svg.zc-button-icon`)).not.toBeNull();
    }
  });

  it("provides Cursor-style thread tabs, modes, context chips, and an @ context menu", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const handlers = callbacks();
    handlers.onModeChange = vi.fn();
    handlers.onAddContext = vi.fn();
    handlers.onRemoveContext = vi.fn();
    const view = new SidebarView(body, handlers);
    view.setState({
      phase: "ready",
      mode: "agent",
      context: {
        key: "ABC123",
        title: "A Test Paper",
        pageLabel: "7",
        selectionText: "selected theorem",
      },
      contextChips: [
        { id: "paper", kind: "paper", label: "当前论文" },
        { id: "selection", kind: "selection", label: "选区 · 16 字", removable: true },
      ],
      contextSuggestions: [
        { id: "annotations", kind: "annotation", label: "Annotations", detail: "12 notes" },
        { id: "library", kind: "library", label: "Library", detail: "All papers" },
      ],
      threads: [
        { id: "thread-a", title: "Main theorem", updatedAt: "2026-07-22", active: true, status: "running" },
        { id: "thread-b", title: "Methods", updatedAt: "2026-07-21", active: false },
      ],
    });

    expect(body.querySelector('.zc-sidebar')?.getAttribute("data-mode")).toBe("agent");
    expect(body.textContent).toContain("需审批");
    expect(body.querySelectorAll(".zc-thread-tab")).toHaveLength(2);
    body.querySelector<HTMLButtonElement>('[data-thread-id="thread-b"]')?.click();
    expect(handlers.onSelectThread).toHaveBeenCalledWith("thread-b");

    const mode = body.querySelector<HTMLSelectElement>('select[title="研究模式"]')!;
    mode.value = "ask";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handlers.onModeChange).toHaveBeenCalledWith("ask");

    body.querySelector<HTMLButtonElement>('button[title="移除上下文：选区 · 16 字"]')?.click();
    expect(handlers.onRemoveContext).toHaveBeenCalledWith("selection");

    const input = body.querySelector<HTMLTextAreaElement>("textarea")!;
    input.value = "Compare @anno";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const menu = body.querySelector<HTMLElement>(".zc-context-menu")!;
    expect(menu.hidden).toBe(false);
    expect(menu.textContent).toContain("Annotations");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onAddContext).toHaveBeenCalledWith(expect.objectContaining({ id: "annotations" }));
    expect(input.value).toBe("Compare ");
    expect(menu.hidden).toBe(true);
  });

  it("renders plan, diff review, pending approval, and restorable checkpoints", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const handlers = callbacks();
    handlers.onReviewDecision = vi.fn();
    handlers.onApprovalDecision = vi.fn();
    handlers.onRestoreCheckpoint = vi.fn();
    const view = new SidebarView(body, handlers);
    view.setState({
      phase: "ready",
      plan: {
        id: "plan-1",
        title: "Research plan",
        explanation: "Read before comparing.",
        steps: [
          { id: "step-1", title: "Read the abstract", status: "complete" },
          { id: "step-2", title: "Inspect the derivation", status: "running" },
        ],
      },
      reviews: [{
        id: "review-1",
        title: "Proposed note",
        summary: "Review before applying.",
        diff: "@@ note\n-old\n+new",
      }],
      pendingApproval: {
        id: "approval-1",
        title: "Open an external source",
        command: "search_library_pdf",
        kind: "tool",
        risk: "low",
      },
      checkpoints: [{ id: "checkpoint-1", label: "Before comparison", createdAt: "2026-07-22T10:30:00Z" }],
    });

    expect(body.textContent).toContain("Research plan");
    expect(body.textContent).toContain("1/2");
    expect(body.querySelector(".zc-diff-view .is-addition")?.textContent).toBe("+new");
    [...body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "接受建议")?.click();
    expect(handlers.onReviewDecision).toHaveBeenCalledWith("review-1", "accept");
    [...body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "仅允许这一次")?.click();
    expect(handlers.onApprovalDecision).toHaveBeenCalledWith("approval-1", "approve-once");
    [...body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Restore")?.click();
    expect(handlers.onRestoreCheckpoint).toHaveBeenCalledWith("checkpoint-1");
  });

  it("can reveal the composer when Zotero expands the custom section", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const view = new SidebarView(body, callbacks());
    const input = body.querySelector("textarea")!;
    input.scrollIntoView = vi.fn();

    view.revealComposer();

    expect(input.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("reconciles streamed entries without collapsing an expanded tool card", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const view = new SidebarView(body, callbacks());
    view.setState({
      phase: "ready",
      entries: [
        { id: "tool-1", kind: "reasoning", title: "思考过程", text: "first", state: "running" },
        { id: "answer-1", kind: "assistant", text: "stable" }
      ]
    });
    const details = body.querySelector<HTMLDetailsElement>('[data-entry-id="tool-1"] details')!;
    const stable = body.querySelector<HTMLElement>('[data-entry-id="answer-1"]')!;
    details.open = true;

    view.setState({
      entries: [
        { id: "tool-1", kind: "reasoning", title: "思考过程", text: "first second", state: "running" },
        { id: "answer-1", kind: "assistant", text: "stable" }
      ]
    });

    expect(body.querySelector<HTMLDetailsElement>('[data-entry-id="tool-1"] details')?.open).toBe(true);
    expect(body.querySelector<HTMLElement>('[data-entry-id="answer-1"]')).toBe(stable);
  });

  it("submits with Enter and keeps Shift+Enter available for multiline input", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const handlers = callbacks();
    const view = new SidebarView(body, handlers);
    view.setState({ phase: "ready" });
    const input = body.querySelector("textarea")!;
    input.value = "What is the main theorem?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onSend).toHaveBeenCalledWith("What is the main theorem?");
  });

  it("sends a follow-up while running and keeps stop as a separate button and Escape action", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const handlers = callbacks();
    const view = new SidebarView(body, handlers);
    view.setState({ phase: "ready", running: true });

    const input = body.querySelector("textarea")!;
    expect(input.disabled).toBe(false);
    input.value = "Also compare it with theorem 2.";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onSend).toHaveBeenCalledWith("Also compare it with theorem 2.");
    expect(handlers.onStop).not.toHaveBeenCalled();

    input.value = "And keep the page citations.";
    const followUp = body.querySelector<HTMLButtonElement>('button[title="发送补充"]')!;
    followUp.click();
    expect(handlers.onSend).toHaveBeenLastCalledWith("And keep the page citations.");

    const stop = body.querySelector<HTMLButtonElement>('button[title="停止生成（Esc）"]')!;
    expect(stop.hidden).toBe(false);
    stop.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(handlers.onStop).toHaveBeenCalledTimes(2);
  });

  it("renders the selected model's reasoning efforts and uses its advertised default", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const view = new SidebarView(body, callbacks());
    view.setState({
      phase: "ready",
      models: [{
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "max" },
          { reasoningEffort: "ultra", description: "Automatic task delegation" }
        ],
        defaultReasoningEffort: "low",
        isDefault: true
      }],
      selectedModel: "gpt-5.6-sol",
      effort: "medium"
    });

    const select = body.querySelector<HTMLSelectElement>('select[title="思考强度"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(["low", "max", "ultra"]);
    expect(select.value).toBe("low");
    expect([...select.options].map((option) => option.textContent)).toContain("思考 Ultra");
  });

  it("shows ChatGPT login without exposing a token field", () => {
    const body = document.createElement("div");
    document.body.appendChild(body);
    const handlers = callbacks();
    const view = new SidebarView(body, handlers);
    view.setState({ phase: "signed-out" });
    const button = [...body.querySelectorAll("button")]
      .find((candidate) => candidate.textContent === "使用 ChatGPT 登录")!;
    button.click();
    expect(handlers.onLogin).toHaveBeenCalledOnce();
    expect(body.querySelector('input[type="password"]')).toBeNull();
  });
});

describe("Reader pane layout CSS", () => {
  it("uses a bounded compact grid without a transcript minimum that can push the composer below the pane", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toContain("grid-template-rows: auto auto auto minmax(0, 1fr) auto");
    expect(styles).toContain("height: clamp(420px, 72vh, 780px)");
    expect(styles).toContain(".zc-composer-wrap { position: sticky; bottom: 0;");
    expect(styles).toContain(".zc-context-menu { position: absolute;");
    // The optional formula rail is hidden by default. Pin the terminal surface
    // to the final flexible row so CSS Grid does not leave xterm at 0px tall.
    expect(styles).toContain(".zc-terminal-surface { grid-row: 4;");
    expect(styles).not.toContain("minmax(320px, 1fr)");
    expect(styles).not.toContain("min-height: 610px");
    expect(styles).not.toContain("min-height: 560px");
  });

  it("responds to the Zotero pane width instead of the application viewport", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toContain("container-name: zotkit-pane");
    expect(styles).toContain("container-type: inline-size");
    expect(styles).toContain("@container zotkit-pane (max-width: 420px)");
    expect(styles).toContain("@container zotkit-pane (max-width: 340px)");
    expect(styles).toContain("grid-template-columns: auto minmax(0, 1fr)");
    expect(styles).not.toContain("@media (max-width: 420px)");
  });
});

describe("renderMarkdown", () => {
  it("does not interpret model-provided HTML", () => {
    const host = document.createElement("div");
    host.appendChild(renderMarkdown(document, '<img src=x onerror="alert(1)">'));
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img");
  });
});
