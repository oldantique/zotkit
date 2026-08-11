# zotkit 中文速览

[English](README.md) | **简体中文**

**不打开 Zotero,也能管理你的文献库。**

zotkit 是一个命令行工具 + Python 库,直接对接 Zotero Web API:搜索、建条目、打标签、
归类、传 PDF,全程不需要 Zotero 桌面端。Mac / Windows / Linux 通用。
完整文档见 [英文 README](README.md)(权威版本);本页只讲最快上手路径。

## 最省事的用法:交给你的 AI

如果你在用 Claude Code / Cursor 之类的 AI 编程助手,只需要把本仓库链接发给它:

> 读一下 github.com/oldantique/zotkit,帮我配置并管理我的 Zotero 文献库

仓库里的 [AGENTS.md](AGENTS.md) 会告诉它怎么安装、怎么陪你完成配置、以及安全守则
(动手前备份、默认演练模式、绝不打印你的密钥)。配置好之后,你只需要说人话:
"把这篇 arXiv 论文存进库里,归类打标签,PDF 也传上去"。

## 手动安装与配置

```bash
pipx install zotkit        # 或 pip install zotkit / uv tool install zotkit
# 国内网络可用镜像:pip install -i https://pypi.tuna.tsinghua.edu.cn/simple zotkit
```

需要 Python 3.11+。然后把 [`.env.example`](.env.example) 复制为 `.env`(放当前目录、
`~/.config/zotkit/env` 或 `$ZOTKIT_ENV` 指向的路径),填三样东西:

1. **API key**:去 <https://www.zotero.org/settings/keys> 创建(勾选写权限),
   同一页能看到你的数字 userID,填进 `ZOTERO_LIBRARY_ID`。
2. **附件存储(二选一)**:
   - 用 **Zotero 官方存储**:什么都不用填,`WEBDAV_*` 三行直接删掉;
   - 用 **WebDAV**(坚果云等):打开任一台电脑上的 Zotero 桌面端 →
     设置 → 同步 → 文件同步,把 WebDAV 的地址、用户名、密码原样抄过来,
     地址末尾**补上 `/zotero/`**。
3. 配完跑一句体检,全绿就绪:

```bash
zotkit doctor
```

## 常用命令

```bash
zotkit find --title "boson sampling"     # 搜索(也可 --tag / --collection)
zotkit find --any vaswani                # 全字段搜索:标题+摘要+作者+标签+extra;
                                         #   建 create 前用 --any <一作姓氏> 查重
zotkit show AB12CD34 EF56GH78            # 按 key 查条目,一行一条(只读;
                                         #   --json 输出完整数据;key 不存在则
                                         #   报错到 stderr 且退出码为 1)
zotkit create --arxiv 2401.12345         # 抓 arXiv 元信息建条目(默认演练;
                                         #   --apply 执行并自动下载附上 PDF)
                                         # 已正式发表(带期刊 DOI)的文章会自动
                                         #   按期刊记录建(version of record),
                                         #   Extra 里保留 arXiv: <id>;PDF 仍来自 arXiv
                                         # 预印本仓库自有 DOI(arXiv/SSRN/bioRxiv 等
                                         #   前缀)不算期刊 DOI,不会误触发升级
zotkit create --arxiv id1 id2 id3 --apply  # 批量:元信息合并一次请求,
                                         #   PDF 下载自动按 arXiv 限速间隔
zotkit create --doi 10.1038/nature14539  # 按 DOI 从 CrossRef 抓元信息(不下 PDF;
                                         #   同样可一次给多个 DOI)
zotkit create --file papers.json         # 从 JSON 批量建条目(默认演练,加 --apply 才执行)
                                         # 建条目默认按 DOI / 标题查重并跳过重复项;
                                         #   演练输出会直接标出「已在库中,key 是哪个」,
                                         #   确要重复创建才加 --no-dedup
zotkit enrich --key AB12CD34             # 就地补全已有条目的缺失字段(摘要/DOI/
                                         #   被截断的作者表;--rebuild-record 可把
                                         #   已见刊的 preprint 就地升级为期刊记录)
                                         #   item key 永不改变——下游引用不受影响
zotkit enrich --missing abstract --apply # 批量:只跑缺摘要的条目(还有 --missing doi
                                         #   / --all;限速在内部,调用方无需分批睡眠)
zotkit audit                             # 只读体检报告:缺摘要/缺 DOI/缺 PDF/
                                         #   abstract-source 戳的健康度(--json 给 agent)
zotkit abstract --key AB12CD34 --source cnki --file abs.txt
                                         # 粘贴摘要并记录出处(owner 工具;文本自动
                                         #   清洗;已有摘要需 --force 才会替换)
zotkit attach --key AB12CD34 --pdf 论文.pdf   # 上传 PDF
zotkit fetch --key AB12CD34 --out downloads   # 下载 PDF(不给 --out 时默认存到
                                         #   ./downloads;若当前目录在 git 仓库里会
                                         #   提示改用仓库外的明确路径)
zotkit export --key AB12CD34 EF56GH78 -o refs.bib
                                         # 导出 BibTeX(cite key 一律改写成
                                         #   Zotero item key;key 也可从 stdin 逐行给)
zotkit tag AB12CD34 topic:qaoa           # 打标签
zotkit status AB12CD34 read              # 阅读状态 to-read / reading / read
zotkit move AB12CD34 "Algorithms"        # 移动分类
zotkit backup                            # 全库 JSON 备份(批量操作前必做)
```

## zotkit 家族

两个各自独立、互为补充的项目,单用哪个都行,一起用更顺:

| | 是什么 |
|---|---|
| **zotkit**(本仓库) | 无头 Python CLI + 库。哪儿都能跑,不需要开 Zotero 客户端。 |
| **[zotkit-reader](https://github.com/oldantique/zotkit-reader)** | Zotero 阅读器侧边栏,在你正读的 PDF 旁边嵌入 Codex/Claude 助手。由 [@ChanceSiyuan](https://github.com/ChanceSiyuan) 维护。 |

两者共享名字和理念,但不共享代码:zotkit-reader 可以通过 MCP 调用 zotkit 做全库操作,
但谁都不要求另一个必须装上。

## 想连文献库一起整理?

我们把一套经过 300 篇文献实战的整理方法论写成了文档(分类当骨架、标签当血肉、
AI 并行分析 + 分批执行):[docs/organizing-with-agents.md](docs/organizing-with-agents.md)。
配套的标签规范可以写进 `conventions.toml`([示例](conventions.example.toml)),
之后 zotkit 会在代码层面拒绝所有违规标签——AI 想乱打标签也打不进去。

## 安全设计

批量写操作(create/enrich)默认演练(`--apply` 才动真格)、每批 ≤50 条且带版本校验、`zotkit backup`
一条命令全库快照。注意:所有写入都会同步到 zotero.org 和你的全部设备,
大改之后记得在桌面端抽查一眼。

MIT 开源。问题请提 [GitHub Issue](https://github.com/oldantique/zotkit/issues)
(提 issue 时请附 `zotkit --version`,**不要**粘贴你的 API key 或 doctor 输出里的服务器地址)。
