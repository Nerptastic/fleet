import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

interface AppOptions {
  apiToken: string;
  checkDatabase: () => Promise<void>;
}

export function createApp({ apiToken, checkDatabase }: AppOptions) {
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

  // Bootstrap authentication only. Per-agent credentials come with registration.
  app.use('/api/fleet', (req, res, next) => {
    const suppliedHash = createHash('sha256').update(req.headers.authorization ?? '').digest();
    if (!timingSafeEqual(tokenHash, suppliedHash)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.post('/api/fleet', express.json({ limit: '256kb' }), async (req, res) => {
    // Stateless transport: agent conversations will live in PostgreSQL, not MCP sessions.
    const server = new McpServer({ name: 'fleet', version: '0.1.0' });
    server.registerTool('fleet_status', {
      description: 'Check whether the Fleet communication service and database are available. Agent messaging is not implemented yet.',
      inputSchema: {},
    }, async () => {
      try {
        await checkDatabase();
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'ready', messaging: 'not_implemented' }) }] };
      } catch {
        return { isError: true, content: [{ type: 'text', text: 'Fleet database is unavailable.' }] };
      }
    });

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
