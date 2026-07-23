// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FloatPanelView,
  latestExchange,
  type FloatPanelCallbacks,
} from "../src/float-panel";

function callbacks(): FloatPanelCallbacks {
  return {
    onSend: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    onRemoveSelection: vi.fn(),
    onLogin: vi.fn(),
  };
}

function mount(handlers = callbacks()): { host: HTMLElement; view: FloatPanelView; handlers: FloatPanelCallbacks } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new FloatPanelView(host, handlers);
  return { host, view, handlers };
}

describe("FloatPanelView shell", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("mounts hidden and toggles with show/hide", () => {
    const { host, view } = mount();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    expect(root).not.toBeNull();
    expect(root.hidden).toBe(true);
    expect(view.isVisible()).toBe(false);
    view.show();
    expect(root.hidden).toBe(false);
    expect(view.isVisible()).toBe(true);
    view.hide();
    expect(root.hidden).toBe(true);
  });

  it("sends trimmed composer text on Enter and clears the input", () => {
    const { host, view, handlers } = mount();
    view.setState({ phase: "ready" });
    view.show();
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    input.value = "  什么是注意力机制？  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onSend).toHaveBeenCalledWith("什么是注意力机制？");
    expect(input.value).toBe("");
  });

  it("does not send while the panel is not ready", () => {
    const { host, handlers } = mount();
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    input.value = "question";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handlers.onSend).not.toHaveBeenCalled();
  });

  it("closes via Escape, ⌘K inside the input, and the close button", () => {
    const { host, view, handlers } = mount();
    view.setState({ phase: "ready" });
    view.show();
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    host.querySelector<HTMLButtonElement>(".zc-float-close")!.click();
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });

  it("shows connecting, signed-out (with login), and error notes; disables input unless ready", () => {
    const { host, view, handlers } = mount();
    view.setState({ phase: "connecting" });
    const input = host.querySelector<HTMLTextAreaElement>(".zc-float-input")!;
    expect(input.disabled).toBe(true);
    expect(host.textContent).toContain("正在连接 Codex");
    view.setState({ phase: "signed-out" });
    const login = host.querySelector<HTMLButtonElement>(".zc-float-login")!;
    login.click();
    expect(handlers.onLogin).toHaveBeenCalledOnce();
    view.setState({ phase: "error", error: "连接断开" });
    expect(host.textContent).toContain("连接断开");
    expect(host.querySelector<HTMLElement>(".zc-float-note")!.hidden).toBe(false);
    view.setState({ phase: "ready", error: undefined });
    expect(input.disabled).toBe(false);
    expect(host.querySelector<HTMLElement>(".zc-float-note")!.hidden).toBe(true);
  });

  it("renders the paper title in the drag bar and removes everything on destroy", () => {
    const { host, view } = mount();
    view.setState({ paperTitle: "Attention Is All You Need" });
    expect(host.querySelector(".zc-float-title")?.textContent).toBe("Attention Is All You Need");
    view.destroy();
    expect(host.querySelector(".zc-float")).toBeNull();
  });
});

describe("latestExchange", () => {
  it("returns entries from the last user message onward", () => {
    expect(latestExchange([
      { id: "u1", kind: "user", text: "q1" },
      { id: "a1", kind: "assistant", text: "a1" },
      { id: "u2", kind: "user", text: "q2" },
      { id: "t2", kind: "tool", text: "tool", title: "zotero_get_current_page" },
      { id: "a2", kind: "assistant", text: "a2" },
    ]).map((entry) => entry.id)).toEqual(["u2", "t2", "a2"]);
  });

  it("returns [] when there is no user entry yet", () => {
    expect(latestExchange([])).toEqual([]);
    expect(latestExchange([{ id: "s", kind: "status", text: "hi" }])).toEqual([]);
  });
});

describe("FloatPanelView selection chip and transcript", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows the selection chip with size and page, and forwards removal", () => {
    const { host, view, handlers } = mount();
    view.setState({ selection: { text: "a".repeat(128), pageNumber: 3 } });
    const chip = host.querySelector<HTMLElement>(".zc-float-chip")!;
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toContain("已选 128 字");
    expect(chip.textContent).toContain("第 3 页");
    chip.querySelector<HTMLButtonElement>(".zc-float-chip-remove")!.click();
    expect(handlers.onRemoveSelection).toHaveBeenCalledOnce();
    view.setState({ selection: null });
    expect(chip.hidden).toBe(true);
  });

  it("renders only the latest exchange: user bubble, tool card, markdown answer", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      entries: latestExchange([
        { id: "u1", kind: "user", text: "old question" },
        { id: "a1", kind: "assistant", text: "old answer" },
        { id: "u2", kind: "user", text: "这段在说什么？" },
        { id: "t2", kind: "tool", title: "zotero_get_current_selection", text: "ok", state: "complete" },
        { id: "a2", kind: "assistant", text: "**核心** 是注意力" },
      ]),
    });
    const transcript = host.querySelector<HTMLElement>(".zc-float-transcript")!;
    expect(transcript.hidden).toBe(false);
    expect(transcript.textContent).not.toContain("old question");
    expect(transcript.querySelector(".zc-user-bubble")?.textContent).toBe("这段在说什么？");
    expect(transcript.textContent).toContain("zotero_get_current_selection");
    expect(transcript.querySelector("strong")?.textContent).toBe("核心");
  });

  it("hides the transcript when there is no exchange yet", () => {
    const { host, view } = mount();
    view.setState({ phase: "ready", entries: [] });
    expect(host.querySelector<HTMLElement>(".zc-float-transcript")!.hidden).toBe(true);
  });

  it("shows the stop button only while running", () => {
    const { host, view } = mount();
    view.setState({ phase: "ready", running: true });
    expect(host.querySelector<HTMLElement>(".zc-float-stop")!.hidden).toBe(false);
    view.setState({ running: false });
    expect(host.querySelector<HTMLElement>(".zc-float-stop")!.hidden).toBe(true);
  });
});

describe("FloatPanelView drag", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("moves with the pointer and clamps to the viewport margin", () => {
    const { host, view } = mount();
    view.show();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    const bar = host.querySelector<HTMLElement>(".zc-float-bar")!;
    bar.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 210, clientY: 130, bubbles: true }));
    expect(root.classList.contains("is-dragged")).toBe(true);
    expect(root.style.left).toBe("200px");
    expect(root.style.top).toBe("120px");
    // Far past the left/top edge → clamped to the 8px margin.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: -500, clientY: -500, bubbles: true }));
    expect(root.style.left).toBe("8px");
    expect(root.style.top).toBe("8px");
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    // After mouseup, further moves are ignored.
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 400, clientY: 400, bubbles: true }));
    expect(root.style.left).toBe("8px");
  });
});
