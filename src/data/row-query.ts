/**
 * In-memory filter / search / sort / page over entity rows: the one implementation used by stores
 * that cannot push the work down, and for the remainder a partial pushdown leaves.
 */
import type { EntityRow, FieldValue, RowPage, RowPageRequest, StoreFilter } from '@almadar/core';

type Comparable = string | number | boolean | Date;

function comparable(value: FieldValue | undefined): value is Comparable {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

function order(a: Comparable, b: Comparable): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

function listOf(value: FieldValue | undefined): readonly FieldValue[] | null {
  return Array.isArray(value) ? value : null;
}

/** Whether `row` satisfies one filter. A missing or null value matches only `!=` a non-null value. */
export function rowMatches(row: EntityRow, filter: StoreFilter<EntityRow>): boolean {
  const value = row[filter.field];
  const target = filter.value;
  if (value === null || value === undefined) return filter.op === '!=' && target !== null && target !== undefined;
  switch (filter.op) {
    case '==': return value === target;
    case '!=': return value !== target;
    case '>': return comparable(target) && comparable(value) && order(value, target) > 0;
    case '>=': return comparable(target) && comparable(value) && order(value, target) >= 0;
    case '<': return comparable(target) && comparable(value) && order(value, target) < 0;
    case '<=': return comparable(target) && comparable(value) && order(value, target) <= 0;
    case 'in': return listOf(target)?.includes(value) ?? false;
    case 'not-in': return !(listOf(target)?.includes(value) ?? true);
    case 'contains': return typeof value === 'string' && typeof target === 'string' && value.toLowerCase().includes(target.toLowerCase());
    case 'array-contains': return target !== undefined && (listOf(value)?.includes(target) ?? false);
    case 'array-contains-any': {
      const have = listOf(value);
      const want = listOf(target);
      return have !== null && want !== null && want.some((v) => have.includes(v));
    }
  }
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
  return [...rows].sort((a, b) => {
    const x = a[sortBy];
    const y = b[sortBy];
    const xMissing = x === null || x === undefined;
    const yMissing = y === null || y === undefined;
    if (xMissing || yMissing) return xMissing === yMissing ? 0 : xMissing ? 1 : -1;
    if (!comparable(x) || !comparable(y)) return 0;
    const c = order(x, y);
    return sortOrder === 'asc' ? c : -c;
  });
}

export function pageRows(rows: readonly EntityRow[], request: RowPageRequest<EntityRow>): RowPage<EntityRow> {
  const matched = sortRows(searchRows(filterRows(rows, request.filters ?? []), request.search, request.searchFields), request.sortBy, request.sortOrder);
  const start = (request.page - 1) * request.pageSize;
  return { rows: matched.slice(start, start + request.pageSize), total: matched.length };
}
