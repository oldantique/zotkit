import { describe, expect, it, vi } from "vitest";
import { CodexService } from "../src/codex-service";
import { setPrefString } from "../src/platform";
import { installGeckoStubs } from "./gecko-stubs";

installGeckoStubs();

import { READER_CONTEXT_TOOLS, READER_TOOL_NAMES } from "../src/reader-context";
import { ZOTERO_MUTATION_TOOL, ZoteroMutationService } from "../src/zotero-mutations";
import { ENGINE_CAPABILITIES } from "../src/agent-client";
import { EngineClient } from "../src/engine-client";
import type { NativeBridge } from "../src/native-bridge";
import type { ReaderContextService } from "../src/reader-context";

describe("deterministic-write guarantee on the engine backend", () => {
  it("passes only read-only reader tools to engine threads in ask mode", async () => {
    setPrefString("backend", "engine");
    const captured: unknown[] = [];
    const engine = {
      agentCapabilities: ENGINE_CAPABILITIES,
      connect: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
      accountRead: vi.fn().mockResolvedValue({ account: null, requiresOpenaiAuth: false }),
      modelList: vi.fn().mockResolvedValue({ data: [] }),
      threadStart: vi.fn().mockImplementation(async (params: { dynamicTools?: unknown[] }) => {
        captured.push(...(params.dynamicTools ?? []));
        return { thread: { id: "eng-1" } };
      }),
      threadResume: vi.fn(),
      threadRead: vi.fn().mockResolvedValue({}),
      threadSetName: vi.fn().mockResolvedValue({}),
      turnStart: vi.fn().mockResolvedValue({ turn: { id: "t" } }),
      turnInterrupt: vi.fn().mockResolvedValue({}),
    };
    Object.setPrototypeOf(engine, EngineClient.prototype);
    const callbacks = { onState: vi.fn(), onError: vi.fn() };
    // Real mutation-tool registry (not a hand-rolled fake), so this locks the
    // actual composition site: dynamicToolSpecs() must not fold in
    // agentToolProvider.tools while mode is "ask".
    const mutations = new ZoteroMutationService(
      {} as any,
      { onState: () => {}, getContext: () => null },
    );
    const mutationProvider = {
      tools: mutations.tools,
      invokeTool: vi.fn(),
    };
    const service = new CodexService(
      {} as NativeBridge,
      { tools: READER_CONTEXT_TOOLS } as unknown as ReaderContextService,
      "test",
      callbacks,
      mutationProvider as never,
      () => engine as never,
    );
    const specs = (service as any).dynamicToolSpecs() as Array<{ name: string }>;
    const names = specs.map((spec) => spec.name);
    expect(names).toEqual([...READER_TOOL_NAMES]);
    expect(names).not.toContain(ZOTERO_MUTATION_TOOL);
    // Agent mode (the only path that could expose mutation tools) is
    // structurally unreachable on the engine backend:
    service.state.capabilities = ENGINE_CAPABILITIES;
    await expect(service.setMode("agent")).rejects.toThrow(/不支持 Agent 模式/);
  });
});
