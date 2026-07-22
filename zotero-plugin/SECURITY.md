# Security model

Zotero extensions run with broad privileges inside the desktop application. Zotkit therefore treats the XPI, its bundled native helper, and the locally installed Codex/Claude executable as trusted local software. The controls below reduce accidental or prompt-driven changes; they are not a formal sandbox for a compromised macOS account, a malicious add-on, or a hostile locally installed CLI/MCP server.

## Surfaces and trust boundaries

Zotkit exposes two agent surfaces with different policies:

| Surface | Default access | How writes happen |
| --- | --- | --- |
| Research Chat — Ask | Codex app-server, read-only sandbox, network disabled, `approvalPolicy: never` | No mutation tool and no write approval path |
| Research Chat — Agent | Codex app-server, network disabled, workspace-write limited to Zotkit's private staging workspace | Private-workspace command/file approvals are shown to the user; Zotero/PDF changes require a separate Diff and Apply |
| Advanced Codex Terminal | Real PTY, `--sandbox read-only --ask-for-approval untrusted` | The user can approve escalation in the Codex TUI |
| Advanced Claude Terminal | Real PTY, `--permission-mode plan` | Claude's plan mode is a CLI policy, not an OS sandbox |

The active PDF directory is supplied as research context. It is not a writable root for structured Agent mode. Requests from app-server to write outside the private staging workspace are rejected. This restriction does not apply to an operation the user separately approves in the advanced PTY: the Terminal is deliberately a full CLI surface, and its shell or user-configured MCP actions do not pass through Research Chat's Apply cards.

`codex app-server` is an experimental Codex interface and may change. Zotkit fails visibly when the local protocol is unavailable or incompatible and offers the advanced Terminal as a fallback; protocol compatibility is not itself a security guarantee.

## Reader context and prompt injection

Reader tools are observational. They expose bounded metadata, current-page/selection snapshots, current-PDF search/page reads, annotations, and validated library-PDF discovery/read operations. The XPI-bundled Zotkit query tools inspect a bounded local metadata snapshot. They do not perform writes.

PDF text, annotations, bibliographic fields, filenames, and model output are untrusted content. They may contain instructions intended to manipulate the model. Zotkit does not treat any of that content as user approval. In Ask mode it cannot activate a write path. In Agent mode a model may prepare a proposal, but it cannot click Apply or approve its own command request.

Library-file tools reject hidden components, traversal, non-PDF files, off-root canonical paths, and symlinks, and cross-PDF text access requires a unique match to an existing Zotero attachment. Results, queries, page ranges, file sizes, and serialized outputs are bounded. These checks narrow accidental exposure; a user should still avoid configuring a library root that contains unrelated sensitive PDFs.

## Reviewed Zotero and PDF changes

Structured Agent mode exposes one mutation proposal tool, `zotero_propose_changes`. Calling it validates and displays a Diff but does not write. Only an explicit user **Apply** action can continue.

Supported operations are deliberately narrow:

- selected bibliographic fields on the active parent item;
- exact membership in existing collections from the same Zotero library;
- relinking an active linked-file attachment to an existing validated PDF;
- replacing the active PDF with a validated staged PDF from Zotkit's private workspace.

Immediately before Apply, Zotkit checks that the same paper is active and that its relevant metadata, collection membership, attachment path, and link mode still match the reviewed snapshot. A mismatch invalidates the proposal. Zotkit then creates a checkpoint and applies through Zotero item/collection/attachment APIs or an atomic temporary-file replacement for PDF bytes. If Apply throws, it attempts to restore that checkpoint. Recovery is best-effort: checkpoints are not a substitute for Zotero sync history, filesystem backups, or testing bulk changes on disposable data.

Checkpoints live below the mode-0700 `<Zotero Profile>/zotkit/checkpoints/` tree; manifests and PDF backups are restricted to the current user where the platform APIs permit it. Retention is bounded to 20 checkpoints and approximately 1 GiB of PDF backups, and an individual PDF larger than 512 MiB is refused. A PDF is copied only when an approved PDF replacement needs a recovery copy. Ordinary reading, metadata changes, collection changes, and relinking do not copy the original PDF. Restore creates a new undo checkpoint first, then restores the recorded Zotero state and, when present, PDF bytes.

Conversation checkpoints are different: they fork a Codex thread before an earlier turn. They restore conversation history, not files or Zotero data. Only mutation checkpoints restore an applied Zotero/PDF proposal.

## Local helper and process isolation

The native helper uses a mode-0600 Unix-domain socket inside a mode-0700 profile runtime directory rather than an unauthenticated TCP listener. It rejects pre-existing socket nodes, checks the connecting peer UID on supported macOS versions, and authenticates each connection using a fresh secret delivered through a restricted temporary file. Sensitive context and helper files are created with restrictive permissions where supported.

Helper, client, PTY, pipe, token, and directory descriptors are marked close-on-exec, and automated tests cover unintended descriptor inheritance and child cleanup. The helper also uses bounded HUP → TERM → KILL shutdown for owned children. These are defense-in-depth controls, not a claim that an agent process is isolated from every resource available to the logged-in user. The selected CLI, its configuration, and any user-installed MCP servers retain their own capabilities.

## Credentials and local state

Research Chat uses Codex app-server account methods and shares the installed Codex CLI's authentication. Zotkit does not need a Zotero Web API key for its local Reader/query workflow and does not directly read or copy `~/.codex/auth.json`, API keys, or browser cookies. Login UI can ask Codex to start or cancel its normal login flow; Codex remains the credential owner.

Generated context, one shared metadata snapshot per Zotero library, session history, staging files, and checkpoints are confined below `<Zotero Profile>/zotkit/`. Existing Zotero `.zotero-ft-cache` text is normally referenced in place. If an active attachment has no usable index, an explicit full-text operation may create one bounded, automatically pruned text fallback in the private workspace. Zotkit does not place generated context, indexes, prompts, or notes beside the original PDF.

The installable helper is locally ad-hoc signed. Public redistribution should use an Apple Developer ID signature and notarization. Install XPI files only from a source you trust, review every Diff and approval card, and keep independent backups before material library or PDF changes.
