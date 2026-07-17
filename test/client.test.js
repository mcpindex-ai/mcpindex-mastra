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
  const bodies = {
    '/api/v1/trust/tool/acme/x': { ...REAL_VERDICT, directive: 'REVIEW' },
    '/api/v1/trust/server/acme': { ...REAL_VERDICT, subject: { server_id: 'acme', tool_name: null } },
  };
  const client = new TrustClient({
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      return new Response(JSON.stringify(bodies[path]), { status: 200 });
    },
  });
  const tool = await client.checkTool('acme', 'x');
  const server = await client.checkServer('acme');
  assert.equal(tool.subject.tool_name, 'send_email'); // from tool body
  assert.equal(server.subject.tool_name, null); // distinct entry, not the tool's
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
