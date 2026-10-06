import { Pool } from 'pg';

export interface PgPoolOptions {
  max?: number;
  /** Applied to the session (`statement_timeout`) and the client (`query_timeout`). */
  statementTimeoutMs?: number;
}

/** The one place a `pg` pool is built; the Postgres adapter and the `database` integration both use it. */
export function createPgPool(connectionString: string, options: PgPoolOptions = {}): Pool {
  return new Pool({
    connectionString,
    ...(options.max !== undefined ? { max: options.max } : {}),
    ...(options.statementTimeoutMs !== undefined
      ? { statement_timeout: options.statementTimeoutMs, query_timeout: options.statementTimeoutMs }
      : {}),
  });
}
