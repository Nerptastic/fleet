import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { FleetError, initializeDatabase, PostgresMessageStore, type Message } from '../src/store.js';
import { withApp } from './helpers.js';

const connectionString = process.env.TEST_DATABASE_URL;
test('PostgreSQL + two real MCP clients: durable send, reply, retry, ack and history', {
  skip: !connectionString && 'Set TEST_DATABASE_URL to run PostgreSQL integration tests (CI always does).',
}, async () => {
  const schema = `fleet_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await initializeDatabase(pool);
    await initializeDatabase(pool); // Repeated deploys must preserve existing data.
    const store = new PostgresMessageStore(pool);
    const check = async () => { await pool.query('SELECT id FROM fleet_messages LIMIT 0'); };
    let sent!: Message;
    await withApp(check, async url => {
      const machine1 = new Client({ name: 'machine1', version: '1' });
      const transport = new StreamableHTTPClientTransport(new URL(`${url}/api/fleet`), {
        requestInit: { headers: { Authorization: 'Bearer test-token', 'X-Fleet-Agent': 'machine1' } },
      });
      await machine1.connect(transport);
      try {
        const call = async (name: string, args: Record<string, unknown>) => {
          const result = await machine1.callTool({ name, arguments: args });
          assert(!result.isError, JSON.stringify(result));
          const content = result.content as { type: string; text: string }[];
          return JSON.parse(content[0].text);
        };
        const args = { to: 'machine2', body: "Hello machine2. Please reply 'hello machine1'.", idempotency_key: randomUUID() };
        // Recipient has never connected: an offline/new mailbox still accepts work.
        sent = await call('send_message', args);
        assert.equal(sent.sender, 'machine1');
        assert.equal(sent.recipient, 'machine2');
        assert.equal((await call('send_message', args)).id, sent.id);
        const conflict = await machine1.callTool({ name: 'send_message', arguments: { ...args, body: 'Different work' } });
        assert.equal(conflict.isError, true);
        const invalid = await machine1.callTool({ name: 'send_message', arguments: { ...args, body: ' ' } });
        assert.equal(invalid.isError, true);
      } finally {
        await machine1.close();
      }
    }, store);

    // Replace both the HTTP app and pool: history cannot depend on process memory.
    await pool.end();
    const restartedPool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    try {
      await initializeDatabase(restartedPool);
      const restartedStore = new PostgresMessageStore(restartedPool);
      await withApp(async () => { await restartedPool.query('SELECT 1'); }, async url => {
        const clients = new Map<string, Client>();
        try {
          for (const agent of ['machine1', 'machine2', 'outsider']) {
            const client = new Client({ name: agent, version: '1' });
            await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/api/fleet`), {
              requestInit: { headers: { Authorization: 'Bearer test-token', 'X-Fleet-Agent': agent } },
            }));
            clients.set(agent, client);
          }
          async function call(agent: string, name: string, args: Record<string, unknown> = {}) {
            const result = await clients.get(agent)!.callTool({ name, arguments: args });
            assert(!result.isError, JSON.stringify(result));
            return JSON.parse((result.content as { text: string }[])[0].text);
          }
          const inbox = await call('machine2', 'check_inbox');
          assert.equal(inbox.length, 1);
          assert.equal(inbox[0].id, sent.id);
          assert.equal((await call('machine2', 'check_inbox'))[0].id, sent.id); // Read is not ack.
          const args = { message_id: sent.id, body: 'hello machine1', idempotency_key: randomUUID() };
          const replies = await Promise.all([
            call('machine2', 'reply', args), call('machine2', 'reply', args),
          ]);
          assert.equal(replies[0].id, replies[1].id); // Concurrent retry is deduplicated.
          assert.equal(replies[0].thread_id, sent.thread_id);
          assert.deepEqual(await call('machine2', 'check_inbox'), []); // Reply atomically acked original.
          const replyInbox = await call('machine1', 'check_inbox');
          assert.equal(replyInbox.length, 1);
          assert.equal(replyInbox[0].body, 'hello machine1');
          await call('machine1', 'acknowledge', { message_id: replies[0].id });
          await call('machine1', 'acknowledge', { message_id: replies[0].id });
          assert.deepEqual(await call('machine1', 'check_inbox'), []);
          const history = await call('machine1', 'read_thread', { thread_id: sent.thread_id });
          assert.equal(history.length, 2);
          assert(history.every((m: Message) => m.acknowledged_at));
          const page = await call('machine2', 'read_thread', { thread_id: sent.thread_id, limit: 1 });
          const next = await call('machine2', 'read_thread', { thread_id: sent.thread_id, after: page[0].id, limit: 1 });
          assert.equal(next[0].id, replies[0].id);
          assert.deepEqual(await call('outsider', 'read_thread', { thread_id: sent.thread_id }), []);
          const forbidden = await clients.get('outsider')!.callTool({ name: 'acknowledge', arguments: { message_id: sent.id } });
          assert.equal(forbidden.isError, true);
          const forbiddenReply = await clients.get('outsider')!.callTool({
            name: 'reply', arguments: { message_id: sent.id, body: 'Not my message', idempotency_key: randomUUID() },
          });
          assert.equal(forbiddenReply.isError, true);
          const agents = await call('machine1', 'list_agents');
          assert(agents.some((a: { id: string }) => a.id === 'machine2'));
          await assert.rejects(restartedStore.acknowledge('machine1', sent.id), FleetError);
        } finally {
          await Promise.all([...clients.values()].map(client => client.close()));
        }
      }, restartedStore);
    } finally {
      await restartedPool.end();
    }
  } finally {
    await pool.end().catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
