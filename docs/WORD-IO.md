# Word 内容导入与导出

Word 是内容交换格式，内部数据以 Document、Section、Block 为准。导入不保存原始 XML、字体继承链、段落排版或来源样式镜像；完整原 DOCX 仅归档在 `original/source.docx`。已有旧项目迁移保留旧模型中已保存的内容，不会自动恢复旧导入器曾经漏掉的内容。

## 导入

`importDocx(buffer, filename)` 返回语义章节、块、资源、警告及 ID 映射。Node 服务负责将这些数据写入项目数据库并保存原件和导入报告。

桌面“导入 Word”表示建立独立新项目：使用文件名作为项目名称、新建 Document ID、采用应用默认样式，保留导入器恢复的 Section/Block 身份和局部文字强调。底层导入器及未指定 `fresh_document` 的兼容创建接口仍保留原有身份恢复行为。

- 标题识别使用 Word 标题样式、样式继承和显式 outlineLvl；建立 Section 与独立 Heading Block。普通编号段落不会被当成章节。
- 段落保留文字、加粗、斜体、下划线、删除线、上下标、换行、制表符和安全链接。标题已有编号不重复添加；自动编号在导入时转成可读标题文本。
- 表格保留单元格的 `rowspan` / `colspan`、多自然段、内嵌图片及嵌套表格。纵向合并续接格若意外含正文，合并到主格并报告；不规则合并保留各格正文并告警。旧式 `hMerge` 不冒充已完整恢复。
- 图片按 DOCX 关系提取，重复引用复用资源。PNG/JPEG/GIF/BMP/WebP 为常用格式；EMF/WMF/TIFF/SVG 保留原文件并提示显示兼容性。外部链接图片不自动联网下载。
- 内容控件中的正文会继续解析。OLE 对象保留能提取的预览图片；文本框提取可读文字；公式保留可提取文本，并明确提示公式结构未恢复。
- 修订文字、动态域、页眉页脚、脚注尾注、批注、无法解析的绘图等都有对应提示。警告随文档保留；不能仅因导入成功就声称复杂 Word 内容全部无损。

DOCX 解压后的内容超过 150 MB 时拒绝导入。不能提取的复杂内容仍保存在归档原件中。

## 真正的 DOCX 导出

`exportDocx(project, { assetReader, template })` 返回可直接打开编辑的 `.docx` 字节。`Store.exportDocx()` 和服务的 `export_document` 使用此入口；旧内容 ZIP 导出保留为兼容入口。

导出按 `rootEntries` 与 Section 的混合 `entries` 顺序遍历；父节正文可以排列在子节之后。标题等级由 Section 的父子深度确定。正文、表格、图片分别生成 Word 段落、表格和 DrawingML 图片。表格横向/纵向合并分别使用 `gridSpan` / `vMerge`。基础列表使用标准 Word 编号；未实现的块或行内语义会拒绝导出，避免遗漏内容。缺失图片、孤立对象、重复归属和循环结构同样会阻止导出。

`DEFAULT_EXPORT_TEMPLATE` 在 `src/docx-export.js` 中定义默认输出模板。项目的独立 `styles` 模板可以替换它，支持：

- `semantic.body`：正文字体和段落规则。
- `semantic.headings[1..9]`：各级标题规则。
- `semantic.table`：表格文字规则。
- `pages[0].size` 与 `margins`：纸张及页边距，单位 twips。

字体大小及段前段后距使用 pt；段落 `line` 使用每行 240 分之一的值，`360` 表示 1.5 倍行距。模板不写入 Block 正文。用户可在 Word/WPS 中继续编辑样式和排版。当前不是任意 reference.docx 模板导入器。

## 稳定身份与 Word 往返

每个顶层块在 DOCX 中包裹标准块级内容控件，其 `w:tag` 携带 Block UUID。自定义 XML 数据部件仅保存 Document / Section 身份、归属、顺序和嵌套节点身份，不保存第二份正文。重新导入以 DOCX 正文为内容权威，恢复已存在的身份。复制出的重复 ID 或无效 ID 会生成新 UUID，并输出映射记录。

仅当 DOCX 中的块顺序、块类型与标题层级均未变化时，恢复原来的混合章节组织，包括父节在子节之后的尾段。Word 中发生跨章节移块、章节重排、标题新增、删除、晋级或降级后，导入器按**实际 DOCX 正文顺序与标题层级**重建章节，仍存在的身份继续复用；旧 metadata 不会把内容移回原位置，也不会复活已删除的标题，并会提示组织关系已重建。

未经过本程序导出的普通 DOCX 没有身份元数据，导入时会创建新 ID。在 Word 中删除内容控件或剥除自定义数据，会失去对应身份信息；导入器无法凭相同文字证明它是原来的块。一个带身份的控件被拆成多个块时，首块保留 ID，其余生成新 ID并提示。

## 已执行验证

`node --test tests/semantic-docx.test.js` 覆盖正文、章节树与混合顺序、ID、合并表格、图片原字节、上下标/链接、重复 ID、内容控件、公式提示、续接格文字、缺资源拒绝、模板隔离，以及 Word 中的跨章移动、标题删除/降级、新增标题和章节重排。`tests/migration-content.test.js` 另验证迁移的正文、ID、合并表格、图片、顺序、输出模板与导入映射报告。

2026-10-14 对真实旧项目的 251 节、1300 块、59 表格、9 引用图片生成了约 3.49 MB DOCX。程序导出后重新导入，全部 Section / Block ID 与逐块正文一致。独立 `python-docx` 成功打开，读取 59 表格、9 图片和 121641 个正文文本字符。

同一文件通过本机 **WPS 12.1.0.28043** 的 `kwps.Application` 以只读方式实际打开，识别 59 表格和 9 图片；另存新的 DOCX 副本后再导入，251 个 Section ID、1300 个 Block ID及全部逐块正文仍一致。只关闭测试文档，没有退出用户已有 WPS 进程。证据位于 `artifacts/refactor-20261014/wps-docx-open.json` 与 `wps-docx-roundtrip.json`。COM 返回的兼容名称是“Microsoft Word”，实际进程是 WPS，**因此本次不宣称已经在 Microsoft Word 中实际验证**。

本次验证证明结构、内容与 WPS 打开/保存路径有效；不等同于人工逐页排版审查，也不承诺恢复原文件的复杂 Word 样式。

## 实现依据

- Microsoft Open XML 文档：[块级内容控件 SdtBlock](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.sdtblock?view=openxml-3.0.1)。
- Microsoft Open XML 文档：[VerticalMerge 表格纵向合并](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.verticalmerge?view=openxml-3.0.1)。
- Microsoft Open XML 文档：[VerticalTextAlignment 上下标语义](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.wordprocessing.verticaltextalignment?view=openxml-3.0.1)。
