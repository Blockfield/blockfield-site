import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { Pool, types, type PoolClient } from 'pg';

const number = (value: string) => {
  const result = Number(value);
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) throw new Error('Database number exceeds the supported range');
  return result;
};
const pgTypes = { getTypeParser: (oid: number, format?: any) => [20, 1700].includes(oid) ? number : types.getTypeParser(oid, format) };

/** Only placeholders outside SQL literals are parameters. Values always travel separately. */
export function postgresSql(sql: string): string {
  let parameter = 0;
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, token => token === '?' ? `$${++parameter}` : token);
}

export class Database {
  postgres: boolean;
  sqlite?: DatabaseSync;
  pool?: Pool;
  private context = new AsyncLocalStorage<PoolClient | DatabaseSync>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(location: string) {
    this.postgres = /^postgres(?:ql)?:\/\//.test(location);
    if (this.postgres) {
      this.pool = new Pool({ connectionString: location, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 30000, types: pgTypes });
      this.pool.on('error', () => console.error('PostgreSQL idle connection failed'));
    } else {
      if (location !== ':memory:') {
        if (!isAbsolute(location)) throw new Error('BLOCKFIELD_STATS_DB must be absolute');
        mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
      }
      this.sqlite = new DatabaseSync(location);
      this.sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.sqlite.function('greatest', { varargs: true }, (...values: any[]) => Math.max(...values));
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(work);
    this.tail = pending.catch(() => {});
    return pending;
  }
  private async query(sql: string, args: any[], kind: 'all' | 'get' | 'run' | 'exec'): Promise<any> {
    const execute = async () => {
      if (this.postgres) {
        const result = await (this.context.getStore() as PoolClient | undefined ?? this.pool!).query(postgresSql(sql), args);
        if (kind === 'exec') return;
        if (kind === 'run') return { changes: result.rowCount };
        return kind === 'get' ? result.rows[0] : result.rows;
      }
      if (kind === 'exec') return this.sqlite!.exec(sql);
      return this.sqlite!.prepare(sql)[kind](...args);
    };
    return this.postgres || this.context.getStore() ? execute() : this.serial(execute);
  }
  prepare(sql: string) {
    return {
      all: (...args: any[]): Promise<any[]> => this.query(sql, args, 'all'),
      get: (...args: any[]): Promise<any> => this.query(sql, args, 'get'),
      run: (...args: any[]): Promise<{ changes: number }> => this.query(sql, args, 'run'),
    };
  }
  exec(sql: string): Promise<void> { return this.query(sql, [], 'exec'); }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work();
    const execute = async () => {
      const connection = this.postgres ? await this.pool!.connect() : this.sqlite!;
      try {
        return await this.context.run(connection, async () => {
          await this.exec(this.postgres ? 'BEGIN' : 'BEGIN IMMEDIATE');
          try {
            // Rating updates and rebuilds must serialize across site replicas, just like SQLite's writer lock.
            if (this.postgres) await this.exec('SELECT pg_advisory_xact_lock(782344, 1)');
            const result = await work();
            await this.exec('COMMIT');
            return result;
          } catch (error) { await this.exec('ROLLBACK'); throw error; }
        });
      } finally { if (this.postgres) (connection as PoolClient).release(); }
    };
    return this.postgres ? execute() : this.serial(execute);
  }
  async close() { await this.tail; if (this.pool) await this.pool.end(); else this.sqlite!.close(); }
}
