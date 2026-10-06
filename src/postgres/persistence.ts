/**
 * Postgres implementation of PersistenceAdapter (the runtime effect-handler
 * storage contract) over the same pool/tables as PostgresDataService.
 */
import type { Pool } from 'pg';
import { DatabaseError } from 'pg';
import type { EntityRow, PersistenceAdapter, RowPage, RowPageRequest, StoreFilter } from '@almadar/core';
import { filterRows, pageRows } from '../data/row-query.js';
import { buildPageQueries, buildWhere, deserializeRow, mintId, quoteIdent, serializeValue, tableNameFor, type SqlFilter } from './rows.js';

/** Filter operators `buildWhere` expresses in SQL; the rest are applied in memory. */
const SQL_OPS: ReadonlySet<string> = new Set(['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'contains']);

function sqlFilters(filters: readonly StoreFilter<EntityRow>[]): SqlFilter[] {
  return filters.map((f) => ({ field: f.field, op: f.op, value: f.value }));
}

function isUniqueViolation(error: Error): boolean {
  return error instanceof DatabaseError && error.code === '23505';
}

export interface PostgresPersistenceOptions {
  pool: Pool;
}

export class PostgresPersistence implements PersistenceAdapter {
  private readonly pool: Pool;

  constructor(options: PostgresPersistenceOptions) {
    this.pool = options.pool;
  }

  async create(entityType: string, data: EntityRow): Promise<{ id: string }> {
    const supplied = data.id;
    const id = typeof supplied === 'string' && supplied.length > 0 ? supplied : mintId();
    const record: EntityRow = { ...data, id };
    const keys = Object.keys(record).filter((k) => record[k] !== undefined);
    const cols = keys.map(quoteIdent).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const params = keys.map((k) => serializeValue(record[k]));
    try {
      await this.pool.query(
        `INSERT INTO ${quoteIdent(tableNameFor(entityType))} (${cols}) VALUES (${placeholders})`,
        params,
      );
    } catch (error) {
      if (error instanceof Error && isUniqueViolation(error)) {
        throw new Error(`Entity ${entityType} with id ${id} already exists`);
      }
      throw error;
    }
    return { id };
  }

  async update(entityType: string, id: string, data: EntityRow): Promise<void> {
    const record: EntityRow = { ...data };
    delete record.id;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined);
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(', ');
    const params = [...keys.map((k) => serializeValue(record[k])), id];
    await this.pool.query(
      `UPDATE ${quoteIdent(tableNameFor(entityType))} SET ${sets} WHERE ${quoteIdent('id')} = $${params.length}`,
      params,
    );
  }

  async delete(entityType: string, id: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM ${quoteIdent(tableNameFor(entityType))} WHERE ${quoteIdent('id')} = $1`,
      [id],
    );
  }

  async getById(entityType: string, id: string): Promise<EntityRow | null> {
    const result = await this.pool.query<EntityRow>(
      `SELECT * FROM ${quoteIdent(tableNameFor(entityType))} WHERE ${quoteIdent('id')} = $1`,
      [id],
    );
    if (result.rowCount === 0) return null;
    return deserializeRow(result.rows[0]);
  }

  async list(entityType: string): Promise<EntityRow[]> {
    const result = await this.pool.query<EntityRow>(
      `SELECT * FROM ${quoteIdent(tableNameFor(entityType))}`,
    );
    return result.rows.map((row) => deserializeRow(row));
  }

  async query(entityType: string, filters: readonly StoreFilter<EntityRow>[]): Promise<EntityRow[]> {
    const pushed = filters.filter((f) => SQL_OPS.has(f.op));
    const remainder = filters.filter((f) => !SQL_OPS.has(f.op));
    const { where, params } = buildWhere(sqlFilters(pushed));
    const result = await this.pool.query<EntityRow>(`SELECT * FROM ${quoteIdent(tableNameFor(entityType))}${where}`, params);
    return filterRows(result.rows.map((row) => deserializeRow(row)), remainder);
  }

  async listPage(entityType: string, request: RowPageRequest<EntityRow>): Promise<RowPage<EntityRow>> {
    const filters = request.filters ?? [];
    if (filters.some((f) => !SQL_OPS.has(f.op))) {
      // A filter SQL cannot express has to run before paging, or the page and total would be wrong.
      return pageRows(await this.query(entityType, filters), { ...request, filters: [] });
    }
    const { sql, countSql, params } = buildPageQueries(tableNameFor(entityType), sqlFilters(filters), {
      page: request.page,
      pageSize: request.pageSize,
      ...(request.search !== undefined ? { search: request.search } : {}),
      ...(request.searchFields !== undefined ? { searchFields: [...request.searchFields] } : {}),
      ...(request.sortBy !== undefined ? { sortBy: request.sortBy } : {}),
      sortOrder: request.sortOrder ?? 'asc',
    });
    const [pageResult, countResult] = await Promise.all([
      this.pool.query<EntityRow>(sql, params),
      this.pool.query<{ total: number }>(countSql, params.slice(0, params.length - 2)),
    ]);
    return { rows: pageResult.rows.map((row) => deserializeRow(row)), total: countResult.rows[0]?.total ?? 0 };
  }

  async countRows(entityType: string): Promise<number> {
    const result = await this.pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM ${quoteIdent(tableNameFor(entityType))}`);
    return result.rows[0]?.total ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
