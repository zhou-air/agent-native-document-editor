# Agent Document v2 MCP 与本地服务

WinUI 和 MCP 连接同一个本地文档服务。MCP 进程不直接写数据库，服务端负责生成身份、校验版本和原子提交。启动命令是 `node src/mcp.js`；发布包使用 `backend/node.exe backend/src/mcp.js`。`AGENTDOC_RUNTIME` 与 `AGENTDOC_PORT` 必须与 WinUI 一致。

## 定位与读取

| 工具            | 输入                                         | 返回                                           |
| --------------- | -------------------------------------------- | ---------------------------------------------- |
| `open_project`  | `path`                                       | 文档元数据及章节摘要；必要时先备份并迁移旧项目 |
| `project_info`  | 无                                           | 文档 ID、版本、提示等元数据                    |
| `list_sections` | 无                                           | 章节 ID、父章节、顺序、标题块 ID、版本与块数   |
| `read_section`  | `section_id`                                 | 指定章节及其有序 Block                         |
| `read_sections` | `section_ids`                                | 批量读取指定章节，最多 100 个                  |
| `list_blocks`   | `section_id`                                 | 指定章节的块摘要                               |
| `read_block`    | `block_id`                                   | 指定块内容与块版本                             |
| `get_changes`   | `since_revision`, 可选 `limit`, `section_id` | 指定文档版本之后的增量记录；可只传当前章节正文 |

已经知道 Block ID 时可直接 `read_block` 和 `update_block`，无需重查目录或搜索正文。Block 内容使用语义节点；`node` 是兼容编辑器的内容表达。允许 `markdown` 作为简易输入，但单块输入必须恰好生成一个顶层节点。

## 写入与版本

每个工具都接受可选 `project_id`。建议所有写入都传入读取得到的文档 ID，防止其他客户端切换活动项目后误写。

| 工具                            | 必要版本及关键参数                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `create_block`                  | `section_id`, `expected_revision` 为目标章节版本，`node` 或 `markdown`；可选 `after_id` / `before_id` |
| `update_block`                  | `block_id`, `expected_revision` 为块版本，`node` 或 `markdown`                                        |
| `delete_block`                  | `block_id`, `expected_revision` 为块版本                                                              |
| `move_block` / `copy_block`     | `block_id`, 源块 `expected_revision`, 目标 `section_id`, 目标章节 `target_revision`，可选 `before_id` |
| `replace_text`                  | `block_id`, 块 `expected_revision`, `old_text`, `new_text`；只允许一个精确匹配                        |
| `save_blocks`                   | `section_id`, `changed: [{block_id, expected_revision, node}]`；批量原子提交，任一冲突则整批拒绝      |
| `create_section`                | `title`, 文档 `expected_revision`，可选 `parent_id`, `before_id`                                      |
| `update_section`                | `section_id`, 章节 `expected_revision`, `title`                                                       |
| `move_section` / `copy_section` | `section_id`, 章节 `expected_revision`，可选 `parent_id`, `before_id`                                 |
| `delete_section`                | `section_id`, 章节 `expected_revision`；连同子章节和所属块删除                                        |

创建操作由服务生成 UUID；复制生成新的对象身份。移动保留身份。标题块与 Section 是独立身份；标题块不能单独移走或删除。

成功写入返回局部变更，主要字段如下：

```json
{
  "revision": 12,
  "documentRevision": 12,
  "changeId": "变更 ID",
  "changedBlocks": [],
  "changedSections": [],
  "deletedBlockIds": [],
  "deletedSectionIds": []
}
```

创建或单对象操作还可以返回 `block` / `section`。`revision` 是文档同步游标，各对象自身的 `revision` 才是对应写操作的并发控制版本。过期写入返回 MCP `isError: true`，文本结果中的 `code: 409`；原内容不被覆盖。重新读取目标对象后，由调用方决定如何合并。

`save_blocks` 还支持章节内的结构编辑：附带 `section_revision`、原顺序 `base_ids`、目标顺序 `order`，以及 `created: [{temporary_id,node}]` 和 `deleted: [{block_id,expected_revision}]`。服务将临时 ID 映射为新 UUID，并在 `idMap` 中返回映射。删除返回 `deletedBlockRevisions`；从已保存的撤销记录恢复历史对象时，可在 `created` 中指定 `restore_id` 和精确的 `expected_deleted_revision`。恢复必须匹配已有删除记录，不能复用活动对象 ID。普通创建仍由服务生成新 ID。

