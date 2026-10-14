import { describe, it, expect } from 'vitest';
import type { RowQuery } from '@almadar/core';
import { buildQueryPageSql, type SqlColumnKind } from '../src/postgres/rows.js';

const kinds: Record<string, SqlColumnKind> = { id: 'text', title: 'text', status: 'text', priority: 'other', owner: 'text', tags: 'jsonb', score: 'other', labels: 'array', ghost: 'absent' };
const kindOf = (field: string): SqlColumnKind => kinds[field] ?? 'other';
const build = (query: RowQuery) => buildQueryPageSql('tickets', query, kindOf);

describe('buildQueryPageSql', () => {
  it('no query: every row in id order, in a binary collation, with the total from a window count', () => {
    const q = build({});
    expect(q.sql).toBe('SELECT *, (COUNT(*) OVER ())::int AS "__total" FROM "tickets" ORDER BY "id" COLLATE "C" ASC');
    expect(q.params).toEqual([]);
    expect(q.countSql).toBe('SELECT COUNT(*)::int AS total FROM "tickets"');
    expect(q.countParams).toEqual([]);
  });

  it('policy AND filter, parameterized, two-valued per leaf', () => {
    const q = build({
      policy: { kind: 'compare', field: 'owner', op: '==', value: 'u1' },
      filter: { kind: 'compare', field: 'status', op: '!=', value: 'open' },
    });
    expect(q.sql).toBe(
      'SELECT *, (COUNT(*) OVER ())::int AS "__total" FROM "tickets" WHERE COALESCE("owner" = $1, FALSE) AND "status" IS DISTINCT FROM $2 ORDER BY "id" COLLATE "C" ASC',
    );
    expect(q.params).toEqual(['u1', 'open']);
    expect(q.countSql).toBe('SELECT COUNT(*)::int AS total FROM "tickets" WHERE COALESCE("owner" = $1, FALSE) AND "status" IS DISTINCT FROM $2');
    expect(q.countParams).toEqual(['u1', 'open']);
  });

  it('order puts nulls last in both directions and breaks ties by id; text columns sort in the C collation', () => {
    expect(build({ order: { field: 'score', direction: 'desc' } }).sql).toContain('ORDER BY "score" DESC NULLS LAST, "id" COLLATE "C" ASC');
    expect(build({ order: { field: 'title', direction: 'asc' } }).sql).toContain('ORDER BY "title" COLLATE "C" ASC NULLS LAST, "id" COLLATE "C" ASC');
    expect(build({ order: { field: 'id', direction: 'desc' } }).sql).toContain('ORDER BY "id" COLLATE "C" DESC NULLS LAST, "id" COLLATE "C" ASC');
  });

  it('window: limit then offset as parameters after the filter parameters; no limit means offset only', () => {
    const both = build({ filter: { kind: 'compare', field: 'status', op: '==', value: 'open' }, offset: 5, limit: 2 });
    expect(both.sql).toContain('LIMIT $2 OFFSET $3');
    expect(both.params).toEqual(['open', 2, 5]);
    expect(both.countParams).toEqual(['open']);
    const offsetOnly = build({ offset: 6 });
    expect(offsetOnly.sql).toContain('OFFSET $1');
    expect(offsetOnly.sql).not.toContain('LIMIT');
    expect(offsetOnly.params).toEqual([6]);
    const limitOnly = build({ limit: 4 });
    expect(limitOnly.sql).toContain('LIMIT $1');
    expect(limitOnly.sql).not.toContain('OFFSET');
  });

  it('compare ordering ops collate text columns when the value is a string, not otherwise', () => {
    expect(build({ filter: { kind: 'compare', field: 'title', op: '<', value: 'M' } }).sql).toContain('COALESCE("title" COLLATE "C" < $1, FALSE)');
    expect(build({ filter: { kind: 'compare', field: 'priority', op: '>=', value: 3 } }).sql).toContain('COALESCE("priority" >= $1, FALSE)');
  });

  it('null and non-scalar compare targets', () => {
    const where = (filter: RowQuery['filter']) => build({ filter }).sql;
    expect(where({ kind: 'compare', field: 'owner', op: '==', value: null })).toContain('WHERE FALSE');
    expect(where({ kind: 'compare', field: 'owner', op: '!=', value: null })).toContain('WHERE "owner" IS NOT NULL');
    expect(where({ kind: 'compare', field: 'tags', op: '==', value: ['a'] })).toContain('WHERE FALSE');
    expect(where({ kind: 'compare', field: 'tags', op: '<', value: ['a'] })).toContain('WHERE FALSE');
    expect(where({ kind: 'compare', field: 'tags', op: '!=', value: ['a'] })).toContain('WHERE TRUE');
  });

  it('member drops nulls and is FALSE when nothing is left; hasElement follows the column type', () => {
    const q = build({ filter: { kind: 'member', field: 'status', values: ['closed', null, 'archived'] } });
    expect(q.sql).toContain('WHERE COALESCE("status" = ANY($1), FALSE)');
    expect(q.params).toEqual([['closed', 'archived']]);
    expect(build({ filter: { kind: 'member', field: 'status', values: [null] } }).sql).toContain('WHERE FALSE');
    const jsonb = build({ filter: { kind: 'hasElement', field: 'tags', value: 'c' } });
    expect(jsonb.sql).toContain('WHERE COALESCE("tags" @> $1::jsonb, FALSE)');
    expect(jsonb.params).toEqual(['["c"]']);
    expect(build({ filter: { kind: 'hasElement', field: 'labels', value: 'c' } }).sql).toContain('WHERE COALESCE($1 = ANY("labels"), FALSE)');
    expect(build({ filter: { kind: 'hasElement', field: 'title', value: 'c' } }).sql).toContain('WHERE FALSE');
  });

  it('contains uses position, never LIKE, so % and _ are literal; non-text columns never match', () => {
    const ci = build({ filter: { kind: 'contains', field: 'title', text: '50%_', caseSensitive: false } });
    expect(ci.sql).toContain('WHERE COALESCE(position(lower($1::text) in lower("title")) > 0, FALSE)');
    expect(ci.params).toEqual(['50%_']);
    expect(build({ filter: { kind: 'contains', field: 'title', text: 'A', caseSensitive: true } }).sql).toContain('COALESCE(position($1::text in "title") > 0, FALSE)');
    expect(build({ filter: { kind: 'contains', field: 'priority', text: '1', caseSensitive: true } }).sql).toContain('WHERE FALSE');
  });

  it('combinators: empty all is TRUE, empty any is FALSE, not wraps a two-valued child', () => {
    const where = (filter: RowQuery['filter']) => build({ filter }).sql;
    expect(where({ kind: 'all', of: [] })).toContain('WHERE TRUE');
    expect(where({ kind: 'any', of: [] })).toContain('WHERE FALSE');
    expect(where({ kind: 'not', of: { kind: 'compare', field: 'priority', op: '>', value: 3 } })).toContain('WHERE NOT (COALESCE("priority" > $1, FALSE))');
    expect(where({ kind: 'any', of: [{ kind: 'isNull', field: 'score', isNull: true }, { kind: 'isNull', field: 'owner', isNull: false }] })).toContain(
      'WHERE ("score" IS NULL OR "owner" IS NOT NULL)',
    );
  });

  it('control: a field name with a quote is quoted, never spliced', () => {
    expect(build({ filter: { kind: 'isNull', field: 'a"; DROP TABLE x;--', isNull: true } }).sql).toContain('"a""; DROP TABLE x;--" IS NULL');
  });
});

