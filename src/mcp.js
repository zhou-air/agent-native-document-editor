import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { connect, call } from "./connection.js";
const server = new McpServer({ name: "agent-document", version: "0.1.0" });
const id = z.string(),
  version = z.number().int().positive();
const content = {
  markdown: z.string().optional(),
  node: z.record(z.string(), z.any()).optional(),
};
const tools = {
  project_info: {
    description: "Read active local project identity, warnings and revision",
    shape: {},
  },
  list_sections: {
    description: "List sections with stable IDs and revisions",
    shape: {},
  },
  read_section: {
    description: "Read section and complete blocks; returns section revision",
    shape: { section_id: id },
  },
  write_section: {
    description:
      "Replace a whole section at expected SECTION revision. Prefer nodes retaining existing attrs.id; Markdown replacement creates NEW block IDs. Prefer update_block for precise edits.",
    shape: {
      section_id: id,
      expected_revision: version,
      markdown: z.string().optional(),
      nodes: z.array(z.record(z.string(), z.any())).optional(),
    },
  },
  list_blocks: {
    description:
      "List section root blocks with markdown and BLOCK revisions; nested list/cell nodes remain in root content",
    shape: { section_id: id },
  },
  read_block: {
    description:
      "Read root block node, markdown, source formatting and BLOCK revision",
    shape: { block_id: id },
  },
  update_block: {
    description:
      "Replace one root block retaining its ID at expected BLOCK revision. node preserves complex content; markdown must be exactly one root node.",
    shape: { block_id: id, expected_revision: version, ...content },
  },
  insert_block: {
    description:
      "Insert root block with fresh IDs. expected_revision is SECTION revision; after_id optional, default append",
    shape: {
      section_id: id,
      expected_revision: version,
      after_id: id.optional(),
      ...content,
    },
  },
  delete_block: {
    description: "Delete exactly one root block at expected BLOCK revision",
    shape: { block_id: id, expected_revision: version },
  },
  replace_text: {
    description:
      "Replace exactly one literal match within a root block, preserving formatting and other text. Zero/multiple matches fail. expected_revision is BLOCK revision.",
    shape: {
      block_id: id,
      expected_revision: version,
      old_text: z.string().min(1),
      new_text: z.string(),
    },
  },
  move_block: {
    description:
      "Move a root block retaining ID; expected_revision is BLOCK revision, target_revision is target SECTION revision",
    shape: {
      block_id: id,
      expected_revision: version,
      section_id: id,
      target_revision: version,
      before_id: id.optional(),
    },
  },
  export_project: {
    description:
      "Export self-contained Markdown/JSON/styles/assets ZIP to project exports directory; returns local file path",
    shape: { section_ids: z.array(id).optional() },
  },
};
for (const [name, t] of Object.entries(tools))
  server.registerTool(
    name,
    { description: t.description, inputSchema: t.shape },
    async (args) => {
      try {
        const c = await connect();
        const result = await call(c, name, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (e) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: e.message, code: e.code || 400 }),
            },
          ],
        };
      }
    },
  );
server.registerTool(
  "open_project",
  {
    description:
      "Open an existing local project directory; also available without starting GUI",
    inputSchema: { path: z.string() },
  },
  async ({ path }) => {
    try {
      const c = await connect();
      const r = await fetch(c.url + "/api/open", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + c.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      });
      const data = await r.json();
      return {
        isError: !r.ok,
        content: [{ type: "text", text: JSON.stringify(data) }],
      };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: e.message }] };
    }
  },
);
await server.connect(new StdioServerTransport());
