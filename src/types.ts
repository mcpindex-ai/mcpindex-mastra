/**
 * Types mirroring the mcpindex advisory trust contract (v1).
 *
 * Why hand-typed and not imported: the mcpindex verdict shape is a stable public
 * HTTP contract (`verdict_contract_version`), not a package we depend on. Pinning
 * it here keeps this integration zero-dependency and lets us fail closed without
 * pulling in the server SDK.
 */

/** The overall action recommendation on a subject. `ALLOW`/`DENY` are reserved in
 *  the v1 public contract - today the advisory screen only ever returns `REVIEW`
 *  or `UNVERIFIED`. `UNVERIFIED` is also what we synthesize when a call fails. */
export type Directive = 'ALLOW' | 'DENY' | 'REVIEW' | 'UNVERIFIED';

/** Evaluation status of the verdict itself. */
export type VerdictStatus = 'EVALUATED' | 'PARTIAL' | 'STALE' | 'ERROR';

/** Per-dimension verdict inside a screen. */
export type DimensionVerdict = 'PASS' | 'FAIL' | 'UNVERIFIED' | 'ERROR';

/** Severity of a failing dimension. */
export type Severity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface TrustDimension {
  id: string;
  verdict: DimensionVerdict;
  severity: Severity;
}

/** The response body of `GET /api/v1/trust/tool/{server}/{tool}` and
 *  `GET /api/v1/trust/server/{server}`. */
export interface TrustVerdict {
  subject: { server_id: string; tool_name: string | null };
  status: VerdictStatus;
  directive: Directive;
  granularity: string | null;
  dimensions: TrustDimension[];
  expires_at: string | null;
  honest_limits: string[];
  verdict_contract_version: string;
}

/**
 * How the gate reacts to a verdict.
 * - `warn` (default): never blocks a tool call. Logs and annotates. Pure
 *   visibility. Use this to see what your agent is about to call and what has
 *   been vetted, without changing behavior.
 * - `enforce`: fail-closed. Only an explicit `ALLOW` directive proceeds;
 *   `DENY`, `REVIEW`, and `UNVERIFIED` are all blocked. Note that under the v1
 *   public contract the API does not yet emit `ALLOW`, so `enforce` blocks
 *   every tool today. It becomes a real allow-list the moment mcpindex ships
 *   `ALLOW`/`DENY` verdicts - no code change on your side.
 */
export type GatePolicy = 'warn' | 'enforce';

/** What the gate decided to do with a specific tool call. */
export type GateAction = 'proceed' | 'block';

/** Passed to `onVerdict` and `blockedOutput` callbacks. */
export interface GateVerdictInfo {
  serverId: string;
  toolName: string;
  policy: GatePolicy;
  verdict: TrustVerdict;
  action: GateAction;
}
