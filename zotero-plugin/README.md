# Zotkit — Zotero 里的 Codex 终端

Zotkit 在 Zotero 9 PDF Reader 的右侧 Item Pane 中运行真实的本机 Codex CLI。Codex 的工作目录是当前 PDF 所在目录；论文元数据、当前页和当前选区由只读 Reader MCP 持续提供。

## 安装

1. 构建或下载 `Zotkit-0.2.0.xpi`。
2. 在 Zotero 9 中选择“工具 → 插件”。
3. 点击右上角齿轮，选择“Install Add-on From File…”。
4. 选择 XPI；如侧栏未立即出现，重启 Zotero。

插件面向 macOS 12+ 与 Zotero 9.0.x。XPI 包含 arm64 / x86_64 universal 原生 helper，以及侧栏直接使用的只读 Zotkit 元数据 CLI/MCP。运行时不要求 Node.js、Python、`pipx`、Zotero Web API key 或 `~/.config/zotkit/env`。需要本机已有并登录过 `codex` CLI；Claude Code 模式另需 `claude` CLI。

插件 ID 是 `zotkit@oldantique.github.io`，它是独立的 Zotkit 插件，不沿用旧 ZoteroChat ID。若旧插件仍在本机，请先停用或移除，以免 Reader 中出现重复侧栏。

## 使用

- 在 Zotero 中打开 PDF，再展开右侧的“Zotkit Codex 终端”。只有这时 helper 和 Codex 才会启动。
- 终端就是完整 xterm.js + PTY：支持 Codex TUI、ANSI、CJK 输入、快捷键和 slash commands。
- Codex 以 PDF 原文件的父目录作为 `cwd`。如果 linked PDF 暂时不可用，才回退到 Zotero profile 中的小型上下文目录。
- 选中 PDF 文本后点击 `Ask in Zotkit`。插件会把论文标题、作者、年份、DOI、PDF 路径、目录、页码和可见选区原文插入终端，停在“问题：”后等待用户输入，不会自动按回车。
- 也可点击终端上方的“粘贴选区”或按 `⌘⇧J` 聚焦终端。
- 终端会同时注册 Reader 上下文与 XPI 内置的 Zotkit 文库元数据工具，不需要检测或安装外部 `zotkit` 命令。
- 每篇论文保留独立 session，最多保留 4 个；折叠后 15 分钟无用户操作的 session 会自动结束。

## 内置 Zotkit 文库工具

XPI 自带的只读元数据 MCP 直接向侧栏 Codex 提供四个工具：

```text
zotkit_find_items
zotkit_get_item
zotkit_list_collections
zotkit_list_tags
```

它们从 Zotero Desktop 的本地只读接口生成的有界快照中查找条目、读取条目元数据、列出 collections 和 tags。每个 Zotero 文库只维护一份共享快照，切换到同一文库中的其他论文时直接复用。它们不依赖仓库根目录中的 Python CLI，也不读取 `.env`、Web API key 或 WebDAV 凭据。

同一个内置查询层也以 `zotkit` 命令放进侧栏 Codex 的 `PATH`，绝对路径同时写入 `ZOTKIT_CLI`：

```text
zotkit find [--title TEXT] [--tag TAG] [--collection COLLECTION]
zotkit get ITEM_KEY
zotkit collections [--query TEXT]
zotkit tags [--query TEXT]
```

这是为 Reader 对话设计的 XPI 内置查询 CLI，并非仓库根目录中依赖 Python/Web API 的完整 headless CLI。`create`、`tag`、`move`、`attach`、`fetch`、`delete` 等写入或文件命令不会暴露给侧栏，并会被拒绝。

## 只读边界

Codex 固定使用：

```text
--sandbox read-only --ask-for-approval untrusted
```

插件不修改 Zotero item、collection、tag、attachment link、annotation、note、全文索引或原 PDF。它不会在 PDF 旁创建 `AGENTS.md`、配置、索引或笔记。

小型实时状态只写入：

```text
<Zotero Profile>/zotkit/
```

文库元数据按 Zotero library 共用一份有界快照；当前 Reader 状态原位更新。PDF、全文和整套文库数据不会按论文复制，因此阅读更多 PDF 不会产生一份份 PDF 副本。页面/选区快照有 64,000 字符上限；直接粘贴终端的选区限制为 32,000 字符，`get_current_selection` 仍可读取插件保留的有界快照。临时状态按数量与时间回收。

Reader MCP 只提供以下五个只读工具：

```text
get_active_paper
get_current_page
get_current_selection
list_library_files
search_library_files
```

当前页/选区两个文本工具读取插件维护的有界快照；文库工具只列出或搜索 PDF 文件名与相对路径。它不提供批注读取、任意 PDF 页读取、全文提取、Zotero 写入或任意文件访问。

## 架构

```text
Zotero Reader Item Pane
└── xterm.js
    └── authenticated local helper
        └── real PTY → codex / claude
            ├── cwd = dirname(original PDF)
            ├── zotero_reader MCP (live PDF context)
            └── bundled zotkit_library MCP (four read-only metadata tools)
```

## 构建与验证

```bash
npm ci
npm run check
npm test
npm run native:test
npm run build
```

构建产物位于 `dist/`，并同时生成 SHA-256 文件。构建 XPI 不需要安装仓库根目录的 Python 包；两者可以独立使用和发布。
