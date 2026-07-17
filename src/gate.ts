/**
 * `mcpindexGate` - a Mastra `beforeToolCall` hook factory that consults the
 * mcpindex advisory trust API before an agent invokes an MCP tool.
 *
 * Usage:
 *   const agent = new Agent({
 *     ...,
 *     hooks: { beforeToolCall: mcpindexGate({ serverId: 'my-mcp-server' }) },
 *   });
 *
 * The returned hook is framework-shaped but runtime-dependency-free: it reads
 * `toolName` from the hook context and returns `{ proceed: false, output }` to
 * block, or `undefined` to allow.
 */

import { TrustClient } from './client.js';
import type { GatePolicy, GateAction, GateVerdictInfo, Directive } from './types.js';

/** Minimal structural shape of Mastra's `beforeToolCall` hook context. We read
 *  only `toolName`; declaring it structurally keeps us decoupled from the exact
 *  Mastra version while still type-checking the field we use. */
export interface BeforeToolCallContext {
  toolName: string;
  input?: unknown;
}

/** Return value of a `beforeToolCall` hook: block the call (with a substitute
 *  tool output handed back to the model) or return nothing to proceed. */
export type BeforeToolCallResult = { proceed: false; output: unknown } | undefined;

export interface McpindexGateOptions {
  /** The mcpindex server id whose tools this agent calls. Required. */
  serverId: string;
  /** How to react to verdicts. Default `warn` (never blocks). See {@link GatePolicy}. */
  policy?: GatePolicy;
  /** Reuse an existing client (shares its cache). If omitted, one is created. */
  client?: TrustClient;
  /** mcpindex API base. Ignored if `client` is passed. Default `https://mcpindex.ai`. */
  apiBase?: string;
  /** Per-request timeout ms. Ignored if `client` is passed. Default 3000. */
  timeoutMs?: number;
  /** Verdict cache TTL ms. Ignored if `client` is passed. Default 60000. */
  cacheTtlMs?: number;
  /** Override fetch. Ignored if `client` is passed. */
  fetchImpl?: typeof fetch;
  /** Called after every verdict, whatever the action. Use for logging/metrics. */
  onVerdict?: (info: GateVerdictInfo) => void;
  /** Where non-proceed / non-ALLOW notices go. Default `console.warn`. */
  logger?: (message: string) => void;
  /** Substitute tool output handed to the model when a call is blocked.
   *  Default: a short explanatory string. */
  blockedOutput?: (info: GateVerdictInfo) => unknown;
}

/**
 * Decide the action for a directive under a policy. Fail-closed by construction:
 * under `enforce`, only an explicit `ALLOW` proceeds; everything else blocks.
 * Under `warn`, nothing ever blocks.
 */
export function directiveToAction(directive: Directive, policy: GatePolicy): GateAction {
  if (policy === 'warn') return 'proceed';
  return directive === 'ALLOW' ? 'proceed' : 'block';
}

function defaultBlockedOutput(info: GateVerdictInfo): string {
  const limits = info.verdict.honest_limits.join(', ') || 'none';
  return (
    `mcpindex blocked tool "${info.toolName}" on server "${info.serverId}": ` +
    `directive=${info.verdict.directive} (policy=enforce). This tool is not cleared for use. ` +
    `honest_limits: [${limits}]`
  );
}

/**
 * Build a `beforeToolCall` hook that gates tool calls through mcpindex.
 * Returns an async function you drop into `new Agent({ hooks: { beforeToolCall } })`.
 */
export function mcpindexGate(options: McpindexGateOptions) {
  const { serverId, policy = 'warn', onVerdict, blockedOutput = defaultBlockedOutput } = options;
  const log = options.logger ?? ((m: string) => console.warn(m));
  const client =
    options.client ??
    new TrustClient({
      apiBase: options.apiBase,
      timeoutMs: options.timeoutMs,
      cacheTtlMs: options.cacheTtlMs,
      fetchImpl: options.fetchImpl,
    });

  return async function beforeToolCall(
    context: BeforeToolCallContext,
  ): Promise<BeforeToolCallResult> {
    const { toolName } = context;
    const verdict = await client.checkTool(serverId, toolName);
    const action = directiveToAction(verdict.directive, policy);
    const info: GateVerdictInfo = { serverId, toolName, policy, verdict, action };

    onVerdict?.(info);

    if (action === 'block') {
      log(
        `[mcpindex] BLOCKED "${toolName}" on "${serverId}" - directive=${verdict.directive}, ` +
          `status=${verdict.status}`,
      );
      return { proceed: false, output: blockedOutput(info) };
    }

    if (verdict.directive !== 'ALLOW') {
      // warn mode, or ALLOW not yet emitted: proceed but surface the notice.
      log(
        `[mcpindex] tool "${toolName}" on "${serverId}" is ${verdict.directive} ` +
          `(policy=${policy}, allowing). honest_limits: [${verdict.honest_limits.join(', ')}]`,
      );
    }
    return undefined;
  };
}
