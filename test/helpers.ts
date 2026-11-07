import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { type MessageStore } from '../src/store.js';

const unsupported = async (): Promise<never> => { throw new Error('Unexpected storage call'); };
export const stubStore: MessageStore = {
  registerAgent: async () => {}, listAgents: async () => [],
  send: unsupported, inbox: unsupported, reply: unsupported, acknowledge: unsupported, thread: unsupported,
};

export async function withApp(
  checkDatabase: () => Promise<void>,
  run: (url: string) => Promise<void>,
  store: MessageStore = stubStore,
) {
  const server = createApp({ apiToken: 'test-token', checkDatabase, store }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

export const headers = {
  authorization: 'Bearer test-token',
  'x-fleet-agent': 'machine1',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};
