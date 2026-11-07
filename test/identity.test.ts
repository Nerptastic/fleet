import assert from 'node:assert/strict';
import { test } from 'node:test';
import { headers, stubStore, withApp } from './helpers.js';

test('authenticated MCP requires a valid agent label', async () => {
  await withApp(async () => {}, async url => {
    for (const agent of ['', '../machine', 'MACHINE1', 'a'.repeat(65)]) {
      const response = await fetch(`${url}/api/fleet`, {
        method: 'POST', headers: { ...headers, 'x-fleet-agent': agent }, body: '{}',
      });
      assert.equal(response.status, 400);
    }
  });
});

test('registration database failure is 503 without sensitive details', async () => {
  await withApp(async () => {}, async url => {
    const response = await fetch(`${url}/api/fleet`, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Fleet storage unavailable' });
  }, { ...stubStore, registerAgent: async () => { throw new Error('secret database credentials'); } });
});
