import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from './config';
import type { Conversation } from '@sufler/shared';

export const pool = config.database
  ? new pg.Pool({ connectionString: config.database, max: 20 })
  : null;
type Row = { data: unknown; version: number; createdAt: string };
export class Store {
  private memory = new Map<string, Row>();
  private locks = new Map<string, Promise<unknown>>();
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) || Promise.resolve();
    const job = previous
      .catch(() => {})
      .then(async () => {
        if (config.demo) return fn();
        const client = await pool!.connect();
        try {
          await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
          return await fn();
        } finally {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
          client.release();
        }
      });
    this.locks.set(key, job);
    try {
      return await job;
    } finally {
      if (this.locks.get(key) === job) this.locks.delete(key);
    }
  }
  async removeConversationRecords(org: string, id: string) {
    if (config.demo) {
      for (const [key, row] of this.memory)
        if (
          key.startsWith(`${org}:`) &&
          ['revision', 'usage'].includes(key.split(':')[1]) &&
          (row.data as { conversationId?: string }).conversationId === id
        )
          this.memory.delete(key);
      return;
    }
    await pool!.query(
      "DELETE FROM app_record WHERE org_id=$1 AND kind IN ('revision','usage') AND data->>'conversationId'=$2",
      [org, id],
    );
  }
  private key(org: string, kind: string, id: string) {
    return `${org}:${kind}:${id}`;
  }
  async get<T>(org: string, kind: string, id: string): Promise<T | null> {
    if (config.demo)
      return structuredClone((this.memory.get(this.key(org, kind, id))?.data as T) ?? null);
    const r = await pool!.query(
      'SELECT data FROM app_record WHERE org_id=$1 AND kind=$2 AND id=$3',
      [org, kind, id],
    );
    return r.rows[0]?.data ?? null;
  }
  async list<T>(org: string, kind: string): Promise<T[]> {
    if (config.demo)
      return [...this.memory.entries()]
        .filter(([k]) => k.startsWith(`${org}:${kind}:`))
        .map(([, r]) => structuredClone(r.data as T));
    const r = await pool!.query(
      'SELECT data FROM app_record WHERE org_id=$1 AND kind=$2 ORDER BY created_at DESC',
      [org, kind],
    );
    return r.rows.map((r) => r.data);
  }
  async put(org: string, kind: string, id: string, data: unknown): Promise<void> {
    if (config.demo) {
      const key = this.key(org, kind, id);
      const prev = this.memory.get(key);
      this.memory.set(key, {
        data: structuredClone(data),
        version: (prev?.version || 0) + 1,
        createdAt: prev?.createdAt || new Date().toISOString(),
      });
      return;
    }
    await pool!.query(
      'INSERT INTO app_record(org_id,kind,id,data) VALUES($1,$2,$3,$4) ON CONFLICT(org_id,kind,id) DO UPDATE SET data=EXCLUDED.data,version=app_record.version+1,updated_at=now()',
      [org, kind, id, JSON.stringify(data)],
    );
  }
  async remove(org: string, kind: string, id: string) {
    if (config.demo) {
      this.memory.delete(this.key(org, kind, id));
      return;
    }
    await pool!.query('DELETE FROM app_record WHERE org_id=$1 AND kind=$2 AND id=$3', [
      org,
      kind,
      id,
    ]);
  }
  async mutateConversation(
    org: string,
    id: string,
    fn: (value: Conversation) => Conversation | null,
  ): Promise<Conversation | null> {
    if (config.demo) {
      const key = this.key(org, 'conversation', id);
      const previous = this.locks.get(key) || Promise.resolve();
      const job = previous
        .catch(() => {})
        .then(async () => {
          const value = await this.get<Conversation>(org, 'conversation', id);
          if (!value) return null;
          const next = fn(value);
          if (next) {
            await this.put(org, 'conversation', id, next);
            await this.put(org, 'revision', `${id}:${next.card.revision}`, {
              conversationId: id,
              card: next.card,
              at: new Date().toISOString(),
            });
          }
          return next;
        });
      this.locks.set(key, job);
      try {
        return await job;
      } finally {
        if (this.locks.get(key) === job) this.locks.delete(key);
      }
    }
    const client = await pool!.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        "SELECT data FROM app_record WHERE org_id=$1 AND kind='conversation' AND id=$2 FOR UPDATE",
        [org, id],
      );
      if (!r.rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const next = fn(r.rows[0].data);
      if (next) {
        await client.query(
          "UPDATE app_record SET data=$3,version=version+1,updated_at=now() WHERE org_id=$1 AND kind='conversation' AND id=$2",
          [org, id, JSON.stringify(next)],
        );
        await client.query(
          "INSERT INTO app_record(org_id,kind,id,data) VALUES($1,'revision',$2,$3) ON CONFLICT(org_id,kind,id) DO UPDATE SET data=EXCLUDED.data",
          [
            org,
            `${id}:${next.card.revision}`,
            JSON.stringify({ conversationId: id, card: next.card, at: new Date().toISOString() }),
          ],
        );
      }
      await client.query('COMMIT');
      return next;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  async organizations(): Promise<string[]> {
    if (config.demo)
      return [
        ...new Set(
          [...this.memory.values()]
            .map((r) => (r.data as { orgId?: string }).orgId)
            .filter((v): v is string => !!v),
        ),
      ];
    const r = await pool!.query('SELECT id FROM organization');
    return r.rows.map((r) => r.id);
  }
  async audit(org: string, userId: string, action: string, subject: string) {
    await this.put(org, 'audit', randomUUID(), {
      userId,
      action,
      subject,
      at: new Date().toISOString(),
    });
  }
}
export const store = new Store();
export async function migrateApp() {
  if (!pool) throw new Error('DATABASE_URL required');
  await pool.query(`CREATE TABLE IF NOT EXISTS app_record (
    org_id text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,
    version integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(org_id,kind,id)
  ); CREATE INDEX IF NOT EXISTS app_record_org_kind ON app_record(org_id,kind);
  CREATE INDEX IF NOT EXISTS app_record_retention ON app_record(kind,created_at);`);
}
