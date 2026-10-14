# Agent Document · 本地结构化文档工作台

可运行的本地桌面软件，面向工程技术长文档。人类使用 Tiptap 连续编辑；Codex 等 Agent 使用标准 MCP 精确读写。同一个本地数据服务完成版本检查与原子提交。

## Windows 快速开始

1. 将 **AgentDocument-Windows-x64.zip 完整解压**到可写目录，例如 `D:\Apps\AgentDocument`。不要只复制 EXE。
2. 双击 `AgentDocument.exe`。便携版已包含运行库，不需要安装 Node、Python、Pandoc 或 Office。程序未签名。
3. 点击“导入 Word”，选择一个新的项目文件夹与 `.docx`；或点击“新建项目”。“打开项目”选择含 `project.json` 的文件夹。
4. 点击章节树切换章节。正文可连续输入、复制粘贴、Ctrl+B / Ctrl+I、Ctrl+Z / Ctrl+Shift+Z。500 毫秒防抖自动保存，Ctrl+S 立即保存。
5. 表格内可增删行列；按住 Shift 选择相邻单元格后点“合并”，选中合并单元格后点“拆分”。支持插入图片及粘贴图片文件。
6. 右侧点击内容块后可复制、插入、删除、上下移动、跨章节移动。跨章节移动支持立即撤销/重做；若其后已有其他持久化操作，会拒绝过期撤销而非覆盖新数据。
7. “样式”中编辑语义样式、页面设置；也可查看原始样式定义和局部覆盖。点击“保存 styles.json”提交。导入/导出预设只交换语义样式和页面规则。
8. “导出内容包”可导出全项目或当前章节，得到自包含 ZIP。把 ZIP 和包内 `word-prompt.txt` 交给 Agent 生成 Word。

`examples/工程文档验收样本.docx` 是独立生成的测试样本，不含真实客户资料。源码仓库不保存运行项目；如需演示项目，安装依赖后运行 `node scripts/seed.js`，再打开生成的 `examples/demo-project`。

**运行验收边界：**本次已实际运行 Linux Electron 桌面、Chromium UI 和真实 MCP 客户端。Windows x64 PE 程序已生成；未在 Windows 10/11 实机运行，也未进行代码签名、Windows 中文输入法或 Office 实机核验。详见 [测试报告](docs/TEST-REPORT.md)。

## Codex MCP 配置

将以下内容加入 Codex 的 MCP 配置，替换两处本机路径。TOML 单引号字符串保留反斜杠：

```toml
[mcp_servers.agent_document]
command = 'D:\Apps\AgentDocument\AgentDocument.exe'
args = ['D:\Apps\AgentDocument\resources\app.asar\src\mcp.js']
env = { ELECTRON_RUN_AS_NODE = "1" }
startup_timeout_sec = 30
tool_timeout_sec = 60
```

完整可复制文件见 `docs/codex-mcp.toml`。此进程使用 Electron 自带 Node 运行 MCP，不弹出第二个编辑器窗口。软件与 MCP 都会自动连接/启动同一个本地服务，**不需要手动启动两个程序**。关闭 GUI 后 MCP 仍可操作项目；无客户端请求 10 分钟后服务自动退出，下次自动恢复最近项目。

先调用 `project_info` 确认当前项目，必要时调用 `open_project` 并传入项目目录绝对路径。随后 `list_sections → list_blocks → read_block → replace_text/update_block`。写入前读取返回的版本。

```json
{"block_id":"从 read_block 返回的 UUID","expected_revision":3,"old_text":"设计压力为 1.6 MPa。","new_text":"设计压力为 1.8 MPa。"}
```

`replace_text` 旧文本必须恰好匹配一次；零匹配或多匹配报错。`expected_revision` 对块工具是**块版本**，对 `write_section/insert_block` 是**章节版本**。不要把项目版本传给块工具。

`write_section` 优先传 `nodes` 并保留现有 `attrs.id`；用整节 Markdown 替换会建立新块身份，这与修改已有块不同。精准局部编辑请使用块工具。

工具及数据规范见 [DATA-FORMAT.md](docs/DATA-FORMAT.md)。

## 从源码运行和打包

推荐 Node.js 22.12+ 或 24，npm。依赖版本锁定在 package-lock.json。

```sh
npm ci
npm run build
npm start
```

Linux 开发测试也可运行 `npm run serve`，浏览器需使用本地服务连接文件中的令牌登录；这个入口用于测试，桌面程序会自动处理。Windows 用户直接启动 EXE。

