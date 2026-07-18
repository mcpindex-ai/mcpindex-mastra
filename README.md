# @mcp-index/mastra

A fail-closed trust gate for [Mastra](https://mastra.ai) agents. Before your agent
invokes an MCP tool, it asks [mcpindex](https://mcpindex.ai) whether that tool has
been vetted, and warns you (or blocks the call) based on the answer.

Today a Mastra agent calls whatever tools an MCP server hands it, trusting the
tool's own description of itself. If a tool quietly does something other than what
it claims, nothing notices. This adds a second opinion at the moment of the call.

- **~10 lines to add.** No API key, no signup.
- **Fails safe.** If mcpindex is slow or unreachable, "couldn't verify" is treated
  as "not verified" - never silently trusted.
- **You pick the strictness.** `warn` (default) never breaks your agent; `enforce`
  blocks any tool that isn't explicitly cleared.

## Install

```bash
npm i @mcp-index/mastra
```

Requires Node >= 20 and `@mastra/core >= 1.0.0` (you already have it).

## Use

```ts
import { Agent } from '@mastra/core/agent';
import { mcpindexGate } from '@mcp-index/mastra';

const agent = new Agent({
  id: 'gated-agent',
  name: 'gated-agent',
  instructions: 'You are a helpful assistant.',
  model: 'openai/gpt-4o-mini',
  hooks: {
    beforeToolCall: mcpindexGate({ serverId: 'your-mcp-server-id' }),
  },
});
```

That is the whole integration. In the default `warn` mode you now get a log line
before every tool call telling you the tool's trust directive, and nothing about
your agent's behavior changes.

## Modes

```ts
mcpindexGate({ serverId: 'your-mcp-server-id', policy: 'warn' })    // default
mcpindexGate({ serverId: 'your-mcp-server-id', policy: 'enforce' }) // fail-closed
```

- **`warn`** - never blocks a call. Logs and annotates. Pure visibility: see what
  your agent is about to call and what has been vetted, with zero behavior change.
- **`enforce`** - fail-closed. Only an explicit `ALLOW` directive proceeds. `DENY`,
  `REVIEW`, and `UNVERIFIED` are all blocked, and the model receives a short
  "this tool is not cleared" message in place of the tool's output.

## Honest limits (read this)

The mcpindex public advisory API is at `verdict_contract_version` 1.0.0. **It does
not yet emit `ALLOW` or `DENY`** - every verdict today comes back as `REVIEW` or
`UNVERIFIED`. Two consequences you should know before wiring this up:

1. **`warn` is the sane default, and this is a visibility tool today, not a hard
   bouncer.** It tells you what your agent is calling and flags anything unvetted.
2. **`enforce` blocks *every* tool call right now**, because nothing is `ALLOW`
   yet. That is correct fail-closed behavior, not a bug - but it means `enforce` is
   only useful once mcpindex has real allow-list coverage for your server. When
   `ALLOW`/`DENY` verdicts ship, `enforce` becomes a real allow-list with **no code
   change on your side**.

We would rather tell you exactly what this does and does not do than dress up a
`REVIEW` as a safety guarantee.

## Options

```ts
mcpindexGate({
  serverId: 'your-mcp-server-id', // required
  policy: 'warn',                 // 'warn' (default) | 'enforce'
  cacheTtlMs: 60_000,             // verdict cache (default 60s); 0 disables
  maxCacheEntries: 1024,          // cap cached verdicts (oldest evicted)
  timeoutMs: 3_000,               // per-request timeout (default 3s)
  apiBase: 'https://mcpindex.ai', // override for self-hosting/testing
  onVerdict: ({ toolName, verdict, action }) => {/* metrics/logging */},
  logger: (msg) => console.warn(msg),
  blockedOutput: (info) => `blocked: ${info.toolName}`, // model-facing on block
});
```

## Direct lookups

Need the verdict without the gate? The client is exported:

```ts
import { TrustClient } from '@mcp-index/mastra';

const client = new TrustClient();
const v = await client.checkTool('your-server-id', 'send_email');
console.log(v.directive, v.honest_limits);

const server = await client.checkServer('your-server-id'); // aggregate
```

## How it works

`mcpindexGate` returns a Mastra `beforeToolCall` hook. On each tool call it does a
cached `GET https://mcpindex.ai/api/v1/trust/tool/{serverId}/{toolName}`, maps the
returned `directive` to an action under your `policy`, and either returns nothing
(proceed) or `{ proceed: false, output }` (block, handing `output` to the model as
the tool result). No credentials are sent; the advisory endpoints are public.

## Related packages

Three ways to bring mcpindex trust into an agent, for different surfaces:

| Package | Install | What it does |
| --- | --- | --- |
| **`@mcp-index/mastra`** *(this package)* | `npm i @mcp-index/mastra` | The advisory screen wired into Mastra as a `beforeToolCall` hook (warn / enforce). |
| **`mcp-server-mcpindex`** | `npm i -g mcp-server-mcpindex` | Directory + advisory screen as an MCP server: find servers by task, and `check_tool_trust` before a call. Works with any framework or a remote MCP client. |
| **`@mcp-index/sdk`** | `npm i @mcp-index/sdk` | In-path drift gate: `wrap()` an MCP session and HOLD a call when a tool's contract drifts from your pin. |

**Advisory screen vs drift gate:** this package and `mcp-server-mcpindex` ask mcpindex "has this tool been vetted?" (a network verdict, what the gate here does). `@mcp-index/sdk` asks a different question locally: "did this tool's contract change since I pinned it?" They are complementary, and none depends on another.

## License

MIT
