/**
 * Compile-time only (never executed). Proves the hook returned by `mcpindexGate`
 * is assignable to Mastra's `beforeToolCall` slot, so a Mastra type change that
 * would break integration is caught by `npm run typecheck` here rather than in a
 * user's project. Uses the dev-installed `@mastra/core`; nothing ships from test/.
 */
import type { ToolHooks } from '@mastra/core/tools';
import { mcpindexGate } from '../src/index.js';

// If Mastra's beforeToolCall signature drifts from ours, this assignment errors.
const _hook: NonNullable<ToolHooks['beforeToolCall']> = mcpindexGate({ serverId: 'example' });
void _hook;
