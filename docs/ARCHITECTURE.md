# 架构和基本选型

## 简短研究

- [SiYuan 块 API](https://github.com/siyuan-note/siyuan/blob/master/docs/API.md)：参考稳定块标识与 insert/update/delete/move 的精确定位方式，不复制其数据库或界面。这里的身份使用随机 UUID。
- [Tiptap UniqueID](https://tiptap.dev/docs/editor/extensions/functionality/uniqueid)、[Table](https://tiptap.dev/docs/editor/extensions/nodes/table)：成熟 ProseMirror 编辑器提供连续输入、历史、列表、表格操作。额外 IdentityRepair 插件解决 table split 克隆属性时残留重复 ID，并与同一历史事务绑定。
- [Pandoc 手册](https://pandoc.org/MANUAL.html)：适合标准格式转换和 reference-doc，但不是复杂 Word 局部样式与编号的完整无损层。本版不增加运行时 Pandoc 依赖，直接解析 OOXML，导出生成规则供 Agent 使用 Pandoc/python-docx 后处理。
- [Obsidian 文件导航](https://help.obsidian.md/Plugins/File+explorer)：仅参考清晰的目录导航与内容中心布局。Obsidian 本体不是开源项目，本项目不使用其闭源代码。
- [MCP 工具规范](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)：使用官方 TypeScript SDK 的 stdio transport，初始化和工具调用由真实 SDK 客户端验收。
- [Codex MCP 配置](https://developers.openai.com/codex/mcp/)：提供 command/args/env 的本地 stdio 配置。

## 单一权威数据路径

```text
Electron / Tiptap ──authenticated localhost HTTP──┐
                                                ├── Store ── project.json
Codex ── MCP stdio ── authenticated HTTP ────────┘             ├─ styles.json 镜像
                                                             ├─ assets/
                                                             └─ original/source.docx
```

MCP 进程只做协议适配，不单独读写项目 JSON。Electron 同样不直接保存内容。服务端单个进程同步完成比较版本和提交，磁盘项目锁防止第二个服务写入。服务取得监听端口后才打开最近项目，避免同时启动时非监听进程占住项目锁。

每次写入先复制当前状态，检查版本，修改并校验 ProseMirror schema 和 ID 唯一性；只有校验通过才写临时文件/fsync/原子重命名，最后更新内存。异常不会提交部分修改。styles.json 是可再生镜像，权威样式和正文一起保存在 project.json；镜像写入失败不破坏快照。

UI 按块对比本地基线，仅提交变化块及其版本。MCP 修改另一块时，UI 自动合并未触碰的远端块；同块冲突拒绝提交，保留编辑内容和本地草稿。结构调整需要章节版本一致。跨章节恢复要求项目版本一致。UI 每 700 ms 轮询版本，不需要持续传输全文。

## 身份规则

1. 新块随机 UUID，与文字、编号和顺序无关。
2. 修改、移动维持原 UUID；相同文字仍有不同 UUID。
3. 复制新建 UUID；拆分保留原块身份，另一部分新建身份。
4. 合并保留一方身份；撤销恢复同一历史中的原身份。
5. Tiptap 的 ID 插件配合表格 ID 修复插件；服务器再次验证全项目唯一性。
6. 顶层块保存 Markdown；富文本 JSON 为无损编辑表达，两者在提交中一起生成，禁止直接写不一致 Markdown/JSON。复杂表格使用 HTML + JSON 而非丢失合并信息。

## 本地边界

无账户、云端数据库、Agent 聊天或审查系统。原生桌面只暴露文件夹选择和关闭通知的窄 IPC；渲染进程无 Node 权限、开启 context isolation 和 sandbox。HTTP 检查令牌及 Host/Origin，内容安全策略拒绝外部脚本。图片采用本地相对路径。
