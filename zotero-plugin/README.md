# Zotkit — Zotero 里的 Cursor 风格 Research Chat

Zotkit 在 Zotero 9 PDF Reader 的右侧 Item Pane 中提供结构化 Research Chat。默认界面通过本机 `codex app-server` 使用 Codex，交互方式接近 Cursor 侧栏：固定输入框、Ask/Agent 模式、模型与思考强度、每篇论文的历史会话、Plan/Tool 卡片、审批卡片、Diff/Apply、Checkpoint，以及 Markdown/LaTeX 渲染。完整的 Codex 或 Claude Code PTY 终端作为高级功能保留。

插件会把当前论文的元数据、原 PDF 路径及所在目录、当前页、最近选区和用户主动添加的研究上下文交给 Codex。它不会把 PDF 复制成第二套论文库。

## 安装

1. 构建或下载 `Zotkit-<version>.xpi`。
2. 在 Zotero 9 中选择“工具 → 插件”。
3. 点击右上角齿轮，选择“Install Add-on From File…”。
4. 选择 XPI；如侧栏未立即出现，重启 Zotero。

插件面向 macOS 12+ 与 Zotero 9.0.x。XPI 包含 arm64/x86_64 universal 原生 helper，以及侧栏使用的 Zotkit 查询 CLI/MCP；运行时不要求 Node.js、Python、`pipx`、Zotero Web API key 或 `~/.config/zotkit/env`。本机需要已有 `codex` CLI。Research Chat 复用 Codex CLI 的登录状态；未登录时可在侧栏启动 Codex 的登录流程。高级 Claude Code Terminal 另需本机安装 `claude`。

插件 ID 是 `zotkit@oldantique.github.io`，不沿用旧 ZoteroChat ID。若旧插件仍在本机，请先停用或移除，以免 Reader 中出现重复侧栏。

`codex app-server` 仍是 Codex 的实验接口。Zotkit 会在连接失败或协议不兼容时显示错误和高级 Terminal 入口，而不是留下空白侧栏。

## Research Chat 使用方法

1. 在 Zotero 中打开 PDF，展开右侧的“Zotkit Research Chat”。helper 与 app-server 只在第一次使用时按需启动。
2. 在顶部确认当前论文、页码和已附加的上下文；需要时用 `@` 添加当前页、选区、这篇论文的批注或 PDF 文库。
3. 选择 Ask 或 Agent、模型和思考强度，在底部输入框提问。Enter 发送，Shift+Enter 换行。
4. Codex 的计划、工具调用、命令、审批和变更会以独立卡片显示；回答中的行内/块级 LaTeX 会直接渲染。
5. 历史会话按论文保存。切换 PDF 后会切换到对应论文的会话；可以新建、恢复或继续旧会话。

与 Cursor 对齐的 macOS 快捷键：

| 快捷键 | 行为 |
| --- | --- |
| `⌘I` | 打开并聚焦 Research Chat |
| `⌘L` | 把当前选区加入一个新会话；没有选区时打开 Chat |
| `⌘⇧L` | 把当前选区加入当前会话 |
| `⌘⇧J` | 打开并聚焦高级 Terminal |

Reader 文字选择弹窗中的 **Ask in Zotkit** 会把选区加入当前 Research Chat。插件传递的是可提取的纯文本，并限制长度；它不会用选中文字自动批准操作。

## Ask 与 Agent

### Ask：默认、只读

Ask 模式使用 Codex 的只读沙箱、关闭网络访问，并以 `approvalPolicy: never` 启动回合。它可以读取当前论文、页面、选区、批注、全文搜索结果和有界文库上下文，但不会获得写入工具，也不会向用户弹出“允许写入”来绕过只读模式。

### Agent：私有暂存区 + 明确审批

Agent 模式可在 `<Zotero Profile>/zotkit/` 下的私有论文工作区中创建或修改暂存文件。命令和文件审批显示在侧栏；插件拒绝 app-server 对原 PDF 目录的直接写入请求。论文原目录仍会作为研究上下文提供给 Codex，但不是 Agent 的可写根目录。

对真实 Zotero/PDF 状态的修改只有一条受控路径：

```text
Codex 调用 zotero_propose_changes
        ↓
Zotkit 校验当前论文、目标与操作
        ↓
侧栏显示 Diff（尚未写入）
        ↓
用户 Reject 或 Apply
        ↓
Apply 前创建 checkpoint，再执行写入
```

当前支持：

- 修改当前父条目的 `title`、`abstractNote`、`date`、`DOI`、`url`、`extra`；
- 把当前条目精确设置到同一文库中已存在的 collections；
- 重新链接 linked-file attachment（Zotero 管理的 stored attachment 不会被重链接）；
- 用 Zotkit 私有暂存区中的已验证 PDF 替换当前 PDF。

