import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, types, type PoolClient } from 'pg'

const number = (value: string) => {
  const result = Number(value)
  if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER)
    throw new Error('Database number exceeds the supported range')
  return result
}
const pgTypes = {
  getTypeParser: (oid: number, format?: any) =>
    [20, 1700].includes(oid) ? number : types.getTypeParser(oid, format),
}

/** Only placeholders outside SQL literals are parameters. Values always travel separately. */
export function postgresSql(sql: string): string {
  let parameter = 0
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g, (token) =>
    token === '?' ? `$${++parameter}` : token,
  )
}

export class Database {
  pool: Pool
  private context = new AsyncLocalStorage<PoolClient>()

  constructor(location: string) {
    if (!/^postgres(?:ql)?:\/\//.test(location))
      throw new Error('Statistics storage must be a PostgreSQL URL')
    this.pool = new Pool({
      connectionString: location,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 30000,
      types: pgTypes,
    })
    this.pool.on('error', () => console.error('PostgreSQL idle connection failed'))
  }
  private async query(
    sql: string,
    args: any[],
    kind: 'all' | 'get' | 'run' | 'exec',
  ): Promise<any> {
    const result = await ((this.context.getStore() as PoolClient | undefined) ?? this.pool).query(
      postgresSql(sql),
      args,
    )
    if (kind === 'exec') return
    if (kind === 'run') return { changes: result.rowCount }
    return kind === 'get' ? result.rows[0] : result.rows
  }
  prepare(sql: string) {
    return {
      all: (...args: any[]): Promise<any[]> => this.query(sql, args, 'all'),
      get: (...args: any[]): Promise<any> => this.query(sql, args, 'get'),
      run: (...args: any[]): Promise<{ changes: number }> => this.query(sql, args, 'run'),
    }
  }
  exec(sql: string): Promise<void> {
    return this.query(sql, [], 'exec')
  }
  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.context.getStore()) return work()
    const connection = await this.pool.connect()
    try {
      return await this.context.run(connection, async () => {
        await this.exec('BEGIN')
        try {
          // Rating updates and rebuilds must serialize across site replicas.
          await this.exec('SELECT pg_advisory_xact_lock(782344, 1)')
          const result = await work()
          await this.exec('COMMIT')
          return result
        } catch (error) {
          await this.exec('ROLLBACK')
          throw error
        }
      })
    } finally {
      connection.release()
    }
  }
  async close() {
    await this.pool.end()
  }
}
