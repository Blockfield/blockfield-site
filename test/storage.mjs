import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { StatsStore } from '../src/lib/stats.ts';

export async function database(t) {
  if (!process.env.BLOCKFIELD_TEST_DATABASE_URL) {
    const store = await StatsStore.open(':memory:');
    t.after(() => store.close());
    return store;
  }
  const url = new URL(process.env.BLOCKFIELD_TEST_DATABASE_URL);
  const pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: 5000 });
  const schema = `test_${randomBytes(12).toString('hex')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  let store;
  t.after(async () => {
    try { await store?.close(); await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  });
  store = await StatsStore.open(url.href);
  return store;
}
