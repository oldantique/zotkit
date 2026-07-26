import { describe, expect, it, vi } from "vitest";
import type { AgentClient } from "../src/agent-client";
import { ENGINE_CAPABILITIES } from "../src/agent-client";
import { CodexAppServerClient } from "../src/codex-app-server";
import { CodexService } from "../src/codex-service";
import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContextService } from "../src/reader-context";

describe("agent-client contract", () => {
  it("CodexAppServerClient conforms to AgentClient", () => {
    const client: AgentClient = new CodexAppServerClient({ url: "ws://unused" });
    expect(client.agentCapabilities.supportsSteering).toBe(true);
  });
});

function engineLikeService(client: Partial<AgentClient>) {
  const callbacks = { onState: vi.fn(), onError: vi.fn() };
  const service = new CodexService(
    {} as NativeBridge,
    { tools: [] } as unknown as ReaderContextService,
    "test",
    callbacks,
  );
  const internal = service as any;
  internal.client = client;
  internal.activePaperKey = "1-ATTACH";
  internal.activeContext = {
    attachment: { key: "ATTACH", libraryID: 1, title: "P", filename: "p.pdf", creators: [], tags: [] },
    page: { pageIndex: 0, pageNumber: 1, text: "", source: "pdfjs", warnings: [] },
    workspace: { root: "/w" },
    warnings: [],
  };
  internal.threadPaperKeys.set("thread-a", "1-ATTACH");
  service.state.connected = true;
  service.state.activeThreadId = "thread-a";
  service.state.capabilities = ENGINE_CAPABILITIES;
  return { service, callbacks };
}

describe("capability guards", () => {
  it("rejects steering when the backend does not support it", async () => {
    const { service } = engineLikeService({});
    service.state.running = true;
    service.state.activeTurnId = "turn-1";
    await expect(service.send("追问", "engine:p:m", "medium"))
      .rejects.toThrow(/不支持在回答进行中追加/);
  });

  it("rejects agent mode when unsupported", async () => {
    const { service } = engineLikeService({});
    await expect(service.setMode("agent")).rejects.toThrow(/不支持 Agent 模式/);
  });

  it("rejects login when unsupported", async () => {
    const { service } = engineLikeService({});
    await expect(service.login()).rejects.toThrow(/不需要登录|不支持登录/);
  });
});
