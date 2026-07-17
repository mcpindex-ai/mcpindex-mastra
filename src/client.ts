/**
 * Fail-closed client for the mcpindex advisory trust API (no auth required).
 *
 * Design mirrors the reference impl in mcp-server-mcpindex/src/trust.mjs: any
 * network error, timeout, non-2xx, or unparseable body resolves to a synthetic
 * `UNVERIFIED`/`ERROR` verdict rather than throwing. The gate that consumes this
 * treats "couldn't verify" the same as "not verified", never silently trusting.
 */

import type { TrustVerdict, Directive, VerdictStatus } from './types.js';

const DEFAULT_API_BASE = 'https://mcpindex.ai';
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_MAX_CACHE_ENTRIES = 1024;

const KNOWN_DIRECTIVES: ReadonlySet<string> = new Set(['ALLOW', 'DENY', 'REVIEW', 'UNVERIFIED']);
const KNOWN_STATUSES: ReadonlySet<string> = new Set(['EVALUATED', 'PARTIAL', 'STALE', 'ERROR']);

export interface TrustClientOptions {
  /** Base URL of the mcpindex API. Default `https://mcpindex.ai`. */
  apiBase?: string;
  /** Per-request timeout in milliseconds. Default 3000. */
  timeoutMs?: number;
  /** Verdict cache TTL in milliseconds. Default 60000. Set 0 to disable. */
  cacheTtlMs?: number;
  /** Max cached verdicts before oldest-out eviction. Default 1024. */
  maxCacheEntries?: number;
  /** Override the fetch implementation (tests, custom agents). Default global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Clock injection for testing. Default `Date.now`. */
  now?: () => number;
  /** User-Agent header sent on requests. */
  userAgent?: string;
}

/** Build a synthetic fail-closed verdict. `reason` is surfaced in `honest_limits`. */
export function failClosedVerdict(
  serverId: string,
  toolName: string | null,
  reason: string,
): TrustVerdict {
  return {
    subject: { server_id: serverId, tool_name: toolName },
    status: 'ERROR' satisfies VerdictStatus,
    directive: 'UNVERIFIED' satisfies Directive,
    granularity: null,
    dimensions: [],
    expires_at: null,
    honest_limits: [reason],
    verdict_contract_version: 'unknown',
  };
}

/** Narrow an unknown JSON body to a TrustVerdict, or return null if it is not one. */
function coerceVerdict(body: unknown): TrustVerdict | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.directive !== 'string' || typeof b.status !== 'string') return null;
  // Fail closed on directive/status values outside the known contract enum: an
  // unrecognized directive from a buggy or compromised endpoint must not slip
  // through as a trusted verdict. A genuine contract expansion bumps the version.
  if (!KNOWN_DIRECTIVES.has(b.directive) || !KNOWN_STATUSES.has(b.status)) return null;
  if (typeof b.subject !== 'object' || b.subject === null) return null;
  // Trust the contract for the rest; missing arrays default to empty.
  return {
    subject: b.subject as TrustVerdict['subject'],
    status: b.status as VerdictStatus,
    directive: b.directive as Directive,
    granularity: (b.granularity as string | null) ?? null,
    dimensions: Array.isArray(b.dimensions) ? (b.dimensions as TrustVerdict['dimensions']) : [],
    expires_at: (b.expires_at as string | null) ?? null,
    honest_limits: Array.isArray(b.honest_limits) ? (b.honest_limits as string[]) : [],
    verdict_contract_version:
      typeof b.verdict_contract_version === 'string' ? b.verdict_contract_version : 'unknown',
  };
}

interface CacheEntry {
  verdict: TrustVerdict;
  expiresAt: number;
}

/**
 * Thin, fail-closed, TTL-cached client over the mcpindex advisory trust endpoints.
 */
export class TrustClient {
  private readonly apiBase: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly userAgent: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: TrustClientOptions = {}) {
    this.apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.userAgent = options.userAgent ?? '@mcp-index/mastra';
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError(
        'No fetch implementation available. Pass `fetchImpl` or run on Node >= 18.',
      );
    }
  }

  /** Verdict for a specific tool on a server. Fail-closed. */
  checkTool(serverId: string, toolName: string): Promise<TrustVerdict> {
    const path = `/api/v1/trust/tool/${encodeURIComponent(serverId)}/${encodeURIComponent(toolName)}`;
    return this.get(path, serverId, toolName);
  }

  /** Aggregate verdict for a whole server. Fail-closed. */
  checkServer(serverId: string): Promise<TrustVerdict> {
    const path = `/api/v1/trust/server/${encodeURIComponent(serverId)}`;
    return this.get(path, serverId, null);
  }

  private cacheKey(serverId: string, toolName: string | null): string {
    // Unambiguous encoding: distinct (server, tool) pairs, and server-scope
    // (toolName null) vs tool-scope, can never collide even when ids contain the
    // separator. A collision here would be a fail-OPEN (serving one tool's verdict
    // for another), the exact failure this trust gate must never have.
    return JSON.stringify([serverId, toolName]);
  }

  private async get(
    path: string,
    serverId: string,
    toolName: string | null,
  ): Promise<TrustVerdict> {
    const key = this.cacheKey(serverId, toolName);
    if (this.cacheTtlMs > 0) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > this.now()) return hit.verdict;
      if (hit) this.cache.delete(key); // reclaim the expired entry
    }

    const verdict = await this.fetchVerdict(path, serverId, toolName);

    // Only cache real (non-fail-closed) verdicts, so a transient outage does not
    // pin an UNVERIFIED result for the whole TTL.
    if (this.cacheTtlMs > 0 && verdict.status !== 'ERROR') {
      this.evictIfFull();
      this.cache.set(key, { verdict, expiresAt: this.now() + this.cacheTtlMs });
    }
    return verdict;
  }

  /**
   * Bound cache size. Tool names originate from the connected MCP server, which
   * may be untrusted, so an unbounded map is a memory-exhaustion vector. Map
   * preserves insertion order, so deleting the first key evicts oldest-first.
   */
  private evictIfFull(): void {
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchVerdict(
    path: string,
    serverId: string,
    toolName: string | null,
  ): Promise<TrustVerdict> {
    try {
      const res = await this.fetchImpl(`${this.apiBase}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
        // This is a trust oracle: refuse to silently follow a redirect to some
        // other host. A 3xx from a compromised/MITM'd endpoint fails closed.
        redirect: 'error',
      });
      if (!res.ok) {
        return failClosedVerdict(serverId, toolName, `mcpindex_http_${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (parseErr) {
        // A timeout that lands mid-body-read surfaces here as an AbortError;
        // label it as a timeout, not a parse failure.
        const reason = isTimeout(parseErr) ? 'mcpindex_timeout' : 'mcpindex_unparseable_response';
        return failClosedVerdict(serverId, toolName, reason);
      }
      const verdict = coerceVerdict(body);
      if (!verdict) {
        return failClosedVerdict(serverId, toolName, 'mcpindex_unparseable_response');
      }
      return verdict;
    } catch (err) {
      return failClosedVerdict(
        serverId,
        toolName,
        isTimeout(err) ? 'mcpindex_timeout' : 'mcpindex_unreachable',
      );
    }
  }
}

/** True for the DOMException that `AbortSignal.timeout` raises. */
function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TimeoutError';
}
