# 数据、MCP 和导出包格式

## 本地项目 v1

```text
project/
  project.json          唯一权威快照
  styles.json           权威快照中 styles 的查看镜像
  assets/<uuid>.png      所有图片资源
  original/source.docx  导入的完整原件（可选）
  exports/*.zip         MCP 生成的内容包
```

```json
{
  "formatVersion": 1,
  "id": "document-uuid",
  "title": "安全设施设计专篇",
  "revision": 12,
  "sections": [{
    "id": "section-uuid", "title": "1.1 设计依据", "level": 2,
    "parentId": "parent-section-uuid", "order": 0, "revision": 4,
    "blocks": [{
      "id": "block-uuid", "type": "paragraph", "sectionId": "section-uuid",
      "order": 0, "revision": 3,
      "markdown": "设计压力 **1.6 MPa**。",
      "node": {"type":"paragraph","attrs":{"id":"block-uuid"},"content":[{"type":"text","text":"设计压力 "},{"type":"text","text":"1.6 MPa","marks":[{"type":"bold"}]},{"type":"text","text":"。"}]},
      "source": {"styleId":"Normal","local":{},"runs":[],"xml":"原始段落 OOXML"}
    }]
  }],
  "styles": {}, "warnings": [], "original": "original/source.docx"
}
```

这里的 ID 示例是占位符，实际新建均为 UUID v4。前言使用 level=0。表格 node 包含 tableRow → tableCell → paragraph/image 等树形节点；表格单元格 attrs 的 `rowspan/colspan` 对应 `vMerge/gridSpan`。嵌套节点有 UUID，父子关系由 content 数组表达，数组顺序即子节点顺序。每个章节的顶层块额外保存 order 和 sectionId。

## styles.json

- `defaults`：Word docDefaults。
- `semantic`：实际使用的正文字体/段落、各级标题、题注和表格通用规则。UI 中修改这些规则用于最终 Word 生成。
- `definitions`：原始命名样式、basedOn、outlineLevel、字体/段落/表格信息及完整 XML。
- `localOverrides`：以块或嵌套段落 UUID 为键，保存来源 styleId、局部 pPr、各 run 的 rPr、编号元数据、原始 XML。
- `pages`：页面尺寸、方向、页边距及 sectPr XML。
- `units`：字体和段距为 pt；页面值为 Word twips。行距保留原始 `line` 和 `lineRule`，auto 为 240 分之一行；缩进保留 OOXML 原始单位。

`null` 表示此层未设置，`false` 表示显式取消，如关闭加粗；不能混为一谈。来源局部覆盖记录用于还原导入来源，编辑后的内容以 node/markdown 为准，不应让旧 XML 覆盖新文字。预设只包含 semantic/pages，不应携带旧文档的局部覆盖。

## MCP 工具

| 工具 | 定位 / 版本 | 内容 |
|---|---|---|
| project_info | 无 | 项目名称、ID、路径、项目版本与警告 |
| open_project | path | 打开已有项目，自动启动服务 |
| list_sections | 无 | 章节、层级、父章节、章节版本 |
| read_section | section_id | 章节及全部直属块 |
| write_section | section_id + 章节 expected_revision | nodes（保留 ID）或 Markdown（新建 ID） |
| list_blocks | section_id | 直属块概览、Markdown、块版本 |
| read_block | block_id | 完整节点和来源格式 |
| update_block | block_id + 块 expected_revision | 单一顶层 node 或 Markdown，保留目标块 ID |
| insert_block | section_id + 章节 expected_revision | after_id 可选，缺省追加；分配新 ID |
| delete_block | block_id + 块 expected_revision | 删除指定直属块 |
| replace_text | block_id + 块 expected_revision | old_text / new_text，必须唯一字面匹配 |
| move_block | block_id + 块 expected_revision | section_id + target_revision；before_id 可选 |
| export_project | section_ids 可选 | 返回项目 exports/ 下生成 ZIP 的绝对路径 |

错误通过 MCP `isError` 和文本 JSON 返回，版本冲突 code=409。MCP 写操作返回已提交后的项目快照。一次调用是一项原子操作，不保证多个工具调用组成跨调用事务。禁止忽略冲突后盲目用新版本重试旧内容。

## 导出 ZIP

```text
 document.md          所选章节的完整 Markdown
 structure.json       同一项目快照，sections 按导出范围筛选
 styles.json          语义规则、定义、覆盖与页面设置
 export-rules.md      不得概括/修改技术数据、保留所有内容的强制生成规则
 word-prompt.txt      简短 Word 生成提示词
 assets/              项目资源（相对路径，包含未使用资源）
 original/source.docx 原始 Word 参考（如有）
```

简单表格输出管道表格；有 rowspan/colspan 的表格保持 HTML，structure.json 同时保留无损节点树。导出可以移到另一台机器使用，不依赖原目录、联网资源或原始 Word 所在的外部路径。选节导出不裁剪原始 Word 或全局样式；不要把它作为涉密材料脱敏工具。
