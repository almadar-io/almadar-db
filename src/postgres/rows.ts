/**
 * Shared internals for the Postgres adapters — table naming, id minting,
 * row (de)serialization, and parameterized WHERE / pagination SQL building.
 * Used by BOTH PostgresDataService and PostgresPersistence (no duplication).
 */
import { randomUUID } from 'node:crypto';
import type { FieldValue, RowPredicate, RowQuery } from '@almadar/core';

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

/** What a column holds, as far as a query translation needs to know. */
/** `absent`: the table has no such column, so every row is missing the field. */
export type SqlColumnKind = 'text' | 'jsonb' | 'array' | 'other' | 'absent';

export interface QuerySql {
  /** The window of rows, each carrying the match count as `__total`. */
  sql: string;
  params: (FieldValue | undefined)[];
  /** The match count alone, for a window that returns no row. */
  countSql: string;
  countParams: (FieldValue | undefined)[];
}

function isScalar(value: FieldValue): value is string | number | boolean | Date {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

interface PredicateSqlContext {
  kindOf: (field: string) => SqlColumnKind;
  params: (FieldValue | undefined)[];
}

function bind(ctx: PredicateSqlContext, value: FieldValue): string {
  ctx.params.push(value);
  return `$${ctx.params.length}`;
}

function compareSql(ctx: PredicateSqlContext, predicate: RowPredicate & { kind: 'compare' }): string {
  const col = quoteIdent(predicate.field);
  const { op, value } = predicate;
  if (value === null) return op === '!=' ? `${col} IS NOT NULL` : 'FALSE';
  if (!isScalar(value)) return op === '!=' ? 'TRUE' : 'FALSE';
  if (op === '==') return `COALESCE(${col} = ${bind(ctx, value)}, FALSE)`;
  if (op === '!=') return `${col} IS DISTINCT FROM ${bind(ctx, value)}`;
  const collate = typeof value === 'string' && ctx.kindOf(predicate.field) === 'text' ? ' COLLATE "C"' : '';
  return `COALESCE(${col}${collate} ${op} ${bind(ctx, value)}, FALSE)`;
}

function absentSql(predicate: RowPredicate & { field: string }): string {
  switch (predicate.kind) {
    case 'isNull': return predicate.isNull ? 'TRUE' : 'FALSE';
    case 'compare': return predicate.op === '!=' && predicate.value !== null ? 'TRUE' : 'FALSE';
    default: return 'FALSE';
  }
}

function predicateSql(ctx: PredicateSqlContext, predicate: RowPredicate): string {
  if ('field' in predicate && ctx.kindOf(predicate.field) === 'absent') return absentSql(predicate);
  switch (predicate.kind) {
    case 'const': return predicate.value ? 'TRUE' : 'FALSE';
    case 'compare': return compareSql(ctx, predicate);
    case 'isNull': return `${quoteIdent(predicate.field)} ${predicate.isNull ? 'IS NULL' : 'IS NOT NULL'}`;
    case 'member': {
      const values = predicate.values.filter((v) => v !== null && isScalar(v));
      return values.length === 0 ? 'FALSE' : `COALESCE(${quoteIdent(predicate.field)} = ANY(${bind(ctx, values)}), FALSE)`;
    }
    case 'hasElement': {
      const kind = ctx.kindOf(predicate.field);
      if (kind === 'jsonb') return `COALESCE(${quoteIdent(predicate.field)} @> ${bind(ctx, JSON.stringify([predicate.value]))}::jsonb, FALSE)`;
      if (kind === 'array') return `COALESCE(${bind(ctx, predicate.value)} = ANY(${quoteIdent(predicate.field)}), FALSE)`;
      return 'FALSE';
    }
    case 'contains': {
      if (ctx.kindOf(predicate.field) !== 'text') return 'FALSE';
      const col = quoteIdent(predicate.field);
      return predicate.caseSensitive
        ? `COALESCE(position(${bind(ctx, predicate.text)}::text in ${col}) > 0, FALSE)`
        : `COALESCE(position(lower(${bind(ctx, predicate.text)}::text) in lower(${col})) > 0, FALSE)`;
    }
    case 'all': return predicate.of.length === 0 ? 'TRUE' : `(${predicate.of.map((p) => predicateSql(ctx, p)).join(' AND ')})`;
    case 'any': return predicate.of.length === 0 ? 'FALSE' : `(${predicate.of.map((p) => predicateSql(ctx, p)).join(' OR ')})`;
    case 'not': return `NOT (${predicateSql(ctx, predicate.of)})`;
  }
}

/**
 * A `RowQuery` as parameterized SQL with the semantics `runRowQuery` defines: two-valued null logic
 * (every leaf is a boolean, never NULL), nulls last in both directions, ties by `id` ascending, and
 * binary (`COLLATE "C"`) order on text columns. `kindOf` is the column's declared storage kind.
 */
export function buildQueryPageSql(table: string, query: RowQuery, kindOf: (field: string) => SqlColumnKind): QuerySql {
  const ctx: PredicateSqlContext = { kindOf, params: [] };
  const conditions = [query.policy, query.filter]
    .filter((p): p is RowPredicate => p !== undefined)
    .map((p) => predicateSql(ctx, p));
  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  const countParams = [...ctx.params];

  const collate = (field: string): string => (kindOf(field) === 'text' ? ' COLLATE "C"' : '');
  const tieBreak = `${quoteIdent('id')}${collate('id')} ASC`;
  const orderSql = query.order && kindOf(query.order.field) !== 'absent'
    ? ` ORDER BY ${quoteIdent(query.order.field)}${collate(query.order.field)} ${query.order.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${tieBreak}`
    : ` ORDER BY ${tieBreak}`;

  let windowSql = '';
  if (query.limit !== undefined) windowSql += ` LIMIT ${bind(ctx, query.limit)}`;
  if (query.offset !== undefined) windowSql += ` OFFSET ${bind(ctx, query.offset)}`;

  const from = quoteIdent(table);
  return {
    sql: `SELECT *, (COUNT(*) OVER ())::int AS "__total" FROM ${from}${whereSql}${orderSql}${windowSql}`,
    params: ctx.params,
    countSql: `SELECT COUNT(*)::int AS total FROM ${from}${whereSql}`,
    countParams,
  };
}

/** Every field a query names, including the `id` tie-break. */
export function queryFields(query: RowQuery): string[] {
  const fields = new Set<string>(['id']);
  const walk = (p: RowPredicate | undefined): void => {
    if (!p) return;
    if ('field' in p) fields.add(p.field);
    if (p.kind === 'all' || p.kind === 'any') p.of.forEach(walk);
    if (p.kind === 'not') walk(p.of);
  };
  walk(query.policy);
  walk(query.filter);
  if (query.order) fields.add(query.order.field);
  return [...fields];
}

/** The storage kind of an `information_schema.columns.data_type`. */
export function columnKindOf(dataType: string): SqlColumnKind {
  if (dataType === 'text' || dataType === 'character varying' || dataType === 'character') return 'text';
  if (dataType === 'jsonb') return 'jsonb';
  if (dataType === 'ARRAY') return 'array';
  return 'other';
}
