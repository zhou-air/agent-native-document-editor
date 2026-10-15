# Agent Document 0.2 · 结构化文档工作台

WinUI 3 原生 Windows 程序，供人类与 AI Agent 共同编辑。Block 保存内容，Section 组织章节，Document 管理文档；Word 用于导入和输出。Electron、浏览器编辑器和 Tiptap 已退出运行与发布路径。

## 使用

双击 **启动文档工作台.cmd**。可运行程序和全部运行库在 `release/AgentDocument-WinUI-x64`；搬到其他电脑时复制整个文件夹。

- 启动显示应用内“最近项目”首页；点击项目打开，或通过“浏览已有项目”选择外部项目。浏览列表不会迁移旧项目，首次实际打开时才进行备份和迁移。
- 导入 DOCX 后自动用文件名创建项目，保存到应用 `projects/` 目录并进入编辑。同名文件重复导入会创建独立目录。
- 左侧选择章节，仅加载其直属内容块；可修改标题、调整章节父子关系、插入、复制、移动和删除块。
- 编辑后自动保存，`Ctrl+S` 立即提交。撤销、重做与草稿恢复保留版本检查。
- 内容块左侧按钮可选择整个块，再次点击取消；逐个点击可多选。表格单元格单击选中、双击编辑，Enter/F2 也可进入编辑，Esc 结束编辑。
- 顶部“布局与样式”统一编辑正文及标题 1～9 的字体、字号、加粗、对齐、行距、段前段后和首行缩进；点击“应用样式”后，编辑区及 Word 导出同步使用。行距仅提供单倍、1.5 倍和 2 倍，局部强调保留。
- **导出文档** 默认生成 Word `.docx`；页面设置和样式预设也从顶部进入。
- MCP 与桌面共用一个本地服务。并发修改同一块会拒绝覆盖并保留草稿。

## 数据与迁移

正文权威数据是项目内的 `document.sqlite`，图片在 `assets/`，原 DOCX 在 `original/`。不要在程序打开项目时只复制 SQLite 主文件；应先关闭服务或连同 WAL 文件一起备份。

推荐先迁移副本：

```powershell
node scripts/migrate-project.mjs "旧项目目录" "不存在的新副本目录"
```

备份、验证、回滚和限制见 [迁移说明](docs/MIGRATION.md)。默认启动进入首页；显式使用 `--project` 或启动脚本的 `-ProjectPath` 参数时直接打开指定项目。

## 构建与测试

开发环境为 Node 24（使用内置 SQLite）、.NET SDK 10、Windows App SDK。发布包自带 Node、.NET 和 WinUI 运行库。

```powershell
npm ci --ignore-scripts
npm test
npm run test:native
npm run package:win
./scripts/check-winui.ps1
```

源码：`src/` 文档服务/数据库/DOCX/MCP；`native/` WinUI 与共享客户端。无需 Vite 或浏览器构建。

文档：[架构](docs/ARCHITECTURE.md) · [数据契约](docs/DATA-FORMAT.md) · [MCP](docs/MCP.md) · [Word](docs/WORD-IO.md) · [性能](docs/PERFORMANCE.md) · [验收记录与限制](docs/REFACTOR-REPORT.md)。

本机 MCP 配置见 [codex-mcp.toml](docs/codex-mcp.toml)，未改动全局客户端配置。
