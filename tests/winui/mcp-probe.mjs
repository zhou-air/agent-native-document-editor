import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [backendRoot, runtimePath, port, operation, inputPath, outputPath] = process.argv.slice(2);
const { Client } = await import(pathToFileURL(path.join(backendRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')));
const { StdioClientTransport } = await import(pathToFileURL(path.join(backendRoot, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')));
const client = new Client({ name: 'winui-native-acceptance', version: '1.0.0' });
let output;
try {
  await client.connect(new StdioClientTransport({
    command: path.join(backendRoot, 'node.exe'),
    args: [path.join(backendRoot, 'src/mcp.js')],
    env: { ...process.env, AGENTDOC_RUNTIME: runtimePath, AGENTDOC_PORT: port },
  }));
  if (operation === 'list') {
    output = await client.listTools();
    for (const name of ['open_project', 'project_info', 'list_sections', 'read_section', 'write_section', 'read_block', 'update_block',
      'insert_block', 'delete_block', 'replace_text', 'move_block', 'export_project']) {
      assert(output.tools.some((tool) => tool.name === name), `MCP tool was not registered: ${name}`);
    }
  } else {
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
    const response = await client.callTool({ name: operation, arguments: input });
    if (response.isError) throw Error(response.content.map((item) => item.text ?? '').join('\n'));
    output = JSON.parse(response.content.find((item) => item.type === 'text').text);
  }
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
} finally {
  await client.close();
}