describe('buildQueryPageSql over a column the table does not have', () => {
  const where = (filter: RowQuery['filter']) => build({ filter }).sql;
  it('behaves as a field every row is missing, with no parameter bound', () => {
    expect(where({ kind: 'isNull', field: 'ghost', isNull: true })).toContain('WHERE TRUE');
    expect(where({ kind: 'isNull', field: 'ghost', isNull: false })).toContain('WHERE FALSE');
    expect(where({ kind: 'compare', field: 'ghost', op: '!=', value: 'x' })).toContain('WHERE TRUE');
    expect(where({ kind: 'compare', field: 'ghost', op: '!=', value: null })).toContain('WHERE FALSE');
    expect(where({ kind: 'compare', field: 'ghost', op: '==', value: 'x' })).toContain('WHERE FALSE');
    expect(where({ kind: 'compare', field: 'ghost', op: '>', value: 1 })).toContain('WHERE FALSE');
    expect(where({ kind: 'member', field: 'ghost', values: ['x'] })).toContain('WHERE FALSE');
    expect(where({ kind: 'hasElement', field: 'ghost', value: 'x' })).toContain('WHERE FALSE');
    expect(where({ kind: 'contains', field: 'ghost', text: 'x', caseSensitive: false })).toContain('WHERE FALSE');
    expect(build({ filter: { kind: 'compare', field: 'ghost', op: '==', value: 'x' } }).params).toEqual([]);
  });
  it('an order on it is ties-by-id only', () => {
    expect(build({ order: { field: 'ghost', direction: 'desc' } }).sql).toContain('ORDER BY "id" COLLATE "C" ASC');
    expect(build({ order: { field: 'ghost', direction: 'desc' } }).sql).not.toContain('ghost');
  });
  it('control: a present column still binds its parameter', () => {
    expect(build({ filter: { kind: 'compare', field: 'status', op: '==', value: 'x' } }).params).toEqual(['x']);
  });
});
