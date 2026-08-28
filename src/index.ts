#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { SmartBillClient } from './client.ts';
import { loadConfig } from './config.ts';
import { allTools } from './tools/index.ts';
import { toCallToolResult, type ToolContext } from './tools/shared.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new SmartBillClient(config);
  const ctx: ToolContext = { client, config };

  const server = new McpServer({ name: 'smartbill', version: '1.0.0' });

  let registered = 0;
  for (const tool of allTools) {
    // A tool whose credentials are absent is not registered, so the model is never offered a
    // call that can only fail. The rest of the server still works.
    if (tool.api === 'v1' && !config.hasV1) continue;
    if (tool.api === 'v3' && !config.hasV3) continue;

    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      },
      async (args: Record<string, unknown>) => toCallToolResult(await tool.run(ctx, args)),
    );
    registered += 1;
  }

  // stdout is the MCP wire — every diagnostic goes to stderr.
  if (registered === 0) {
    console.error(
      'smartbill-mcp-server: no tools registered. Set SMARTBILL_EMAIL and SMARTBILL_TOKEN for API V1, and/or SMARTBILL_V3_TOKEN for API V3.',
    );
  } else {
    console.error(
      `smartbill-mcp-server: ${registered}/${allTools.length} tools registered (V1 ${config.hasV1 ? 'on' : 'off'}, V3 ${config.hasV3 ? 'on' : 'off'}).`,
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error('smartbill-mcp-server failed to start:', error);
  process.exit(1);
});
