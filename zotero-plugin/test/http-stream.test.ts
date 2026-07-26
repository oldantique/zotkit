import { describe, expect, it } from "vitest";
import { streamRequest } from "../src/http-stream";

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe("streamRequest", () => {
  it("delivers chunks incrementally on 2xx", async () => {
    const seen: string[] = [];
    const result = await streamRequest({
      url: "https://api.example/v1",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
      onChunk: (text) => seen.push(text),
      fetchImpl: async () => sseResponse(["hel", "lo"]),
    });
    expect(result.ok).toBe(true);
    expect(seen.join("")).toBe("hello");
  });

  it("returns errorBody without chunks on non-2xx", async () => {
    const seen: string[] = [];
    const result = await streamRequest({
      url: "https://api.example/v1",
      headers: {},
      body: "{}",
      signal: new AbortController().signal,
      onChunk: (text) => seen.push(text),
      fetchImpl: async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    });
    expect(result).toEqual({ status: 401, ok: false, errorBody: '{"error":{"message":"bad key"}}' });
    expect(seen).toEqual([]);
  });

  it("falls back to XHR when fetchImpl is null", async () => {
    const seen: string[] = [];
    class FakeXHR {
      status = 200;
      responseText = "";
      onprogress: (() => void) | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      open() {}
      setRequestHeader() {}
      abort() {}
      send() {
        this.responseText = "part1";
        this.onprogress?.();
        this.responseText = "part1part2";
        this.onprogress?.();
        this.onload?.();
      }
    }
    (globalThis as any).XMLHttpRequest = FakeXHR;
    const result = await streamRequest({
      url: "https://api.example/v1",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: new AbortController().signal,
      onChunk: (text) => seen.push(text),
      fetchImpl: null,
    });
    delete (globalThis as any).XMLHttpRequest;
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["part1", "part2"]);
  });

  it("rejects with AbortError when aborted before start", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(streamRequest({
      url: "https://api.example/v1",
      headers: {},
      body: "{}",
      signal: controller.signal,
      onChunk: () => {},
      fetchImpl: async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
