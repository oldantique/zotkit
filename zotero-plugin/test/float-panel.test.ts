// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/platform", () => ({
  copyToClipboard: vi.fn(() => true),
}));

import {
  FloatPanelView,
  latestExchange,
  type FloatPanelCallbacks,
} from "../src/float-panel";
import { copyToClipboard } from "../src/platform";

function callbacks(): FloatPanelCallbacks {
  return {
    onSend: vi.fn(),
    onStop: vi.fn(),
    onClose: vi.fn(),
    onRemoveSelection: vi.fn(),
    onLogin: vi.fn(),
    onModelChange: vi.fn(),
    onOpacityChange: vi.fn(),
    onPanelResize: vi.fn(),
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
    transcript.querySelector<HTMLButtonElement>(".zc-turn-summary")?.click();
    expect(transcript.textContent).toContain("zotero_get_current_selection");
    expect(transcript.querySelector("strong")?.textContent).toBe("核心");
  });

  it("copies the raw answer text via the privileged clipboard helper and shows a transient confirmation", () => {
    vi.mocked(copyToClipboard).mockClear();
    vi.mocked(copyToClipboard).mockReturnValue(true);
    vi.useFakeTimers();
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      entries: [{ id: "a1", kind: "assistant", text: "**核心** 是注意力" }],
    });

    const button = host.querySelector<HTMLButtonElement>(".zc-copy-answer")!;
    expect(button).not.toBeNull();
    expect(button.title).toBe("复制回答");

    button.click();

    expect(copyToClipboard).toHaveBeenCalledWith("**核心** 是注意力");
    expect(button.classList.contains("is-copied")).toBe(true);
    expect(button.title).toBe("已复制");

    vi.advanceTimersByTime(1500);
    expect(button.classList.contains("is-copied")).toBe(false);
    expect(button.title).toBe("复制回答");
    vi.useRealTimers();
  });

  it("does not add the copied state when the clipboard helper reports failure", () => {
    vi.mocked(copyToClipboard).mockClear();
    vi.mocked(copyToClipboard).mockReturnValue(false);
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      entries: [{ id: "a1", kind: "assistant", text: "answer" }],
    });

    const button = host.querySelector<HTMLButtonElement>(".zc-copy-answer")!;
    button.click();

    expect(button.classList.contains("is-copied")).toBe(false);
    expect(button.title).toBe("复制回答");
  });

  it("does not render a copy button on error entries", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      entries: [{ id: "e1", kind: "error", text: "boom" }],
    });

    const button = host.querySelector<HTMLButtonElement>(".zc-copy-answer");
    expect(button).toBeNull();
  });

  it("skips formula click-to-copy while a text selection is active, and copies once it collapses", () => {
    vi.mocked(copyToClipboard).mockClear();
    vi.mocked(copyToClipboard).mockReturnValue(true);
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      entries: [{ id: "a1", kind: "assistant", text: "$$x$$" }],
    });
    const formula = host.querySelector<HTMLElement>(".zc-math-copy")!;
    expect(formula).not.toBeNull();

    const getSelectionSpy = vi.spyOn(window, "getSelection")
      .mockReturnValue({ isCollapsed: false } as Selection);
    formula.click();
    expect(copyToClipboard).not.toHaveBeenCalled();

    getSelectionSpy.mockReturnValue({ isCollapsed: true } as Selection);
    formula.click();
    expect(copyToClipboard).toHaveBeenCalledWith("x");

    getSelectionSpy.mockRestore();
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

  it("does not start a drag when mousedown lands on the close button", () => {
    const { host, view } = mount();
    view.show();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    const close = host.querySelector<HTMLButtonElement>(".zc-float-close")!;
    close.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 210, clientY: 130, bubbles: true }));
    expect(root.style.left).toBe("");
    expect(root.classList.contains("is-dragged")).toBe(false);
  });
});

