/**
 * Postgres implementation of PersistenceAdapter (the runtime effect-handler
 * storage contract) over the same pool/tables as PostgresDataService.
 */
import type { Pool } from 'pg';
import { DatabaseError } from 'pg';
import { FULL_QUERY_CAPABILITIES, type EntityRow, type PersistenceAdapter, type QueryCapabilities, type RowPage, type RowPageRequest, type RowQuery, type RowQueryPage, type StoreFilter } from '@almadar/core';
import { filterRows, pageRows } from '../data/row-query.js';
import { buildPageQueries, buildQueryPageSql, buildWhere, columnKindOf, deserializeRow, mintId, queryFields, quoteIdent, serializeValue, tableNameFor, type SqlColumnKind, type SqlFilter } from './rows.js';

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
  private readonly columnKinds = new Map<string, Map<string, SqlColumnKind>>();

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

  queryCapabilities(_entityType: string): QueryCapabilities {
    return FULL_QUERY_CAPABILITIES;
  }

  async queryPage(entityType: string, query: RowQuery): Promise<RowQueryPage> {
    const table = tableNameFor(entityType);
    const kinds = await this.columnKindsFor(table, queryFields(query));
    const built = buildQueryPageSql(table, query, (field) => kinds.get(field) ?? 'absent');
    const result = await this.pool.query<EntityRow & { __total: number }>(built.sql, built.params);
    const rows = result.rows.map(({ __total: _total, ...row }) => deserializeRow(row));
    const first = result.rows[0];
    if (first) return { rows, total: first.__total };
    if ((query.offset ?? 0) === 0 && query.limit !== 0) return { rows, total: 0 };
    const counted = await this.pool.query<{ total: number }>(built.countSql, built.countParams);
    return { rows, total: counted.rows[0]?.total ?? 0 };
  }

  /** Column kinds of `table`, read from the database; re-read once when a queried field is not among them (a column added since). */
  private async columnKindsFor(table: string, fields: readonly string[]): Promise<Map<string, SqlColumnKind>> {
    const known = this.columnKinds.get(table);
    if (known && fields.every((f) => known.has(f))) return known;
    const result = await this.pool.query<{ column_name: string; data_type: string }>(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
      [table],
    );
    const kinds = new Map(result.rows.map((c) => [c.column_name, columnKindOf(c.data_type)] as const));
    this.columnKinds.set(table, kinds);
    return kinds;
  }

  async countRows(entityType: string): Promise<number> {
    const result = await this.pool.query<{ total: number }>(`SELECT COUNT(*)::int AS total FROM ${quoteIdent(tableNameFor(entityType))}`);
    return result.rows[0]?.total ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
