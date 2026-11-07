// Run inside the Railway app container: railway ssh -- node scripts/smoke.mjs
// Reads the server's token in-process. Never prints credentials or message bodies.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const token = process.env.FLEET_API_TOKEN;
if (!token) throw new Error('FLEET_API_TOKEN is required');
const url = new URL('/api/fleet', process.env.FLEET_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`);
const suffix = randomUUID().slice(0, 8);
const a = `smoke1-${suffix}`;
const b = `smoke2-${suffix}`;
const clients = [];
async function connect(agent) {
  const client = new Client({ name: agent, version: '1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Fleet-Agent': agent } },
  }));
  return client;
}
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `Tool failed: ${name}`);
  return JSON.parse(result.content[0].text);
}
try {
  const sender = await connect(a);
  const args = { to: b, body: 'Fleet connectivity smoke test. Please reply pong.', idempotency_key: randomUUID() };
  const sent = await call(sender, 'send_message', args);
  assert.equal((await call(sender, 'send_message', args)).id, sent.id);
  // Recipient connects only after the message has been stored.
  const recipient = await connect(b);
  assert.equal((await call(recipient, 'check_inbox'))[0].id, sent.id);
  assert.equal((await call(recipient, 'check_inbox'))[0].id, sent.id);
  const reply = await call(recipient, 'reply', { message_id: sent.id, body: 'pong', idempotency_key: randomUUID() });
  assert.equal(reply.thread_id, sent.thread_id);
  assert.deepEqual(await call(recipient, 'check_inbox'), []);
  assert.equal((await call(sender, 'check_inbox'))[0].id, reply.id);
  await call(sender, 'acknowledge', { message_id: reply.id });
  assert.deepEqual(await call(sender, 'check_inbox'), []);
  assert.equal((await call(sender, 'read_thread', { thread_id: sent.thread_id })).length, 2);
  console.log('PASS: offline send, retry deduplication, inbox, reply, acknowledgment and retained history.');
  console.log('Test messages retained in a separate smoke-test thread:', sent.thread_id);
} catch {
  console.error('Fleet smoke test failed. Check service health and MCP configuration.');
  process.exitCode = 1;
} finally {
  await Promise.all(clients.map(client => client.close().catch(() => {})));
}
