/**
 * In-memory filter / search / sort / page over entity rows: the one implementation used by stores
 * that cannot push the work down, and for the remainder a partial pushdown leaves.
 */
import { compareByField, rowMatchesPredicate, type EntityRow, type FieldValue, type RowPage, type RowPageRequest, type RowPredicate, type StoreFilter } from '@almadar/core';

function listOf(value: FieldValue | undefined): readonly FieldValue[] | null {
  return Array.isArray(value) ? value : null;
}

function predicateOf(filter: StoreFilter<EntityRow>): RowPredicate {
  const { field, value } = filter;
  const target = value ?? null;
  switch (filter.op) {
    case '==':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return { kind: 'compare', field, op: filter.op, value: target };
    case 'in': {
      const values = listOf(value);
      return values ? { kind: 'member', field, values: [...values] } : { kind: 'const', value: false };
    }
    case 'not-in': {
      const values = listOf(value);
      return values
        ? { kind: 'all', of: [{ kind: 'isNull', field, isNull: false }, { kind: 'not', of: { kind: 'member', field, values: [...values] } }] }
        : { kind: 'const', value: false };
    }
    case 'contains':
      return typeof value === 'string' ? { kind: 'contains', field, text: value, caseSensitive: false } : { kind: 'const', value: false };
    case 'array-contains':
      return target === null ? { kind: 'const', value: false } : { kind: 'hasElement', field, value: target };
    case 'array-contains-any': {
      const values = listOf(value);
      return { kind: 'any', of: (values ?? []).map((v) => ({ kind: 'hasElement', field, value: v })) };
    }
  }
}

/** Whether `row` satisfies one filter. A missing or null value matches only `!=` a non-null value. */
export function rowMatches(row: EntityRow, filter: StoreFilter<EntityRow>): boolean {
  return rowMatchesPredicate(row, predicateOf(filter));
}

export function filterRows(rows: readonly EntityRow[], filters: readonly StoreFilter<EntityRow>[]): EntityRow[] {
  return rows.filter((row) => filters.every((filter) => rowMatches(row, filter)));
}

function searchRows(rows: readonly EntityRow[], search: string | undefined, fields: readonly string[] | undefined): EntityRow[] {
  if (!search || !search.trim()) return [...rows];
  const needle = search.toLowerCase();
  return rows.filter((row) => (fields ?? Object.keys(row)).some((field) => {
    const value = row[field];
    return value !== null && value !== undefined && String(value).toLowerCase().includes(needle);
  }));
}

/** Missing values sort last in both directions. */
export function sortRows(rows: readonly EntityRow[], sortBy: string | undefined, sortOrder: 'asc' | 'desc' = 'asc'): EntityRow[] {
  if (!sortBy) return [...rows];
  return [...rows].sort(compareByField(sortBy, sortOrder));
}

export function pageRows(rows: readonly EntityRow[], request: RowPageRequest<EntityRow>): RowPage<EntityRow> {
  const matched = sortRows(searchRows(filterRows(rows, request.filters ?? []), request.search, request.searchFields), request.sortBy, request.sortOrder);
  const start = (request.page - 1) * request.pageSize;
  return { rows: matched.slice(start, start + request.pageSize), total: matched.length };
}

/**
 * The match count of a windowed read, when the window alone settles it: a non-empty window that
 * ended before its limit holds the last match, an empty first page means no match. Null means the
 * store must count (a full window, a window past the end, a zero limit).
 */
export function totalFromWindow(returned: number, offset: number, limit: number | undefined): number | null {
  if (returned > 0) return limit === undefined || returned < limit ? offset + returned : null;
  return offset === 0 && limit !== 0 ? 0 : null;
}