模型调用 `zotero_propose_changes` 只会产生提案，不能替用户点击 Apply。Apply 前还会再次核对当前打开论文及其快照；若条目或附件在 Diff 生成后发生变化，提案会失效。执行失败时插件会尝试自动恢复刚创建的 checkpoint。

Checkpoint 保存在插件私有目录并自动回收：最多保留 20 个；PDF 备份总量最多约 1 GiB，单个可替换 PDF 上限 512 MiB。只有 PDF 替换才复制一份原 PDF 作为恢复备份，普通阅读不会产生 PDF 副本。Restore 前还会创建一个反向 checkpoint。会话 checkpoint 通过 Codex thread fork 恢复对话边界，不等同于恢复文件；真实 Zotero/PDF 恢复使用上述变更 checkpoint。

## 当前上下文与文库查询

Research Chat 可以按需读取：

- 当前 attachment/父条目的标题、作者、年份、DOI、标签和路径；
- 当前页与最近一次文字选区；
- 当前 PDF 的有界全文搜索和按页读取；
- 当前 PDF 的批注；
- 已配置论文目录中的 PDF 名称/相对路径，以及与现有 Zotero attachment 唯一匹配的其他 PDF 的有界搜索/按页读取；
- 当前 Zotero 条目的元数据，以及已配置 PDF 文库中的受验证论文路径。

Research Chat 与高级 Terminal 共用的 XPI 内置 Zotkit 文库查询层提供：

```text
zotkit_find_items
zotkit_get_item
zotkit_list_collections
zotkit_list_tags
```

同一查询层也以 `zotkit` 命令放入高级 Terminal 的 `PATH`，绝对路径写入 `ZOTKIT_CLI`：

```text
zotkit find [--title TEXT] [--tag TAG] [--collection COLLECTION]
zotkit get ITEM_KEY
zotkit collections [--query TEXT]
zotkit tags [--query TEXT]
```

这是 XPI 自带、面向本地 Reader 的只读查询 CLI。它与仓库根目录中的 headless Python CLI 是地位相同但运行时独立的两个产品入口：前者无需 API key 并读取本机 Zotero 快照；后者通过 Zotero Web API/WebDAV 在 Zotero 外部管理文库。XPI 不会查找或调用外部 Python `zotkit`，内置查询 CLI 也不提供 `create`、`tag`、`move`、`attach`、`fetch` 或 `delete`。

文库元数据按 Zotero library 共用一份有界快照；当前 Reader 状态原位更新。插件优先引用 Zotero 已有的 `.zotero-ft-cache`。仅当附件没有可用全文索引且用户请求全文操作时，才会在插件私有目录生成一份有大小上限、会自动回收的文本回退。因此浏览更多 PDF 不会产生永久堆积的 PDF 副本。

## 高级 Terminal

点击顶部 Terminal 按钮或按 `⌘⇧J` 可切换到完整 xterm.js + PTY。它支持 Codex/Claude Code TUI、ANSI、CJK 输入、快捷键、slash commands 和可收起的 KaTeX 公式预览。Codex/Claude 的工作目录是当前 PDF 的原目录；linked PDF 不可用时才回退到插件私有目录。每篇论文保留独立 session，最多保留 4 个，隐藏且空闲 15 分钟后会自动结束。

高级 Terminal 与结构化 Research Chat 是不同的权限面。Codex Terminal 使用：

```text
--sandbox read-only --ask-for-approval untrusted
```

它默认只读，但用户可以在真实 Codex TUI 中批准一次升级；Claude Code 使用 `--permission-mode plan`，这不是操作系统沙箱。高级 Terminal 中由用户批准的任意 shell/MCP 写入不会经过 Research Chat 的 Diff/Apply/Checkpoint 卡片。需要可审阅、可恢复地修改 Zotero 或 PDF 时，应回到 Agent 模式并使用 `zotero_propose_changes`。

## 本地状态与凭据

小型上下文、会话、暂存和 checkpoint 状态位于：

```text
<Zotero Profile>/zotkit/
```

Codex 登录仍由本机 Codex 管理。插件通过 app-server 的账户接口发起或退出登录，但不直接解析、复制或保存 `~/.codex/auth.json`、API key 或浏览器 cookie。更完整的安全边界见 [SECURITY.md](SECURITY.md)。

## 架构

```text
Zotero Reader Item Pane
├── Research Chat（默认）
│   └── authenticated helper pipe → codex app-server
│       ├── Ask：read-only
│       ├── Agent：private staging workspace
│       ├── live Reader tools
│       └── zotero_propose_changes → Diff → Apply → Checkpoint
└── Advanced Terminal
    └── authenticated local helper → real PTY → codex / claude
        └── live Reader + bundled Zotkit query tools
```

## 构建与验证

```bash
npm ci
npm run check
npm test
npm run native:test
npm run build
```

构建产物位于 `dist/`，并同时生成 SHA-256 文件。构建 XPI 不需要安装仓库根目录的 Python 包；headless Python CLI 与 XPI 可以独立构建、使用和发布。