```sh
npm run package:win    # 输出 release/AgentDocument-win32-x64
npm run package:linux  # 输出 release/AgentDocument-linux-x64
```

打包脚本使用 Electron Packager，无需 Windows 编译器，因为应用代码是 JavaScript，Windows 运行库由 Electron 提供。WinUI 3 未采用：本开发环境为 Linux，没有 Windows SDK；用户已接受简洁的替代桌面技术。

重新生成测试 Word 需要开发依赖 `python-docx` 和 `Pillow`，运行应用不需要 Python：

```sh
python tests/make_fixture.py
npm test
npm run test:ui
node tests/performance.js
node tests/desktop.test.js
```

UI 测试默认使用 `/usr/bin/chromium`，可用 `CHROMIUM_PATH` 指定路径。桌面验收脚本使用已打包 Linux 程序和 `DISPLAY=:99`；在本环境通过 Xvfb 提供显示服务。测试都使用独立项目和独立端口，不修改用户项目。

## 本地文件和恢复

- 项目文件夹完全本地：`project.json`、`styles.json`、`assets/`、`original/source.docx`。
- `project.json` 是唯一权威快照；`styles.json` 是同一次提交后生成的可查看镜像。请通过界面修改样式，不能在程序打开时直接改磁盘 JSON 来绕开事务。
- 单一服务持有项目锁。版本比较、内容变更、校验、临时文件写入/fsync/原子重命名在同一串行事务完成。第二个数据服务不能同时打开同一项目。
- 自动保存成功才显示“已保存”。同块冲突时保留本地草稿，可下载 JSON；不会自动覆盖 Agent 写入。
- 原始 DOCX 永久保存在项目内，并随导出包带走。建议定期备份整个项目文件夹。
- 服务连接文件、日志、最近项目记录在 `%LOCALAPPDATA%\AgentDocument`。本地 HTTP 仅监听 `127.0.0.1:47831`，要求令牌并检查 Origin/Host，没有云请求、账户或遥测。
- 需要更换端口/运行目录时，GUI 和 MCP 同时设置 `AGENTDOC_PORT` / `AGENTDOC_RUNTIME`，否则无法访问同一个服务。

## 已知限制

- 这不是 Word 排版引擎。编辑区提供语义富文本，不复刻分页、浮动定位或每个字体细节；Word 样式留在 styles.json 中供生成使用。
- 合并表格保存为 HTML Markdown + JSON；普通表格用 Markdown。Word 修订、公式、脚注、页眉页脚、复杂绘图等不能完整编辑，检测后提示并保留原件。未知 OOXML 细节也可能需要人工对照，不能把导入成功当作 Word 完全等价转换。
- 多级 Word 列表保留编号元数据，当前视图按列表段显示并警告；非十进制/字母的特殊自动编号会提示核验，不支持完整 Word 编号排版。人工输入的标题编号原样保留。
- 导航支持 1–9 级章节；编辑器标题显示最多 6 级，更深层级仍在 structure.json 中保留。编辑节内标题不会自动拆成新章节，新增章节使用目录“＋”。
- MCP 的可操作块是章节直属块。表格、列表内部内容包含在该块的 node 中，内部节点也有 UUID；修改表格内部一段内容可用整块唯一 `replace_text` 或保留其他节点的 `update_block`。
- 撤销历史按当前编辑会话保存，重启或切换章节后不保留历史。文档数据与身份会保留。跨章节移动的撤销有版本保护。
- 目前仅单个活动项目，不提供多窗口多项目并行编辑或协作系统。
- JSON 原子快照适合中等规模工程文档；已实测 5,000 块，未进行百万块或超大图片压力测试。DOCX 解压限制 150 MB，请求限制 80 MB。
- 原始资料保留可能导致导出包包含未选章节的源 Word，以及项目中未使用的图片；选节导出不是隐私脱敏或资料裁剪功能。

## 代码入口

- `ui/main.js`、`ui/style.css`：界面与编辑行为，可独立调整布局。
- `src/store.js`：权威数据、版本事务、导出。
- `src/docx.js`：OOXML 解析、合并表格、样式提取。
- `src/content.js`：Markdown/HTML 与富文本表达。
- `src/service.js`：本地服务；`src/mcp.js`：标准 stdio MCP。
- `src/desktop.cjs`：Electron 桌面、原生文件夹选择、关闭前保存。

[选型与参考资料](docs/ARCHITECTURE.md) · [数据和导出格式](docs/DATA-FORMAT.md) · [测试结果](docs/TEST-REPORT.md)
