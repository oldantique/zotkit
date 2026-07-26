# 设计:阅读留痕(Paper Trail)+ Noting 综合笔记

> **修订 2026-07-26(用户决策,推翻下文"批注只写一次"):**
> 1. 批注 comment 改为**该锚点的完整对话逐字记录**(`Q: …` / `A: …` 逐轮原文,
>    总长上限 50000 字符,超出时截断并附"完整记录见对话面板"标记),
>    **每轮回答完成后重写一次**(仍走串行写入队列,每轮一次 saveTx)。
>    首轮"问题 + 要点"格式废弃;要点摘要仍用于问题清单等 UI 展示。
> 2. turnRange 扩展改为**按线程身份触发**:活跃线程存在 status=open 的锚点时,
>    每个完成的回合都扩展该锚点的 turnRange——不再依赖"带选区提问"路径
>    (修复浮窗打字追问不扩展区间、Noting 只取首轮的缺陷)。

日期:2026-07-25
分支:`feature/zotero-reader-codex-integration`(基于 `ad8bfd1`)
范围:仅 `zotero-plugin/`(TypeScript 前端;不涉及 macOS 原生 helper 与 Python CLI)
平台:macOS + Zotero 9 + Codex app-server(与分支现状一致,不在本轮扩展)

## 目标工作流

> 拿到一篇新论文,从前往后读。读到不懂处,选中那段文字直接开始 chat;觉得理解后继续往下读,这段问答自动以 **Zotero 高亮批注**保存在 PDF 对应位置。持续到读完,点击 **Note** 按钮,AI 基于全部聊天记录综合生成一份 **Markdown + LaTeX** 阅读笔记,以 `.md` 附件挂在对应 Zotero 条目下。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 高亮写入时机 | **首轮回答完成后自动写**;之后"已理解"只改状态,不再写批注 |
| 批注 comment 内容 | **问题原文 + 答案 2–3 句要点**;不嵌任何 ID(连接键是 annotationKey 本身) |
| Note 按钮产物 | **仅导入式 `.md` 子附件**(带 YAML front matter);Zotero note 渲染预览留到后续轮 |
| 现有每轮自动 note 同步 | **直接移除**(`note-sync.ts` 自动路径 + `noteSync` pref);存量 `zotkit-chat` note 不碰不删 |
| 写入架构 | **方案 1:确定性写入层**——模型零写权限,全部写入由用户手势触发、插件确定性代码执行 |

方案 2(扩展 `zotero_propose_changes` 让模型提案批注)被否:逐条审批毁掉自动保存手感,且让模型参与确定性动作徒增注入面。方案 3(影子锚点、Note 时批量补写)被否:阅读中 PDF 上无留痕,翻回前文无法辨认"这段问过";但吸收其合批思想用于写入队列。

## 产品语义变更(需同步修订文档)

CONTEXT.md 的 "read-only guarantee" 修订为:

> **模型无任何 Zotero 写权限;全部写入由用户手势触发、由插件确定性代码执行,且逐条可撤销。**

需要:更新 CONTEXT.md 词表、补一条 ADR(记录从"绝对只读"到"确定性写入层"的边界迁移及理由)。这是本设计唯一的产品承诺变更。

## 一、产品语义:三个层次

1. **Ask(局部理解)**:选中 → ⌘K/⌘L → 聊天。模型只读,与现状一致。
2. **Paper Trail(阅读留痕)**:每个"问过的位置" = 一条 Zotero 高亮批注 + 一条本地 AnchorRecord。批注是用户(跨设备)可见的痕迹;AnchorRecord 是聊天与 PDF 位置的绑定。有 `open / resolved` 两态。
3. **Noting(一次显式综合)**:Note 按钮 → 冻结输入快照 → AI 分节综合 → 本地校验 → 预览 → Apply → 导入式 `.md` 子附件。

## 二、数据模型:AnchorRecord

存入现有 `sessions.json`(按 paperKey 分组,沿用 `codex-service.ts` 的 `paperIdentity` = `libraryID-attachmentKey`):

