# 数据契约 v2

## 项目目录

```text
document.sqlite            当前内容、组织、版本、历史与导出模板
document.sqlite-wal/-shm    数据库运行中可能存在
assets/                    本地图片
original/source.docx        导入原件归档
import-report.json          导入告警与身份重映射（导入项目）
migration-report.json       旧项目迁移校验结果
backups/v1-.../             自动备份的旧项目文件与资源
project.json/styles.json    迁移后保留的旧文件，不再更新
exports/                   MCP 导出的 DOCX / 兼容 ZIP
```

## 持久化实体

| 表 | 关键字段 | 用途 |
|---|---|---|
| documents | id, title, revision, styles, warnings, original, updated_at | 文档身份和提交版本；styles 为独立输出模板 |
| sections | id, parent_id, heading_block_id, position, revision | 组织关系，无重复标题文本 |
| blocks | id, section_id, position, type, content, revision | 单一归属的语义内容 |
| assets | path, media_type, bytes | 资源登记 |
| change_log | id, revision, operation, timestamp, data | 受影响行的前后值与局部通知信息 |
| revision_heads | id, revision | 删除后的版本记忆，防止恢复时复用旧版本 |

新对象用 UUID。旧有效且不冲突的 ID 原样保留；重映射写入报告。Section 标题块属于该节且位于首位。删除、移动标题请操作对应 Section。

`content` 示例：

```json
{"type":"paragraph","content":[{"type":"text","text":"H"},{"type":"text","text":"2","marks":[{"type":"subscript"}]},{"type":"text","text":"O"}]}
```

允许加粗、斜体、下划线、删除线、上下标、换行、代码和安全链接。表格为 `table→tableRow→tableCell/tableHeader`，单元格的 `rowspan/colspan` 表达合并关系，可包含多段落和图片。图片引用 `assets/` 相对路径。字号、字体、颜色、段距、原 XML 不进入正文。

## 读写 API 的显示适配

读取 Block 返回 `id/type/revision/sectionId/order/content`；为既有 WinUI/MCP 保留派生的 `node` 和 `markdown`。这些派生字段没有在数据库中重复存储。`node.attrs.id` 等于 Block ID，Heading 的 level 从 Section 层级计算。

章节摘要有 `id/parentId/headingBlockId/title/level/order/revision/blockCount`，按需章节读取增加 `blocks/blockIds/entries`。`entries` 才是 Block 与子章节混合顺序的权威；不要自行按标题编号排序。

写入返回：

```json
{"changeId":"uuid","documentRevision":12,"revision":12,"changedBlocks":[],"changedSections":[],"deletedBlockIds":[],"deletedSectionIds":[],"deletedBlockRevisions":{},"idMap":{},"movedBlocks":[]}
```

块更新校验块版本，章节结构校验章节版本，新建章节校验文档版本。章节版本表示其内容/子树发生过变化，因此对子孙修改后，旧父章节删除请求会冲突。多块保存是一项事务；其中一个版本冲突就全部回滚。

`save_blocks` 普通保存只带 `changed:[{block_id,expected_revision,node}]`。结构变化另带 `order/base_ids/section_revision/created/deleted`。新增对象由服务生成 ID 并返回 idMap；撤销已提交删除需 `restore_id/expected_deleted_revision`，只允许恢复匹配的历史块。

`get_changes` 按文档 revision 分页，使用最后已接收版本继续；历史保留局部前后值，不包含整篇快照。可指定 `section_id` 限定正文负载，其他章只传摘要及移动/删除身份。

输出模板含 `semantic.body/headings/table`、`pages[0].size/margins`。字体大小/段前后为 pt，页面与缩进为 twips，自动行距以 240 表示一倍、360 表示 1.5 倍。来源样式 ID、XML 和局部覆盖不会迁入模板。
