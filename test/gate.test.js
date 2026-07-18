// Runtime tests for the gate hook + directive mapping. Plain JS against dist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpindexGate, directiveToAction, TrustClient } from '../dist/index.js';

function verdict(directive, extra = {}) {
  return {
    subject: { server_id: 'acme', tool_name: 'send_email' },
    status: 'EVALUATED',
    directive,
    granularity: 'tool',
    dimensions: [],
    expires_at: null,
    honest_limits: [],
    verdict_contract_version: '1.0.0',
    ...extra,
  };
}

function fetchReturning(directive, extra) {
  return async () => new Response(JSON.stringify(verdict(directive, extra)), { status: 200 });
}

// --- directiveToAction: the honesty-critical mapping ---

test('warn policy never blocks, whatever the directive', () => {
  for (const d of ['ALLOW', 'DENY', 'REVIEW', 'UNVERIFIED']) {
    assert.equal(directiveToAction(d, 'warn'), 'proceed', `${d} under warn`);
  }
});

test('enforce policy proceeds only on ALLOW (fail-closed)', () => {
  assert.equal(directiveToAction('ALLOW', 'enforce'), 'proceed');
  for (const d of ['DENY', 'REVIEW', 'UNVERIFIED']) {
    assert.equal(directiveToAction(d, 'enforce'), 'block', `${d} under enforce`);
  }
});

// --- the hook ---

test('warn (default): UNVERIFIED proceeds, returns undefined', async () => {
  const logs = [];
  const gate = mcpindexGate({
    serverId: 'acme',
    fetchImpl: fetchReturning('UNVERIFIED'),
    logger: (m) => logs.push(m),
  });
  const result = await gate({ toolName: 'send_email' });
  assert.equal(result, undefined);
  assert.equal(logs.length, 1); // a notice was logged
  assert.match(logs[0], /UNVERIFIED/);
});

test('enforce: UNVERIFIED blocks with substitute output', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: fetchReturning('UNVERIFIED'),
    logger: () => {},
  });
  const result = await gate({ toolName: 'send_email' });
  assert.ok(result);
  assert.equal(result.proceed, false);
  assert.match(String(result.output), /blocked tool "send_email"/);
});

test('enforce: ALLOW proceeds', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: fetchReturning('ALLOW'),
    logger: () => {},
  });
  const result = await gate({ toolName: 'send_email' });
  assert.equal(result, undefined);
});

test('onVerdict receives full info with the computed action', async () => {
  const seen = [];
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: fetchReturning('REVIEW'),
    logger: () => {},
    onVerdict: (info) => seen.push(info),
  });
  await gate({ toolName: 'send_email' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].action, 'block');
  assert.equal(seen[0].toolName, 'send_email');
  assert.equal(seen[0].serverId, 'acme');
  assert.equal(seen[0].verdict.directive, 'REVIEW');
});

test('custom blockedOutput is used', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: fetchReturning('DENY'),
    logger: () => {},
    blockedOutput: (info) => ({ blocked: true, tool: info.toolName }),
  });
  const result = await gate({ toolName: 'send_email' });
  assert.deepEqual(result.output, { blocked: true, tool: 'send_email' });
});

test('warn: ALLOW proceeds silently (no notice logged)', async () => {
  const logs = [];
  const gate = mcpindexGate({
    serverId: 'acme',
    fetchImpl: fetchReturning('ALLOW'),
    logger: (m) => logs.push(m),
  });
  const result = await gate({ toolName: 'send_email' });
  assert.equal(result, undefined);
  assert.equal(logs.length, 0);
});

test('network failure under enforce blocks (fail-closed end to end)', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: async () => {
      throw new Error('down');
    },
    logger: () => {},
  });
  const result = await gate({ toolName: 'send_email' });
  assert.ok(result);
  assert.equal(result.proceed, false);
});

test('a shared client is reused (cache shared across gate calls)', async () => {
  let calls = 0;
  const client = new TrustClient({
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(verdict('REVIEW')), { status: 200 });
    },
  });
  const gate = mcpindexGate({ serverId: 'acme', client, logger: () => {} });
  await gate({ toolName: 'send_email' });
  await gate({ toolName: 'send_email' });
  assert.equal(calls, 1);
});

// --- the hook must be total: a throwing consumer callback never crashes it ---

test('a throwing onVerdict does not crash the hook (warn proceeds)', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    fetchImpl: fetchReturning('UNVERIFIED'),
    logger: () => {},
    onVerdict: () => {
      throw new Error('boom');
    },
  });
  const result = await gate({ toolName: 'send_email' }); // must resolve, not reject
  assert.equal(result, undefined);
});

test('a throwing blockedOutput under enforce still blocks with the default output', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: fetchReturning('DENY'),
    logger: () => {},
    blockedOutput: () => {
      throw new Error('boom');
    },
  });
  const result = await gate({ toolName: 'send_email' });
  assert.ok(result, 'still blocked');
  assert.equal(result.proceed, false);
  assert.match(String(result.output), /blocked tool "send_email"/); // fell back to default
});

test('a throwing logger does not crash the hook (block still returned)', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    policy: 'enforce',
    fetchImpl: fetchReturning('UNVERIFIED'),
    logger: () => {
      throw new Error('boom');
    },
  });
  const result = await gate({ toolName: 'send_email' });
  assert.ok(result);
  assert.equal(result.proceed, false);
});

test('a throwing logger does not crash the hook (warn proceeds)', async () => {
  const gate = mcpindexGate({
    serverId: 'acme',
    fetchImpl: fetchReturning('UNVERIFIED'),
    logger: () => {
      throw new Error('boom');
    },
  });
  const result = await gate({ toolName: 'send_email' });
  assert.equal(result, undefined);
});

test('gate forwards maxCacheEntries to its client (bounded cache)', async () => {
  let calls = 0;
  const gate = mcpindexGate({
    serverId: 'acme',
    maxCacheEntries: 1,
    logger: () => {},
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(verdict('REVIEW')), { status: 200 });
    },
  });
  await gate({ toolName: 't1' });
  await gate({ toolName: 't1' }); // cached
  assert.equal(calls, 1);
  await gate({ toolName: 't2' }); // evicts t1 (cap 1)
  await gate({ toolName: 't1' }); // re-fetch (was evicted)
  assert.equal(calls, 3);
});
