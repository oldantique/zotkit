# Zotkit Reader native helper

This directory contains the dependency-free macOS process used by the Zotero
extension. It has two deliberately separate modes:

- A profile-private Unix-domain HTTP/WebSocket daemon that owns the real Codex or
  Claude PTY selected by the Zotero sidebar.
- A newline-delimited MCP JSON-RPC server that exposes read-only Reader context
  and a bounded view of the configured PDF library folder.
- A second read-only MCP/CLI surface that queries the XPI-generated local Zotero
  metadata snapshot without Python, Web API credentials, or network access.

## Build and test

```sh
make
make test
make universal
```

`make universal` produces `dist/zoterochat-helper`, a single universal Mach-O
containing arm64 and x86_64 slices. It targets macOS 12 or later and uses only
Apple system libraries.

## Daemon protocol

Start the daemon with a randomly generated token (16–256 bytes) in a private
file and a previously unused socket path inside a private directory. The helper
verifies directory/file ownership and modes, refuses pre-existing socket nodes,
and unlinks the token file immediately after opening it, so the secret never
appears in the process argument list:

```sh
umask 077
mkdir -m 700 /absolute/private/run
printf '%s\n' "$RANDOM_TOKEN" > /absolute/private/token-file
build/zoterochat-helper --socket /absolute/private/run/bridge.sock \
  --token-file /absolute/private/token-file
```

The socket node is mode 0600 and accepted peers must match the helper's effective
UID. WebSocket `/ws` uses mutual HMAC-SHA1 proofs tied to each random
`Sec-WebSocket-Key`; the bearer secret itself is never sent over the socket. A
diagnostic `GET /health` accepts only `Authorization: Bearer`. WebSocket client
frames must follow RFC 6455 and be masked.

Text messages are JSON objects:

- `{"type":"spawn","sessionId":"paper-1","argv":["/bin/zsh","-l"],"cwd":"/absolute/workspace","env":{"NAME":"value"},"rows":30,"cols":100}`
- `{"type":"spawnPipe","sessionId":"appserver-1","argv":["/absolute/codex","app-server","--stdio"],"cwd":"/absolute/workspace"}`
- `{"type":"input","sessionId":"paper-1","encoding":"base64","data":"..."}` (`utf8` is also accepted)
- `{"type":"resize","sessionId":"paper-1","rows":40,"cols":120}`
- `{"type":"close","sessionId":"paper-1"}`
- `{"type":"shutdown"}`
- `{"type":"ping"}`

`spawn` creates a PTY. `spawnPipe` creates a bidirectional stdio socket and is
used to keep Codex app-server off unauthenticated TCP ports. `argv` is the
complete argument vector, including `argv[0]`. Alternatively,
`command` plus an `args` array can be supplied. Output events contain base64 PTY
bytes; exit events contain either `exitCode` or `signal`.
Session errors include their `sessionId`. `close`, client disconnect, and authenticated
`shutdown` all use bounded HUP → TERM → KILL process-group cleanup; incomplete HTTP
handshakes are discarded after two seconds.

## MCP context

Start MCP mode with a directory containing `context.json`, or the file itself:

```sh
build/zoterochat-helper --mcp-stdio --context /path/to/reader-context
```

`context.json` may contain an absolute `libraryRoot`, plus `activePaper`,
`currentPage`, `currentSelection`, and a validated active-attachment `pdfText`
reference. The legacy ZoteroChat workspace schema is also
accepted directly (`attachment`, `parent`, `pdfPath`, `page`, and `selection`).
Sibling files `current-page.md` and `current-selection.md` are returned by the
corresponding tools. Context is reloaded for every tool call.

The active-PDF tools search that bounded text and read inclusive page ranges. A
Zotero index reference must be a regular, owned `.zotero-ft-cache` beneath the
matching attachment-key directory; a private fallback must be the managed
`current-pdf-text.txt`. The library tools only list/search non-hidden PDF paths. Every requested path
is resolved beneath `libraryRoot`; hidden components, directory traversal and
symlinks are rejected. When `libraryRoot` is absent, Reader context tools
continue to work and the two library tools return a tool error. No MCP tool
writes to Zotero, the PDF folder, or context.

## Bundled Zotkit metadata mode

The XPI installs the same signed helper bytes under the basename `zotkit` and
prepends that private directory to the terminal's `PATH`. The sidebar can therefore
run `zotkit find`, `zotkit get`, `zotkit collections`, or `zotkit tags` immediately.
The commands are read-only and emit JSON; mutating Zotkit commands are intentionally
absent.

Codex receives the equivalent four-tool MCP server through:

```sh
build/zoterochat-helper --zotkit-mcp --context /path/to/paper-workspace
```

The context file contains a reference to the one shared snapshot for that Zotero
library. Snapshot paths are accepted only beneath the plugin profile's
`reader-context/library-snapshots` directory, and symlinks, foreign ownership,
oversized files, and malformed records are rejected.