describe("FloatPanelView activity line", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("collapses running process entries into a single activity line", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      running: true, turnStartedAt: Date.now(),
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "r1", kind: "reasoning", title: "思考过程", text: "…", state: "complete" },
        { id: "t1", kind: "tool", title: "zotero_read_pdf_pages", text: "", state: "running" },
      ],
    });
    expect(host.querySelectorAll(".zc-float-entry.zc-entry-tool").length).toBe(0);
    expect(host.querySelectorAll(".zc-float-entry.zc-entry-reasoning").length).toBe(0);
    const label = host.querySelector(".zc-activity-label")!;
    expect(label.textContent).toBe("正在调用 读取论文页面");
  });

  it("renders an expandable summary line after completion", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      running: false, turnDurations: { u1: 28_000 },
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "t1", kind: "tool", title: "zotero_read_pdf_pages", text: "done", state: "complete" },
        { id: "a1", kind: "assistant", text: "答", state: "complete" },
      ],
    });
    expect(host.querySelector(".zc-activity")).toBeNull();
    const summary = host.querySelector(".zc-turn-summary")!;
    expect(summary.textContent).toContain("28s");
    expect(summary.textContent).toContain("1 个步骤");
    expect(host.querySelector(".zc-turn-detail")).toBeNull();
    (summary as HTMLElement).click();
    expect(host.querySelectorAll(".zc-turn-detail .zc-tool-card").length).toBe(1);
    (summary as HTMLElement).click();
    expect(host.querySelector(".zc-turn-detail")).toBeNull();
  });

  it("omits the summary line when there is nothing to report", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready", running: false, turnDurations: {},
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "a1", kind: "assistant", text: "答", state: "complete" },
      ],
    });
    expect(host.querySelector(".zc-turn-summary")).toBeNull();
  });

  it("reuses the same .zc-activity DOM node across renders while streaming (I2), only updating its label text", () => {
    const { host, view } = mount();
    view.setState({
      phase: "ready",
      running: true,
      turnStartedAt: Date.now(),
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "r1", kind: "reasoning", text: "…", state: "running" },
      ],
    });
    const node = host.querySelector(".zc-activity");
    expect(node).not.toBeNull();
    expect(host.querySelector(".zc-activity-label")?.textContent).toBe("思考中…");

    // The float panel rebuilds its whole transcript on every render; the
    // spinner/shimmer node identity must still be stable so the CSS
    // animation is not restarted mid-stream.
    view.setState({
      entries: [
        { id: "u1", kind: "user", text: "问" },
        { id: "t1", kind: "tool", title: "zotero_read_pdf_pages", text: "", state: "running" },
      ],
    });

    expect(host.querySelector(".zc-activity")).toBe(node);
    expect(host.querySelector(".zc-activity-label")?.textContent).toBe("正在调用 读取论文页面");
  });

  describe("pinned autoscroll", () => {
    // happy-dom's scrollHeight/clientHeight getters are hardcoded to 0, so a
    // real "is the transcript visually at the bottom" check is unavailable
    // here. We shadow those getters with own properties on the live
    // `.zc-float-transcript` element to fake realistic geometry, which lets
    // us drive the `scroll` listener's `pinnedToBottom` computation and then
    // observe the resulting `scrollTop` writes the implementation performs.
    function fakeGeometry(transcript: HTMLElement, scrollHeight: number, clientHeight: number): void {
      Object.defineProperty(transcript, "scrollHeight", { value: scrollHeight, configurable: true });
      Object.defineProperty(transcript, "clientHeight", { value: clientHeight, configurable: true });
    }

    it("autoscrolls after every render while pinned, stops once the user scrolls away, and re-pins when the panel is (re)shown", () => {
      const { view, host } = mount();
      const transcript = host.querySelector<HTMLElement>(".zc-float-transcript")!;
      fakeGeometry(transcript, 500, 100);

      // Default `pinnedToBottom = true`, and autoscroll fires on every render.
      view.setState({ phase: "ready", entries: [{ id: "u1", kind: "user", text: "问" }] });
      expect(transcript.scrollTop).toBe(500);

      // User scrolls away from the bottom -> the scroll listener unpins.
      transcript.scrollTop = 0;
      transcript.dispatchEvent(new Event("scroll"));

      // A render while unpinned must not snap the user back to the bottom.
      view.setState({
        entries: [
          { id: "u1", kind: "user", text: "问" },
          { id: "a1", kind: "assistant", text: "答" },
        ],
      });
      expect(transcript.scrollTop).toBe(0);

      // The float panel has no thread tabs to key a reset off of; reopening
      // it via show() re-pins so the next render catches up to the bottom.
      view.show();
      view.setState({
        entries: [
          { id: "u1", kind: "user", text: "问" },
          { id: "a1", kind: "assistant", text: "答 2" },
        ],
      });
      expect(transcript.scrollTop).toBe(500);
    });
  });

  describe("activity timer lifecycle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("updates only the elapsed text node once per second while running", () => {
      const { view, host } = mount();
      // Offset so each 1000ms tick crosses a whole-second rounding boundary
      // (formatElapsed rounds ms/1000), making the text change predictably.
      const startedAt = Date.now() - 700;
      view.setState({
        phase: "ready",
        running: true,
        turnStartedAt: startedAt,
        entries: [{ id: "u1", kind: "user", text: "问" }],
      });
      const label = host.querySelector(".zc-activity-label")!;
      const elapsed = host.querySelector(".zc-activity-elapsed")!;
      expect(elapsed.textContent).toBe("1s");

      vi.advanceTimersByTime(1000);
      expect(host.querySelector(".zc-activity-elapsed")?.textContent).toBe("2s");
      // Only the elapsed text changed; the rest of the activity line (and
      // the DOM node itself) was not touched by a full re-render.
      expect(host.querySelector(".zc-activity-label")).toBe(label);
      expect(host.querySelector(".zc-activity-elapsed")).toBe(elapsed);

      vi.advanceTimersByTime(1000);
      expect(elapsed.textContent).toBe("3s");
      expect(host.querySelector(".zc-activity-elapsed")).toBe(elapsed);
    });

    it("does not start a second interval on repeated setState while running", () => {
      const { view } = mount();
      const setIntervalSpy = vi.spyOn(window, "setInterval");
      view.setState({
        phase: "ready",
        running: true,
        turnStartedAt: Date.now(),
        entries: [{ id: "u1", kind: "user", text: "问" }],
      });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      view.setState({
        entries: [
          { id: "u1", kind: "user", text: "问" },
          { id: "r1", kind: "reasoning", text: "思考", state: "running" },
        ],
      });
      view.setState({
        entries: [
          { id: "u1", kind: "user", text: "问" },
          { id: "r1", kind: "reasoning", text: "思考中…", state: "running" },
        ],
      });

      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);
    });

    it("clears the interval once running turns false", () => {
      const { view } = mount();
      view.setState({
        phase: "ready",
        running: true,
        turnStartedAt: Date.now(),
        entries: [{ id: "u1", kind: "user", text: "问" }],
      });
      expect(vi.getTimerCount()).toBe(1);

      const clearIntervalSpy = vi.spyOn(window, "clearInterval");
      view.setState({ running: false });

      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("clears the interval on destroy", () => {
      const { view } = mount();
      view.setState({
        phase: "ready",
        running: true,
        turnStartedAt: Date.now(),
        entries: [{ id: "u1", kind: "user", text: "问" }],
      });
      expect(vi.getTimerCount()).toBe(1);

      view.destroy();

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("FloatPanelView model picker", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders the Codex model options and forwards selection changes", () => {
    const { host, view, handlers } = mount();
    view.setState({
      phase: "ready",
      models: [
        { id: "gpt-5", label: "GPT-5" },
        { id: "gpt-5-codex", label: "GPT-5 Codex" },
      ],
      selectedModel: "gpt-5",
    });
    const select = host.querySelector<HTMLSelectElement>(".zc-float-model")!;
    expect(select.hidden).toBe(false);
    expect([...select.options].map((option) => option.value)).toEqual(["gpt-5", "gpt-5-codex"]);
    expect(select.value).toBe("gpt-5");
    select.value = "gpt-5-codex";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handlers.onModelChange).toHaveBeenCalledWith("gpt-5-codex");
  });

  it("hides the model picker until models are known", () => {
    const { host, view } = mount();
    view.setState({ phase: "ready", models: [] });
    expect(host.querySelector<HTMLSelectElement>(".zc-float-model")!.hidden).toBe(true);
  });
});