```ts
interface AnchorRecord {
  anchorId: string;            // 本地唯一 ID
  libraryID: number;
  itemKey: string;             // 父条目 key
  attachmentKey: string;
  pdfSha256: string;           // 创建时的 PDF hash
  annotationKey?: string;      // 高亮写入成功后回填;是与 Zotero 批注的唯一连接键
  pageNumber: number;
  position: JsonValue;         // 选区 quads/rects,取自 ReaderSelection.position,原样保存
  selectedText: string;
  question: string;            // 用户首问原文
  answerSummary?: string;      // 2–3 句要点,可后补
  threadId: string;
  turnRange: [number, number]; // 该锚点对应的对话轮次区间
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
}
```

关键点:

- 批注 comment 保持干净(仅问题 + 要点),**annotationKey 即连接键**,不在 comment 里嵌 ID。
- 绑定永远用 `libraryID + itemKey + attachmentKey`,与"当前打开的 Reader 是谁"无关——这是防写错条目的根。
- `ReaderSelection` 已携带 `pageNumber`/`position`(`reader-context.ts`),现状只是没有随聊天保存;本设计把它在**发问瞬间**快照进待写 AnchorRecord。
- 同一锚点上的追问扩展其 `turnRange`;新的选区发问创建新锚点。

## 三、高亮写入路径(确定性写入层)

```
用户选中发问
→ 选区 position/quads/pageNumber/pdfSha256 立即快照进待写 AnchorRecord
→ 首轮回答完成(流式结束且该轮无 kind:"error" entry)
→ 写入目标完全由发问瞬间的快照决定,与"当前打开的 Reader 是谁"无关;
  写入前仅校验目标 attachment 仍存在且未被重链
→ 要点生成(见下,10 秒上限),超时/失败降级为答案首段截断
→ 串行写入队列:创建高亮批注
   - Zotero API:new Zotero.Item('annotation') → annotationType='highlight',
     annotationText=selectedText, annotationComment=问题+要点,
     annotationPosition=JSON.stringify(position), parent=attachment, saveTx
   - 颜色:专用色(默认紫 #a28ae5,设置可改);tags: zotkit-chat + zotkit-open
→ 回填 annotationKey 并持久化 AnchorRecord
→ 浮窗轻量确认 chip:「已留痕 · 第 N 页 · 撤销」
```

- **首次启用授权卡**:第一次将要写批注时,浮窗/侧栏弹一次确认卡(复用 round3-gates 的 consent card 设计):"zotkit 将在你提问的位置自动创建高亮批注,可随时在设置中关闭"。同意后写入 pref,不再打扰;拒绝则本会话只记 AnchorRecord(无批注),之后不再自动询问。
- **撤销**:确认 chip 的"撤销" = 删除该批注 + 移除 AnchorRecord,单条即时,无需审批流。
- **合批降压**(回应同步卡死疑点,见 memory:长 PDF 卡死与 zotero.org 同步相关):写入队列按条目串行 + 200ms 合并窗口;**每个问题默认只写一次批注**;追问后的要点刷新是批注侧栏上的可选手动动作,绝不自动改写已有批注。
- **要点生成**:首轮回答完成后向同一 Codex thread 追加轻量指令("用 2–3 句总结刚才回答的要点"),10 秒上限;超时/失败降级为答案首段截断,随后**一次性**写入批注——批注只写一次,不存在写后补写 comment 的路径。
- **模型零写权限**:Ask/Agent 模式的工具清单一律不含批注/附件写工具;写入只发生在上述插件代码路径。PDF 里的注入文本无法触达任何写操作。

## 四、阅读中的状态流

- **"已理解"按钮**(浮窗主按钮):收起浮窗 + AnchorRecord 置 `resolved` + 批注 tag 由 `zotkit-open` 换成 `zotkit-resolved`。不改批注内容(tag 替换是唯一一次后续写,同样走串行队列)。
- **侧栏"问题清单"区**:按页码列出本文全部锚点(● open / ✓ resolved);点击 → Reader 跳转到该批注位置 + 展开该段对话(浮窗定位到对应 turnRange)。
- **从批注回到对话**:`Zotero.Reader.registerEventListener("renderSidebarAnnotationHeader")` 给带 `zotkit-chat` tag 的批注加"继续对话"小按钮 → 呼出浮窗并载入该 anchor 上下文,追问追加到同一 thread 的对应语境。
- **重开 PDF**:现有 thread 恢复机制不变;问题清单由 sessions.json 的 AnchorRecord 重建。若检测到批注被用户在 Zotero 中手动删除(annotationKey 查无此批注),清单中该项标记"批注已删除",不再尝试重建。

