import 'dotenv/config';
import { Pool } from 'pg';
import { createApp } from './app.js';

const { DATABASE_URL, FLEET_API_TOKEN } = process.env;
if (!DATABASE_URL || !FLEET_API_TOKEN) {
  throw new Error('DATABASE_URL and FLEET_API_TOKEN are required');
}
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
});
pool.on('error', () => console.error('Unexpected PostgreSQL connection error'));
const app = createApp({
  apiToken: FLEET_API_TOKEN,
  checkDatabase: async () => { await pool.query('SELECT 1'); },
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Fleet listening on port ${port}`);
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(() => {
    void pool.end().then(() => {
      clearTimeout(timeout);
    }).catch(() => process.exit(1));
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
