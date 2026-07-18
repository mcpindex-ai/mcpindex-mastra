// Runtime tests for the fail-closed trust client. Plain JS against built dist so
// there is no type-stripping / loader magic - `npm run build` then `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrustClient } from '../dist/index.js';

const REAL_VERDICT = {
  subject: { server_id: 'acme', tool_name: 'send_email' },
  status: 'EVALUATED',
  directive: 'REVIEW',
  granularity: 'tool',
  dimensions: [{ id: 'mcpindex.integrity.description', verdict: 'FAIL', severity: 'LOW' }],
  expires_at: null,
  honest_limits: ['advisory_deployment'],
  verdict_contract_version: '1.0.0',
};

function jsonFetch(body, status = 200) {
  return async () => new Response(JSON.stringify(body), { status });
}

test('parses a real verdict body', async () => {
  const client = new TrustClient({ fetchImpl: jsonFetch(REAL_VERDICT) });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'REVIEW');
  assert.equal(v.status, 'EVALUATED');
  assert.equal(v.dimensions.length, 1);
});

test('fail-closed on network error → UNVERIFIED/ERROR', async () => {
  const client = new TrustClient({
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'UNVERIFIED');
  assert.equal(v.status, 'ERROR');
  assert.deepEqual(v.honest_limits, ['mcpindex_unreachable']);
});

test('fail-closed on timeout → mcpindex_timeout', async () => {
  const client = new TrustClient({
    fetchImpl: async () => {
      throw new DOMException('timed out', 'TimeoutError');
    },
  });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'UNVERIFIED');
  assert.deepEqual(v.honest_limits, ['mcpindex_timeout']);
});

test('fail-closed on non-2xx → honest_limit carries status', async () => {
  const client = new TrustClient({ fetchImpl: jsonFetch({}, 503) });
  const v = await client.checkServer('acme');
  assert.equal(v.directive, 'UNVERIFIED');
  assert.deepEqual(v.honest_limits, ['mcpindex_http_503']);
});

test('fail-closed on unparseable body', async () => {
  const client = new TrustClient({
    fetchImpl: async () => new Response('not json', { status: 200 }),
  });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'UNVERIFIED');
  assert.deepEqual(v.honest_limits, ['mcpindex_unparseable_response']);
});

test('fail-closed on wrong-shape JSON (missing directive)', async () => {
  const client = new TrustClient({ fetchImpl: jsonFetch({ hello: 'world' }) });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'UNVERIFIED');
  assert.deepEqual(v.honest_limits, ['mcpindex_unparseable_response']);
});

test('caches real verdicts within TTL (one fetch)', async () => {
  let calls = 0;
  const client = new TrustClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(REAL_VERDICT), { status: 200 });
    },
  });
  await client.checkTool('acme', 'send_email');
  await client.checkTool('acme', 'send_email');
  assert.equal(calls, 1);
});

test('does NOT cache fail-closed verdicts (no pinning an outage)', async () => {
  let calls = 0;
  const client = new TrustClient({
    fetchImpl: async () => {
      calls += 1;
      throw new Error('down');
    },
  });
  await client.checkTool('acme', 'send_email');
  await client.checkTool('acme', 'send_email');
  assert.equal(calls, 2);
});

test('cacheTtlMs=0 disables caching', async () => {
  let calls = 0;
  const client = new TrustClient({
    cacheTtlMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(REAL_VERDICT), { status: 200 });
    },
  });
  await client.checkTool('acme', 'send_email');
  await client.checkTool('acme', 'send_email');
  assert.equal(calls, 2);
});

test('fail-closed on unknown directive (enum validation)', async () => {
  const client = new TrustClient({
    fetchImpl: jsonFetch({ ...REAL_VERDICT, directive: 'YOLO' }),
  });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'UNVERIFIED');
  assert.deepEqual(v.honest_limits, ['mcpindex_unparseable_response']);
});

test('fail-closed on unknown status (enum validation)', async () => {
  const client = new TrustClient({
    fetchImpl: jsonFetch({ ...REAL_VERDICT, status: 'WEIRD' }),
  });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'UNVERIFIED');
});

test('server-scope and tool-scope do not collide in cache', async () => {
  // Distinct directives per scope: if the keys collided, the second call would
  // hit the first's cached entry and return the WRONG directive - caught here.
  const bodies = {
    '/api/v1/trust/tool/acme/x': {
      ...REAL_VERDICT,
      directive: 'REVIEW',
      subject: { server_id: 'acme', tool_name: 'x' },
    },
    '/api/v1/trust/server/acme': {
      ...REAL_VERDICT,
      directive: 'UNVERIFIED',
      subject: { server_id: 'acme', tool_name: null },
    },
  };
  const client = new TrustClient({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(bodies[path]), { status: 200 });
    },
  });
  const tool = await client.checkTool('acme', 'x');
  const server = await client.checkServer('acme');
  assert.equal(tool.directive, 'REVIEW'); // tool-scope entry
  assert.equal(server.directive, 'UNVERIFIED'); // distinct server-scope entry, not the tool's
  assert.equal(server.subject.tool_name, null);
});

