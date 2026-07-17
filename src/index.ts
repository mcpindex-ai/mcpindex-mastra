/**
 * @mcp-index/mastra - a fail-closed mcpindex trust gate for Mastra agents.
 *
 * Primary entry point is {@link mcpindexGate}, a `beforeToolCall` hook factory.
 * {@link TrustClient} is exposed for direct verdict lookups or sharing a cache.
 */

export { mcpindexGate, directiveToAction } from './gate.js';
export type {
  McpindexGateOptions,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from './gate.js';

export { TrustClient, failClosedVerdict } from './client.js';
export type { TrustClientOptions } from './client.js';

export type {
  Directive,
  VerdictStatus,
  DimensionVerdict,
  Severity,
  TrustDimension,
  TrustVerdict,
  GatePolicy,
  GateAction,
  GateVerdictInfo,
} from './types.js';
