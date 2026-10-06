/**
 * Shared internals for the Postgres adapters — table naming, id minting,
 * row (de)serialization, and parameterized WHERE / pagination SQL building.
 * Used by BOTH PostgresDataService and PostgresPersistence (no duplication).
 */
import { randomUUID } from 'node:crypto';
import type { FieldValue } from '@almadar/core';

/**
 * Single deterministic owner of entityType → table name: snake_case
 * (underscore before lowercase→uppercase transitions) + pluralization
 * (trailing y→ies, trailing s→es, else +s). `TimeEntry` → `time_entries`.
 */
export function snakeNameFor(entityType: string): string {
  return entityType.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

export function tableNameFor(entityType: string): string {
  const snake = snakeNameFor(entityType);
  if (snake.endsWith('y')) return `${snake.slice(0, -1)}ies`;
  if (snake.endsWith('s')) return `${snake}es`;
  return `${snake}s`;
}

export function mintId(): string {
  return randomUUID();
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** FieldValue → SQL param: objects/arrays (incl. nested Dates) go through JSON. */
export function serializeValue(value: FieldValue | undefined): FieldValue {
  if (value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return value;
}

/** pg returns timestamptz as Date; rows leave every store with ISO-string createdAt/updatedAt. */
export function deserializeRow<T extends object>(row: T): T {
  for (const key of ['createdAt', 'updatedAt']) {
    const value = Reflect.get(row, key);
    if (value instanceof Date) Reflect.set(row, key, value.toISOString());
  }
  return row;
}

export interface SqlFilter {
  field: string;
  op: string;
  value: FieldValue | undefined;
}

export interface WhereClause {
  where: string;
  params: (FieldValue | undefined)[];
  nextIndex: number;
}

/** Translate filter ops to parameterized SQL; unrecognised ops add no condition (permissive, matching the mock). */
export function buildWhere(filters: readonly SqlFilter[], firstIndex = 1): WhereClause {
  const clauses: string[] = [];
  const params: (FieldValue | undefined)[] = [];
  let i = firstIndex;
  for (const filter of filters) {
    const col = quoteIdent(filter.field);
    switch (filter.op) {
      case '==':
        clauses.push(`${col} = $${i}`);
        params.push(filter.value);
        i++;
        break;
      case '!=':
        clauses.push(`${col} <> $${i}`);
        params.push(filter.value);
        i++;
        break;
      case '<':
        clauses.push(`${col} < $${i}`);
        params.push(filter.value);
        i++;
        break;
      case '<=':
        clauses.push(`${col} <= $${i}`);
        params.push(filter.value);
        i++;
        break;
      case '>':
        clauses.push(`${col} > $${i}`);
        params.push(filter.value);
        i++;
        break;
      case '>=':
        clauses.push(`${col} >= $${i}`);
        params.push(filter.value);
        i++;
        break;
      case 'in':
        clauses.push(`${col} = ANY($${i})`);
        params.push(filter.value);
        i++;
        break;
      case 'not-in':
        clauses.push(`${col} <> ALL($${i})`);
        params.push(filter.value);
        i++;
        break;
      case 'contains':
        clauses.push(`${col}::text ILIKE '%' || $${i} || '%'`);
        params.push(filter.value);
        i++;
        break;
      default:
        break;
    }
  }
  return {
    where: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
    params,
    nextIndex: i,
  };
}

export interface PageOptions {
  page: number;
  pageSize: number;
  search?: string;
  searchFields?: string[];
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export interface PageQueries {
  sql: string;
  countSql: string;
  params: (FieldValue | undefined)[];
}

/** WHERE (filters AND search) + ORDER BY sortBy NULLS LAST + LIMIT/OFFSET, plus a COUNT(*) twin for the total. */
export function buildPageQueries(
  table: string,
  filters: readonly SqlFilter[],
  options: PageOptions,
): PageQueries {
  const { where, params, nextIndex } = buildWhere(filters);
  const conds: string[] = where ? [where.slice(7)] : [];
  let i = nextIndex;

  if (options.search && options.search.trim()) {
    if (options.searchFields && options.searchFields.length > 0) {
      const parts = options.searchFields.map(
        (f) => `${quoteIdent(f)}::text ILIKE '%' || $${i} || '%'`,
      );
      conds.push(`(${parts.join(' OR ')})`);
    } else {
      conds.push(`t::text ILIKE '%' || $${i} || '%'`);
    }
    params.push(options.search);
    i++;
  }

  const whereSql = conds.length > 0 ? ` WHERE ${conds.join(' AND ')}` : '';
  const orderSql = options.sortBy
    ? ` ORDER BY ${quoteIdent(options.sortBy)} ${options.sortOrder === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`
    : '';
  const limitSql = ` LIMIT $${i} OFFSET $${i + 1}`;
  const pageParams = [...params, options.pageSize, (options.page - 1) * options.pageSize];

  return {
    sql: `SELECT * FROM ${quoteIdent(table)}${whereSql}${orderSql}${limitSql}`,
    countSql: `SELECT COUNT(*)::int AS total FROM ${quoteIdent(table)}${whereSql}`,
    params: pageParams,
  };
}
