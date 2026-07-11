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
zotkit create --file papers.json         # 建条目(默认演练,加 --apply 才执行)
zotkit attach --key AB12CD34 --pdf 论文.pdf   # 上传 PDF
zotkit fetch --key AB12CD34 --out downloads   # 下载 PDF
zotkit tag AB12CD34 topic:qaoa           # 打标签
zotkit status AB12CD34 read              # 阅读状态 to-read / reading / read
zotkit move AB12CD34 "Algorithms"        # 移动分类
zotkit backup                            # 全库 JSON 备份(批量操作前必做)
```

## 想连文献库一起整理?

我们把一套经过 300 篇文献实战的整理方法论写成了文档(分类当骨架、标签当血肉、
AI 并行分析 + 分批执行):[docs/organizing-with-agents.md](docs/organizing-with-agents.md)。
配套的标签规范可以写进 `conventions.toml`([示例](conventions.example.toml)),
之后 zotkit 会在代码层面拒绝所有违规标签——AI 想乱打标签也打不进去。

## 安全设计

写操作默认演练(`--apply` 才动真格)、每批 ≤50 条且带版本校验、`zotkit backup`
一条命令全库快照。注意:所有写入都会同步到 zotero.org 和你的全部设备,
大改之后记得在桌面端抽查一眼。

MIT 开源。问题请提 [GitHub Issue](https://github.com/oldantique/zotkit/issues)
(提 issue 时请附 `zotkit --version`,**不要**粘贴你的 API key 或 doctor 输出里的服务器地址)。