## 五、Note 按钮流程(Noting)

侧栏顶部新增 **Note** 按钮(读完随时可点):

```
点击 Note
→ 冻结输入快照:条目元数据、attachmentKey、当前 pdfSha256、
  全部 AnchorRecord(含各自 Q&A 全文,从 thread 转录截取 turnRange)、
  用户自己的批注(zotero_list_annotations,排除 zotkit-chat)、未解决问题列表
→ 若任一锚点创建时的 pdfSha256 与当前不符:警告"论文文件已变化",用户选继续/取消
→ 独立综合 thread(只读,不复用聊天 thread)按模板生成 Markdown:
    # Citation / # One-sentence Takeaway / # Method /
    # Key Equations / # Reading Q&A / # Open Questions / # My Understanding
  - Reading Q&A 按页码排序,每条带 [p.N] 页码引用
  - Open Questions 来自 status=open 的锚点,单独成节,不得被写成结论
  - 公式统一 $...$ / $$...$$;对话中推导的公式必须标注"(推导)",与论文原文公式(带页码)区分
→ 本地确定性校验:Markdown 可解析 + KaTeX 逐式渲染检查;失败的公式替换为
  「[公式待核对:第 N 页]」并计数
→ 预览面板(复用现有 markdown 渲染管线):正文 + 统计条(锚点覆盖数、
  未解决问题数、待核对公式数)
→ 用户点 Apply
→ 导入式 .md 子附件写入(Zotero.Attachments.importFromFile 等价路径,父=条目):
  - 文件名:`<条目短引用>-reading-notes-<YYYYMMDD>.md`(如 `Smith2025-reading-notes-20260725.md`)
  - YAML front matter:itemKey、attachmentKey、pdfSha256、生成时间、模型、
    锚点数、未解决数、workflow 版本
  - 重跑默认新建版本;Apply 前列出已有 zotkit 笔记附件供选"新建 / 替换某版"
  - 写入失败原子回滚(临时文件先写后导入),不留半个附件
```

Apply 是唯一写入点;预览阶段零写入。综合 thread 超时/失败只影响预览,不影响任何 Zotero 数据。

## 六、移除旧 note 同步(第一刀,独立先行)

- 删除 `note-sync.ts` 的自动写入路径、`plugin.ts` 的 `onTurnCompleted → syncChatNote` 挂钩、`noteSync` pref 与相关 sidebar 状态提示。
- `markdownToNoteHtml` 等渲染工具保留(Noting 预览复用)。
- 存量带 `zotkit-chat` 标签的 note 一律不读不写不删。
- 效果:审查指出的 note 合并覆盖/错条目/流式半成品风险整体消失;每轮 saveTx 的同步流量归零。

## 七、测试与验收

- **错条目防线**:快速连开/切换多篇 PDF 并发发问,高亮永远落在发问瞬间快照的那篇(身份校验单测 + 集成压力用例)。
- 首轮回答含 error entry → 不写批注、不持久化 AnchorRecord;待写快照直接丢弃(用户重试提问时重新快照)。
- 撤销后:Zotero 无残留批注、sessions.json 无残留锚点。
- consent 拒绝后不再自动弹卡,且绝不写批注。
- "已理解"只发生 tag 替换,comment/颜色/位置字节不变。
- Note:pdfSha256 不符时默认拦截;Apply 失败无半个附件;.md 通过 Markdown parser + KaTeX 检查才可 Apply;重跑不静默覆盖旧版本。
- **静态保证**:模型工具注册表中不存在任何批注/附件写工具(单测断言工具清单)。
- 现有 float/sidebar/mutations 测试全绿;note-sync 相关测试随功能移除。

## 八、实施顺序

1. **六**:移除旧 note 同步(立刻消风险,diff 独立)。
2. **二 + 三**:AnchorRecord 数据模型 + 高亮确定性写入 + consent + 撤销。
3. **四**:resolved 状态、问题清单、批注侧栏"继续对话"。
4. **五**:Note 按钮全流程(快照 → 综合 → 校验 → 预览 → Apply)。
5. **文档**:CONTEXT.md 词表修订 + 新 ADR(确定性写入层边界)。