test('cache is bounded by maxCacheEntries (oldest evicted)', async () => {
  const fetched = [];
  const client = new TrustClient({
    maxCacheEntries: 2,
    fetchImpl: async (url) => {
      const name = new URL(url).pathname.split('/').pop();
      fetched.push(name);
      return new Response(
        JSON.stringify({ ...REAL_VERDICT, subject: { server_id: 'acme', tool_name: name } }),
        { status: 200 },
      );
    },
  });
  await client.checkTool('acme', 't1'); // cache: [t1]
  await client.checkTool('acme', 't2'); // cache: [t1, t2]
  await client.checkTool('acme', 't3'); // evicts t1 -> cache: [t2, t3]
  await client.checkTool('acme', 't2'); // still cached -> no fetch
  await client.checkTool('acme', 't1'); // was evicted -> re-fetch
  assert.deepEqual(fetched, ['t1', 't2', 't3', 't1']);
});

test('cache entry expires after TTL (injected clock)', async () => {
  let calls = 0;
  let t = 1000;
  const client = new TrustClient({
    cacheTtlMs: 100,
    now: () => t,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(REAL_VERDICT), { status: 200 });
    },
  });
  await client.checkTool('acme', 'send_email');
  t += 50; // still fresh
  await client.checkTool('acme', 'send_email');
  assert.equal(calls, 1);
  t += 100; // expired
  await client.checkTool('acme', 'send_email');
  assert.equal(calls, 2);
});

test('returned verdict is deep-frozen (mutation cannot corrupt the cache)', async () => {
  const client = new TrustClient({ fetchImpl: jsonFetch(REAL_VERDICT) });
  const v1 = await client.checkTool('acme', 'send_email');
  assert.ok(Object.isFrozen(v1), 'verdict frozen');
  assert.ok(Object.isFrozen(v1.honest_limits), 'honest_limits frozen');
  assert.throws(() => {
    v1.directive = 'ALLOW';
  }, 'directive reassignment throws in strict mode');
  assert.throws(() => {
    v1.honest_limits.push('x');
  }, 'honest_limits mutation throws');
  // A later cache hit still returns the original directive, uncorrupted.
  const v2 = await client.checkTool('acme', 'send_email');
  assert.equal(v2.directive, 'REVIEW');
});

test('single-flight: concurrent identical lookups issue one fetch', async () => {
  let calls = 0;
  const client = new TrustClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(REAL_VERDICT), { status: 200 });
    },
  });
  // Fire two without awaiting between them: the second coalesces onto the first.
  const [a, b] = await Promise.all([
    client.checkTool('acme', 'send_email'),
    client.checkTool('acme', 'send_email'),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.directive, 'REVIEW');
  assert.equal(b.directive, 'REVIEW');
});

test('single-flight clears after resolution (next call re-fetches on a miss)', async () => {
  let calls = 0;
  const client = new TrustClient({
    cacheTtlMs: 0, // caching off, so only in-flight coalescing is in play
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(REAL_VERDICT), { status: 200 });
    },
  });
  await client.checkTool('acme', 'send_email');
  await client.checkTool('acme', 'send_email'); // sequential -> not coalesced
  assert.equal(calls, 2);
});

test('maxCacheEntries=1 serves a single cached entry', async () => {
  let calls = 0;
  const client = new TrustClient({
    maxCacheEntries: 1,
    fetchImpl: async (url) => {
      calls += 1;
      const name = new URL(url).pathname.split('/').pop();
      return new Response(
        JSON.stringify({ ...REAL_VERDICT, subject: { server_id: 'acme', tool_name: name } }),
        { status: 200 },
      );
    },
  });
  await client.checkTool('acme', 't1');
  await client.checkTool('acme', 't1'); // cached
  assert.equal(calls, 1);
  await client.checkTool('acme', 't2'); // evicts t1
  await client.checkTool('acme', 't1'); // re-fetch
  assert.equal(calls, 3);
});

test('degenerate maxCacheEntries (0) does not hang and still resolves', async () => {
  const client = new TrustClient({ maxCacheEntries: 0, fetchImpl: jsonFetch(REAL_VERDICT) });
  const v = await client.checkTool('acme', 'send_email');
  assert.equal(v.directive, 'REVIEW');
});