`undo_change` 接受 `change_id` 和当前文档 `expected_revision`，在目标对象没有后续修改时撤销整个操作。撤销同样产生新的版本和增量记录。

## 兼容迁移

- `insert_block` 保留，为 `create_block` 的兼容名称。
- `add_section` 保留，章节层级以 `parent_id` 为准。
- `write_section` 保留，以章节版本控制整体替换。传入既有节点 ID 可保留已有块身份；Markdown 全节替换会创建新的正文块身份，建议改为块操作。
- `export_project` 保留，仍输出内容 ZIP。`export_document` 默认输出真正的 DOCX，也接受 `format: "zip"`。
- 工具名和常用参数保留，但写入结果、`open_project` 返回值不再含整份正文。旧调用方应使用 `changedBlocks` / `changedSections` 更新缓存，并在需要时调用 `read_section`。这是需要迁移的返回契约变化。

## 导出

`export_document` 接受可选 `section_ids` 和 `format: "docx" | "zip"`，返回项目 `exports/` 下的绝对路径、字节数及格式。`export_project` 固定输出 ZIP。DOCX 是按结构化数据和独立导出模板生成的可编辑文件，不尝试恢复来源 Word 的局部排版。

## HTTP 与增量订阅

服务仅监听 `127.0.0.1`。运行目录的 `connection.json` 提供 URL 和认证令牌；所有端点使用 `Authorization: Bearer <token>`，SSE/资源读取也允许 URL `token` 参数。

| 端点                                             | 行为                                                         |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `GET /api/project`                               | `{project: manifest}` 或 `{project: null}`，章节摘要不含正文 |
| `GET /api/revision`                              | `{id, revision}`；兼容轻量版本轮询                           |
| `POST /api/open` / `/api/create`                 | 返回 manifest                                                |
| `POST /api/tool`                                 | `{name, args}`，与 MCP 共用 Store 操作                       |
| `GET /api/changes?since_revision=N&limit=100`    | 增量分页；可附 `project_id`                                  |
| `GET /api/events?since_revision=N&project_id=ID` | SSE 订阅，可用 `Last-Event-ID` 续传                          |
| `POST /api/export`                               | 默认 DOCX 字节流；`format: "zip"` 返回内容包                 |
| `POST /api/asset`                                | 上传图片到当前项目资源目录                                   |

SSE 的 `change` 事件携带单条变更，`id` 是文档 revision；`ready` 事件包含当前文档 ID 和版本；`project` 事件表示活动项目已切换，客户端应保存未提交草稿并重新加载目录。历史游标早于可恢复范围时发送 `reset`，客户端需要重新读取目录和活动章节。15 秒心跳仅发送注释，不读取或序列化正文。

重新连接时传最后成功应用的版本。`get_changes` 的 `hasMore` 为真时，继续使用本页最后一条记录的 `revision` 请求下一页。空闲查询返回空数组，不执行全文比较。客户端发现正在编辑的块有外部变化时应保留本地输入，以版本检查处理冲突。

`get_changes`、`GET /api/changes` 和 SSE `/api/events` 均支持可选 `section_id`。指定后，`changedBlocks` 仅包含当前章节的块正文；其他章节只发送摘要，不附 `blockIds` 和 `entries`，因此编辑其他章节的大表格不会把该表格正文传给当前视图。`movedBlocks` 保留轻量移动信息 `{id,fromSectionId,toSectionId,revision}`；`removedFromSectionBlockIds` 表示应从当前章节视图移除的块。真正删除的对象仍通过全局轻量 `deletedBlockIds` / `deletedSectionIds` 通知。

章节 scope 不改变文档级 revision：即使某次变更没有当前章节正文，客户端仍须前移游标。切换章节后应读取新章节，并以新 `section_id` 重新订阅。SSE 重连沿用相同章节参数；省略 `section_id` 时保持完整增量返回，兼容原有 MCP 工作流。
