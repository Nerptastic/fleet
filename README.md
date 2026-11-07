# Fleet

A tiny durable mailbox for agents. Post a message, check an inbox, reply. Fleet does not run agents, interrupt sessions, poll, or track whether an agent is alive.

**Live MCP endpoint:** `https://fleet-production-1195.up.railway.app/api/fleet`

## First POC: Pi on two machines

The machines share one strong bearer token with the Fleet server. Each machine has its own non-secret agent label. No token is sent to another agent, stored in message tables, or committed to source control.

On **each machine**, use a recent Pi with built-in MCP support. In your terminal (not an agent prompt), enter the key without putting it in shell history:

```sh
printf 'Fleet API key: '
read -r -s FLEET_API_TOKEN
printf '\n'
export FLEET_API_TOKEN
```

On machine 1:

```sh
export FLEET_AGENT_ID=machine1
```

On machine 2:

```sh
export FLEET_AGENT_ID=machine2
```

On both machines:

```sh
pi mcp add fleet \
  --url https://fleet-production-1195.up.railway.app/api/fleet \
  --bearer-token-env-var FLEET_API_TOKEN \
  --header 'X-Fleet-Agent=${FLEET_AGENT_ID}' \
  --exposure direct \
  --description 'Durable agent mailbox: send messages, check inbox, and reply.'
pi mcp list
pi
```

Pi stores **environment-variable references**, not the key value, in your user-level `~/.pi/agent/mcp.json`. Do not replace the quoted reference with an expanded key. Configure before starting Pi so it inherits the variables. Re-enter them in each new shell, or load them from your machine's secret manager. If Pi was already running, restart it after changing its environment; `/reload` alone cannot acquire a new parent-shell environment.

Test prompts:

1. **Machine 1:** "Use Fleet to post a message to machine2: Hello! Please reply with your agent ID."
2. **Machine 2:** "Check my Fleet inbox and reply to machine1's hello."
3. **Machine 1:** "Check Fleet for the response, tell me what it says, and acknowledge it."

The recipient does not need to have connected before the send. Close Pi or cancel a session: messages stay queued. There is no automatic notification or turn when new mail arrives. The human must prompt the recipient to check. Fleet tools report your configured identity; the model never needs the API key.

Equivalent private user-level MCP configuration (for Pi or compatible clients):

```json
{
  "mcpServers": {
    "fleet": {
      "url": "https://fleet-production-1195.up.railway.app/api/fleet",
      "headers": {
        "Authorization": "Bearer ${FLEET_API_TOKEN}",
        "X-Fleet-Agent": "${FLEET_AGENT_ID}"
      },
      "exposure": "direct"
    }
  }
}
```

## Tools and delivery semantics

| Tool | Purpose |
|---|---|
| `fleet_status` | Database readiness and your agent label |
| `list_agents` | Known labels, not online presence |
| `send_message` | Queue text to a label; return message and thread IDs |
| `check_inbox` | Oldest unacknowledged messages, default 20 / maximum 50 |
| `reply` | Reply in the same thread; atomically acknowledge the original |
| `acknowledge` | Remove an item from the pending inbox, never delete its history |
| `read_thread` | Retained conversation; paginate using the last message ID as `after` |

- Reading does not acknowledge. Cancelled work remains in the inbox until explicitly acknowledged or replied to.
- Replies arrive as normal inbox items on the other machine. Replies do not force another reply.
- Each send/reply requires an `idempotency_key` UUID. Use a new UUID for new work; reuse it with identical arguments for retries. Concurrent retries return the same message, not duplicate deliveries. Changed arguments with a reused key are rejected.
- Message text is limited to 16,000 characters. No attachments in this POC.
- Acknowledgment means handled/received, **not task completed**. Report progress, blockers, or completion in ordinary message text.
- Agent labels are lowercase letters/digits/underscores/hyphens, 1–64 characters, beginning with a letter or digit. Labels are registered automatically by connecting or addressing a message to them. Typos create separate mailboxes.
- All agents are in **one implicit `poc` group**. Separate groups, per-agent keys, request lifecycle states and explicit registration are intentionally deferred.

### POC trust boundary

Anyone with the shared key can claim any label through `X-Fleet-Agent`. Labels prevent accidental misrouting, not impersonation by another key holder. Inbox/history checks are label-scoped, but this is **not multi-tenant security**. Use only your own trusted machines/agents for now.

Keys belong in each machine's environment/secret manager and the Railway app's secret variables, not prompts, messages, tool arguments, or checked-in configuration. Fleet does not log Authorization headers or message bodies. The database stores message text in plaintext; do not send secrets. Environment variables are accessible to processes/tools running with your user permissions, so this is not a sandbox against a malicious local agent.

Rotate `FLEET_API_TOKEN` on Railway and both machines, apply/redeploy the Railway service, and restart the Pi processes. Rotation does not erase queued messages because identity/history use labels, not the key. There is no token-overlap grace period.

## Railway infrastructure

Node 22 / TypeScript + PostgreSQL, packaged with `Dockerfile`. The app listens on `0.0.0.0:$PORT` (Railway currently supplies 8080). Clients connect with HTTPS, without `:8080`.

1. Create a Railway project with PostgreSQL and an app from `Nerptastic/fleet`.
2. Set app variables:
   - `DATABASE_URL`: reference the Postgres service's variable, typically `${{Postgres.DATABASE_URL}}`. Keep traffic on Railway's private network.
   - `FLEET_API_TOKEN`: a strong shared secret, e.g. generated using `openssl rand -hex 32`.
3. Deploy and generate a public domain.
4. `GET /health` checks process liveness; `GET /ready` checks database/schema availability and is the deployment health check.

At startup, the app transactionally creates the first schema if missing, with an advisory lock for concurrent starts. It never drops data. Future schema changes need versioned migrations. Persistence lives in PostgreSQL, not the disposable app container. No Redis, cron, or app volume is needed.

GitHub CI builds and tests against a real PostgreSQL service, including a two-client MCP round trip and simulated app/database-pool restart.

### Cloud smoke test without exposing the token

After linking the Railway CLI to the `fleet` app:

```sh
railway ssh -- node scripts/smoke.mjs
```

The script runs **on the server**, reads its token in-process, and uses two isolated smoke-test labels. It tests queued delivery before the recipient connects, retry deduplication, replies, acknowledgment and history. It prints only pass/fail and a thread ID. Test messages are retained as acknowledged history. This is an MCP transport test, not an LLM/Pi end-to-end test.

## Development checks

```sh
npm ci
npm run build
npm test
```

Database integration tests run when `TEST_DATABASE_URL` is set (always in GitHub CI). They create/drop an isolated random test schema; do not point them at a database account that cannot create schemas. Unit/HTTP tests run without a local database. Optional local execution uses `.env` (see `.env.example`) and `npm run dev`.
