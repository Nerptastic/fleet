import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

async function withApp(checkDatabase: () => Promise<void>, run: (url: string) => Promise<void>) {
  const server = createApp({ apiToken: 'test-token', checkDatabase }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

const headers = {
  authorization: 'Bearer test-token',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

test('health and readiness', async () => {
  await withApp(async () => {}, async url => {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    assert.equal((await fetch(`${url}/ready`)).status, 200);
  });
});

test('readiness fails when database is unavailable', async () => {
  await withApp(async () => { throw new Error('secret connection details'); }, async url => {
    const response = await fetch(`${url}/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'unavailable' });
  });
});

test('MCP requires authentication', async () => {
  await withApp(async () => {}, async url => {
    for (const authorization of ['', 'Bearer wrong-token']) {
      const response = await fetch(`${url}/api/fleet`, { method: 'POST', headers: { authorization } });
      assert.equal(response.status, 401);
    }
  });
});

test('MCP initializes, lists tools, and checks Fleet status', async () => {
  await withApp(async () => {}, async url => {
    async function rpc(method: string, params: unknown) {
      const response = await fetch(`${url}/api/fleet`, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      assert.equal(response.status, 200);
      return await response.json() as any;
    }
    const init = await rpc('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fleet-test', version: '1.0.0' },
    });
    assert.equal(init.result.serverInfo.name, 'fleet');
    const tools = await rpc('tools/list', {});
    assert.deepEqual(tools.result.tools.map((tool: { name: string }) => tool.name), ['fleet_status']);
    const result = await rpc('tools/call', { name: 'fleet_status', arguments: {} });
    assert.equal(JSON.parse(result.result.content[0].text).status, 'ready');
  });
});

test('authenticated invalid JSON and unsupported methods return clear errors', async () => {
  await withApp(async () => {}, async url => {
    assert.equal((await fetch(`${url}/api/fleet`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${url}/api/fleet`, { headers })).status, 405);
  });
});
