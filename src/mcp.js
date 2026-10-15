import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect, call, request } from "./connection.js";

const server = new McpServer({ name: "agent-document", version: "2.0.0" });
const id = z.string().min(1);
const version = z.number().int().positive();
const node = z.record(z.string(), z.any());
const content = {
  markdown: z.string().optional(),
  node: node.optional(),
  content: node.optional(),
};
const tools = {
  project_info: {
    description:
      "Read document identity, warnings and current revision, without document content.",
    shape: {},
  },
  list_sections: {
    description:
      "List stable Section IDs, hierarchy, title-block IDs and revisions; no block bodies.",
    shape: {},
  },
  read_section: {
    description: "Read one Section and its ordered Blocks by stable ID.",
    shape: { section_id: id },
  },
  read_sections: {
    description: "Batch-read requested Sections only, by stable IDs.",
    shape: { section_ids: z.array(id).min(1).max(100) },
  },
  read_block: {
    description:
      "Read one Block by stable ID, including semantic node content and its revision.",
    shape: { block_id: id },
  },
  list_blocks: {
    description:
      "List section root blocks and their revisions without full node content.",
    shape: { section_id: id },
  },
  create_block: {
    description:
      "Create one Block with a new server-generated ID. expected_revision is the target SECTION revision.",
    shape: {
      section_id: id,
      expected_revision: version,
      after_id: id.optional(),
      before_id: id.optional(),
      ...content,
    },
  },
  insert_block: {
    description:
      "Compatibility alias for create_block; a fresh server ID is always generated. expected_revision is SECTION revision.",
    shape: {
      section_id: id,
      expected_revision: version,
      after_id: id.optional(),
      ...content,
    },
  },
  update_block: {
    description:
      "Replace one Block's semantic content, preserving its ID. expected_revision is BLOCK revision. Returns only affected objects.",
    shape: { block_id: id, expected_revision: version, ...content },
  },
  delete_block: {
    description:
      "Delete one Block at expected BLOCK revision. A section's title Block cannot be deleted independently.",
    shape: { block_id: id, expected_revision: version },
  },
  move_block: {
    description:
      "Move one Block, preserving ID. expected_revision is BLOCK revision; target_revision is target SECTION revision.",
    shape: {
      block_id: id,
      expected_revision: version,
      section_id: id,
      target_revision: version,
      before_id: id.optional(),
      after_id: id.optional(),
    },
  },
  copy_block: {
    description:
      "Copy one Block into a Section with fresh server IDs. expected_revision is source BLOCK revision; target_revision is target SECTION revision.",
    shape: {
      block_id: id,
      expected_revision: version,
      section_id: id,
      target_revision: version,
      before_id: id.optional(),
    },
  },
  replace_text: {
    description:
      "Replace exactly one literal text match inside one Block, preserving other semantic content. Zero/multiple matches fail. expected_revision is BLOCK revision.",
    shape: {
      block_id: id,
      expected_revision: version,
      old_text: z.string().min(1),
      new_text: z.string(),
    },
  },
  save_blocks: {
    description:
      "Atomically save changed Blocks; each uses its BLOCK revision. Structural edits also supply order/base_ids/section_revision, created temporary IDs and deleted BLOCK revisions. Explicit tombstone restoration requires restore_id and expected_deleted_revision. One conflict rejects the complete batch.",
    shape: {
      section_id: id,
      changed: z
        .array(z.object({ block_id: id, expected_revision: version, node }))
        .max(1000)
        .optional(),
      section_revision: version.optional(),
      base_ids: z.array(id).optional(),
      order: z.array(id).optional(),
      created: z
        .array(
          z.object({
            temporary_id: id,
            node,
            restore_id: id.optional(),
            expected_deleted_revision: version.optional(),
          }),
        )
        .max(1000)
        .optional(),
      deleted: z
        .array(z.object({ block_id: id, expected_revision: version }))
        .max(1000)
        .optional(),
    },
  },
  create_section: {
    description:
      "Create a Section and its associated Heading Block with separate fresh server IDs. expected_revision is DOCUMENT revision.",
    shape: {
      title: z.string().min(1),
      expected_revision: version,
      parent_id: id.nullable().optional(),
      before_id: id.optional(),
    },
  },
  add_section: {
    description:
      "Compatibility alias for create_section. expected_revision is DOCUMENT revision. Hierarchy follows parent_id.",
    shape: {
      title: z.string().min(1),
      expected_revision: version,
      parent_id: id.nullable().optional(),
      level: z.number().int().min(1).max(9).optional(),
    },
  },
  update_section: {
    description:
      "Rename a Section through its Heading Block while preserving both identities. expected_revision is SECTION revision.",
    shape: {
      section_id: id,
      expected_revision: version,
      title: z.string().min(1),
    },
  },
  move_section: {
    description:
      "Move a Section with its descendants and blocks. expected_revision is SECTION revision; parent_id null moves to the root.",
    shape: {
      section_id: id,
      expected_revision: version,
      parent_id: id.nullable().optional(),
      before_id: id.optional(),
      target_revision: version.optional(),
    },
  },
  copy_section: {
    description:
      "Copy a Section subtree using fresh Section and Block IDs. expected_revision is source SECTION revision.",
    shape: {
      section_id: id,
      expected_revision: version,
      parent_id: id.nullable().optional(),
      before_id: id.optional(),
      target_revision: version.optional(),
    },
  },
  delete_section: {
    description:
      "Delete a Section subtree with its Blocks atomically. expected_revision is SECTION revision.",
    shape: { section_id: id, expected_revision: version },
  },
  write_section: {
    description:
      "Compatibility operation: replace one Section at expected SECTION revision. nodes with existing IDs retain them; Markdown creates new content IDs. Prefer update_block/save_blocks for precise edits.",
    shape: {
      section_id: id,
      expected_revision: version,
      markdown: z.string().optional(),
      nodes: z.array(node).optional(),
    },
  },
  get_changes: {
    description:
      "Read a bounded page of committed changes after a DOCUMENT revision. Optional section_id includes block bodies only from that section; other sections remain summaries and moved-out blocks appear in removedFromSectionBlockIds. Continue from the last returned change.revision when hasMore is true.",
    shape: {
      since_revision: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(1000).optional(),
      section_id: id.optional(),
    },
  },
  undo_change: {
    description:
      "Undo one committed operation if its affected objects have not changed since. expected_revision is the current DOCUMENT revision.",
    shape: { change_id: id, expected_revision: version },
  },
  export_document: {
    description:
      "Export an editable DOCX by default (or semantic ZIP package) into the project's exports directory; returns local path and byte count.",
    shape: {
      section_ids: z.array(id).optional(),
      format: z.enum(["docx", "zip"]).optional(),
    },
  },
  export_project: {
    description:
      "Compatibility tool: export a self-contained structured content ZIP into the project's exports directory; returns local file path.",
    shape: { section_ids: z.array(id).optional() },
  },
};
function result(data, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(data) }] };
}
for (const [name, tool] of Object.entries(tools)) {
  server.registerTool(
    name,
    {
      description: tool.description,
      inputSchema: {
        ...tool.shape,
        project_id: id
          .optional()
          .describe(
            "Document identity guard; recommended on every write to prevent accidental cross-project edits.",
          ),
      },
    },
    async (args) => {
      try {
        return result(await call(await connect(), name, args));
      } catch (error) {
        return result({ error: error.message, code: error.code || 400 }, true);
      }
    },
  );
}
server.registerTool(
  "open_project",
  {
    description:
      "Open or safely migrate a local project; starts the shared service if needed. Returns metadata and section summaries only. Use read_section/read_block for content.",
    inputSchema: { path: z.string().min(1) },
  },
  async ({ path }) => {
    try {
      return result(await request(await connect(), "/api/open", { path }));
    } catch (error) {
      return result({ error: error.message, code: error.code || 400 }, true);
    }
  },
);
await server.connect(new StdioServerTransport());
