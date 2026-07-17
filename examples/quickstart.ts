/**
 * Quickstart: gate a Mastra agent's MCP tool calls through mcpindex.
 *
 * Run shape (you provide the model + MCP tools):
 *   npm i @mcp-index/mastra
 *   tsx examples/quickstart.ts
 */
import { Agent } from '@mastra/core/agent';
import { mcpindexGate } from '@mcp-index/mastra';

// `warn` (default) never blocks - it just tells you what your agent is about to
// call and what mcpindex has vetted. Switch to `enforce` for a fail-closed gate.
const agent = new Agent({
  id: 'gated-agent',
  name: 'gated-agent',
  instructions: 'You are a helpful assistant with access to MCP tools.',
  model: 'openai/gpt-4o-mini', // your model here
  hooks: {
    beforeToolCall: mcpindexGate({
      serverId: 'your-mcp-server-id', // the mcpindex id of the server whose tools you call
      policy: 'warn',
      onVerdict: ({ toolName, verdict, action }) => {
        console.log(`[trust] ${toolName}: ${verdict.directive} -> ${action}`);
      },
    }),
  },
});

const res = await agent.generate('Do the thing that needs a tool.');
console.log(res.text);
