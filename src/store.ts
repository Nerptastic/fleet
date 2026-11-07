import { randomUUID } from 'node:crypto';
import { type Pool, type PoolClient } from 'pg';

export interface Message {
  id: string;
  thread_id: string;
  sender: string;
  recipient: string;
  body: string;
  reply_to: string | null;
  idempotency_key: string;
  created_at: Date;
  acknowledged_at: Date | null;
}

export class FleetError extends Error {}

export interface MessageStore {
  registerAgent(agent: string): Promise<void>;
  listAgents(): Promise<{ id: string }[]>;
  send(agent: string, to: string, body: string, key: string): Promise<Message>;
  inbox(agent: string, limit: number): Promise<Message[]>;
  reply(agent: string, messageId: string, body: string, key: string): Promise<Message>;
  acknowledge(agent: string, messageId: string): Promise<Message>;
  thread(agent: string, threadId: string, after: string | undefined, limit: number): Promise<Message[]>;
}

// First schema only. Serialize bootstrap across replicas; subsequent schema changes
// should be added as versioned migrations rather than editing existing columns here.
export async function initializeDatabase(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(74931201)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_agents (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS fleet_messages (
        id uuid PRIMARY KEY,
        thread_id uuid NOT NULL,
        sender text NOT NULL REFERENCES fleet_agents(id),
        recipient text NOT NULL REFERENCES fleet_agents(id),
        body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 16000),
        reply_to uuid REFERENCES fleet_messages(id),
        idempotency_key uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        acknowledged_at timestamptz,
        UNIQUE (sender, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS fleet_inbox_idx ON fleet_messages (recipient, created_at, id)
        WHERE acknowledged_at IS NULL;
      CREATE INDEX IF NOT EXISTS fleet_thread_idx ON fleet_messages (thread_id, created_at, id);
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class PostgresMessageStore implements MessageStore {
  constructor(private readonly pool: Pool) {}

  async registerAgent(agent: string) {
    await this.pool.query('INSERT INTO fleet_agents (id) VALUES ($1) ON CONFLICT DO NOTHING', [agent]);
  }

  async listAgents() {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM fleet_agents ORDER BY id');
    return rows;
  }

  private async insert(client: PoolClient, agent: string, to: string, body: string, key: string, original?: Message): Promise<Message> {
    await client.query('INSERT INTO fleet_agents (id) VALUES ($1), ($2) ON CONFLICT DO NOTHING', [agent, to]);
    const id = randomUUID();
    const { rows } = await client.query<Message>(`
      INSERT INTO fleet_messages (id, thread_id, sender, recipient, body, reply_to, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (sender, idempotency_key) DO NOTHING RETURNING *
    `, [id, original?.thread_id ?? id, agent, to, body, original?.id ?? null, key]);
    if (rows[0]) return rows[0];
    const existing = (await client.query<Message>(
      'SELECT * FROM fleet_messages WHERE sender = $1 AND idempotency_key = $2', [agent, key],
    )).rows[0];
    if (!existing || existing.recipient !== to || existing.body !== body || existing.reply_to !== (original?.id ?? null)) {
      throw new FleetError('Idempotency key already used for a different message. Use a new UUID for new work.');
    }
    return existing;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  send(agent: string, to: string, body: string, key: string) {
    return this.transaction(client => this.insert(client, agent, to, body, key));
  }

  async inbox(agent: string, limit: number) {
    const { rows } = await this.pool.query<Message>(`
      SELECT * FROM fleet_messages WHERE recipient = $1 AND acknowledged_at IS NULL
      ORDER BY created_at, id LIMIT $2
    `, [agent, limit]);
    return rows;
  }

  reply(agent: string, messageId: string, body: string, key: string) {
    return this.transaction(async client => {
      const original = (await client.query<Message>(
        'SELECT * FROM fleet_messages WHERE id = $1 AND recipient = $2', [messageId, agent],
      )).rows[0];
      if (!original) throw new FleetError('Message not found in your inbox/history.');
      const reply = await this.insert(client, agent, original.sender, body, key, original);
      await client.query('UPDATE fleet_messages SET acknowledged_at = COALESCE(acknowledged_at, now()) WHERE id = $1', [messageId]);
      return reply;
    });
  }

  async acknowledge(agent: string, messageId: string) {
    const { rows } = await this.pool.query<Message>(`
      UPDATE fleet_messages SET acknowledged_at = COALESCE(acknowledged_at, now())
      WHERE id = $1 AND recipient = $2 RETURNING *
    `, [messageId, agent]);
    if (!rows[0]) throw new FleetError('Message not found in your inbox/history.');
    return rows[0];
  }

  async thread(agent: string, threadId: string, after: string | undefined, limit: number) {
    // A cursor is a message ID in this same thread visible to this agent.
    const { rows } = await this.pool.query<Message>(`
      SELECT * FROM fleet_messages m
      WHERE m.thread_id = $1 AND (m.sender = $2 OR m.recipient = $2)
        AND ($3::uuid IS NULL OR (m.created_at, m.id) > (
          SELECT c.created_at, c.id FROM fleet_messages c
          WHERE c.id = $3 AND c.thread_id = $1 AND (c.sender = $2 OR c.recipient = $2)
        ))
      ORDER BY m.created_at, m.id LIMIT $4
    `, [threadId, agent, after ?? null, limit]);
    return rows;
  }
}