describe("FloatPanelView background opacity slider", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("renders a 60-100 step-5 range slider between the title and close button", () => {
    const { host } = mount();
    const slider = host.querySelector<HTMLInputElement>("input.zc-float-alpha")!;
    expect(slider).not.toBeNull();
    expect(slider.type).toBe("range");
    expect(slider.min).toBe("60");
    expect(slider.max).toBe("100");
    expect(slider.step).toBe("5");
    expect(slider.title).toBe("背景透明度");
    const bar = host.querySelector<HTMLElement>(".zc-float-bar")!;
    const children = [...bar.children];
    const titleIndex = children.indexOf(host.querySelector(".zc-float-title")!);
    const closeIndex = children.indexOf(host.querySelector(".zc-float-close")!);
    const sliderIndex = children.indexOf(slider);
    expect(sliderIndex).toBeGreaterThan(titleIndex);
    expect(sliderIndex).toBeLessThan(closeIndex);
  });

  it("forwards slider changes to onOpacityChange", () => {
    const { host, handlers } = mount();
    const slider = host.querySelector<HTMLInputElement>("input.zc-float-alpha")!;
    slider.value = "85";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    expect(handlers.onOpacityChange).toHaveBeenCalledWith(85);
  });

  it("applies opacity state as the --zc-float-alpha custom property", () => {
    const { host, view } = mount();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    view.setState({ opacity: 85 });
    expect(root.style.getPropertyValue("--zc-float-alpha")).toBe("0.85");
  });

  it("does not start a drag when mousedown lands on the opacity slider", () => {
    const { host, view } = mount();
    view.show();
    const root = host.querySelector<HTMLElement>(".zc-float")!;
    const slider = host.querySelector<HTMLInputElement>("input.zc-float-alpha")!;
    slider.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 10, clientY: 10, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 210, clientY: 130, bubbles: true }));
    expect(root.style.left).toBe("");
    expect(root.classList.contains("is-dragged")).toBe(false);
  });
});

describe("FloatPanelView ResizeObserver guard", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("mounts and destroys without throwing when ResizeObserver is unavailable", () => {
    const previous = (globalThis as any).ResizeObserver;
    vi.stubGlobal("ResizeObserver", undefined);
    expect(() => {
      const { view } = mount();
      view.show();
      view.destroy();
    }).not.toThrow();
    vi.stubGlobal("ResizeObserver", previous);
  });
});
