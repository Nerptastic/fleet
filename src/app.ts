import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { agentId, createFleetServer } from './tools.js';
import { type MessageStore } from './store.js';

interface AppOptions {
  apiToken: string;
  checkDatabase: () => Promise<void>;
  store: MessageStore;
}

export function createApp({ apiToken, checkDatabase, store }: AppOptions) {
  if (!apiToken.trim()) throw new Error('FLEET_API_TOKEN must not be empty');
  const app = express();
  app.disable('x-powered-by');
  const tokenHash = createHash('sha256').update(`Bearer ${apiToken}`).digest();

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'fleet' });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await checkDatabase();
      res.json({ status: 'ready' });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  // One shared POC credential. Agent labels are NOT independent authentication.
  app.use('/api/fleet', (req, res, next) => {
    const suppliedHash = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(tokenHash, suppliedHash)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.post('/api/fleet', express.json({ limit: '256kb' }), async (req, res) => {
    const identity = agentId.safeParse(req.get('X-Fleet-Agent'));
    if (!identity.success) {
      res.status(400).json({ error: 'X-Fleet-Agent header required: 1-64 lowercase letters, digits, underscores or hyphens; start with a letter or digit.' });
      return;
    }
    try {
      await store.registerAgent(identity.data);
    } catch {
      res.status(503).json({ error: 'Fleet storage unavailable' });
      return;
    }
    // Conversations persist in PostgreSQL, not in transport sessions.
    const server = createFleetServer(identity.data, store, checkDatabase);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void server.close().catch(() => console.error('Failed to close MCP server'));
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      console.error('MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal server error' } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  app.all('/api/fleet', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Use MCP Streamable HTTP POST requests' });
  });

  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error.status === 413 ? 413 : error.status === 400 ? 400 : 500;
    res.status(status).json({ error: status === 413 ? 'Payload too large' : status === 400 ? 'Invalid JSON' : 'Internal server error' });
  };
  app.use(handleError);
  return app;
}
