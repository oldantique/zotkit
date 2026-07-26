export interface StreamResult {
  status: number;
  ok: boolean;
  errorBody: string | null;
}

export interface StreamRequestOptions {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
  onChunk(text: string): void;
  /** Injectable for tests; `null` forces the XHR fallback path. */
  fetchImpl?: typeof fetch | null;
}

/**
 * Streams a POST response body as incremental text. Prefers fetch +
 * ReadableStream (Gecko 102+); falls back to XMLHttpRequest onprogress when
 * fetch is unavailable. Non-2xx responses never reach onChunk — the whole
 * body is returned as errorBody so callers can surface a readable error.
 */
export async function streamRequest(options: StreamRequestOptions): Promise<StreamResult> {
  const fetchImpl = options.fetchImpl === undefined
    ? (typeof fetch === "function" ? fetch.bind(globalThis) : null)
    : options.fetchImpl;
  if (fetchImpl) return fetchStream(fetchImpl, options);
  return xhrStream(options);
}

async function fetchStream(
  fetchImpl: typeof fetch,
  options: StreamRequestOptions,
): Promise<StreamResult> {
  const response = await fetchImpl(options.url, {
    method: "POST",
    headers: options.headers,
    body: options.body,
    signal: options.signal,
  });
  if (!response.ok) {
    let errorBody: string | null = null;
    try {
      errorBody = await response.text();
    }
    catch {
      errorBody = null;
    }
    return { status: response.status, ok: false, errorBody };
  }
  const body = response.body;
  if (!body) {
    // Environment without ReadableStream on Response: deliver in one piece.
    options.onChunk(await response.text());
    return { status: response.status, ok: true, errorBody: null };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length) {
      const text = decoder.decode(value, { stream: true });
      if (text) options.onChunk(text);
    }
  }
  const tail = decoder.decode();
  if (tail) options.onChunk(tail);
  return { status: response.status, ok: true, errorBody: null };
}

function xhrStream(options: StreamRequestOptions): Promise<StreamResult> {
  return new Promise<StreamResult>((resolve, reject) => {
    const XHR = (globalThis as { XMLHttpRequest?: new () => XMLHttpRequest }).XMLHttpRequest;
    if (!XHR) {
      reject(new Error("此环境不支持网络请求"));
      return;
    }
    const request = new XHR();
    let delivered = 0;
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => finish(() => {
      try { request.abort(); } catch { /* already closed */ }
      reject(abortError());
    });
    if (options.signal.aborted) {
      reject(abortError());
      return;
    }
    options.signal.addEventListener("abort", onAbort);
    request.open("POST", options.url, true);
    for (const [name, value] of Object.entries(options.headers)) {
      request.setRequestHeader(name, value);
    }
    request.onprogress = () => {
      if (request.status >= 200 && request.status < 300) {
        const text = request.responseText || "";
        if (text.length > delivered) {
          options.onChunk(text.slice(delivered));
          delivered = text.length;
        }
      }
    };
    request.onload = () => finish(() => {
      const ok = request.status >= 200 && request.status < 300;
      if (ok) {
        const text = request.responseText || "";
        if (text.length > delivered) options.onChunk(text.slice(delivered));
        resolve({ status: request.status, ok: true, errorBody: null });
      }
      else {
        resolve({ status: request.status, ok: false, errorBody: request.responseText || null });
      }
    });
    request.onerror = () => finish(() => reject(new Error("网络请求失败，请检查网络或 baseUrl")));
    request.send(options.body);
  });
}

function abortError(): Error {
  const error = new Error("已中断");
  error.name = "AbortError";
  return error;
}
