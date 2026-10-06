/**
 * The one in-memory filter / search / sort / page implementation. Before, it existed twice (the
 * mock and Firebase data services, and CouchDB's rows helpers). It serves every store that cannot
 * push the work down, and the remainder a partial pushdown leaves (e.g. `contains` on Firestore).
 * These cases pin the behaviour both copies had.
 */
import { describe, it, expect } from 'vitest';
import type { EntityRow, StoreFilter } from '@almadar/core';
import { filterRows, pageRows, rowMatches } from '../src/data/row-query.js';

const rows: EntityRow[] = [
  { id: 'a', title: 'Alpha task', points: 3, tags: ['x', 'y'], owner: 'u1' },
  { id: 'b', title: 'beta Task', points: 8, tags: ['y'], owner: null },
  { id: 'c', title: 'Gamma', points: 5, tags: [], owner: 'u2' },
];

const f = (field: string, op: StoreFilter<EntityRow>['op'], value: StoreFilter<EntityRow>['value']): StoreFilter<EntityRow> => ({ field, op, value });

describe('rowMatches / filterRows', () => {
  it('compares with every operator', () => {
    const ids = (filters: StoreFilter<EntityRow>[]) => filterRows(rows, filters).map((r) => r.id);
    expect(ids([f('points', '==', 5)])).toEqual(['c']);
    expect(ids([f('points', '!=', 5)])).toEqual(['a', 'b']);
    expect(ids([f('points', '>', 3)])).toEqual(['b', 'c']);
    expect(ids([f('points', '>=', 5)])).toEqual(['b', 'c']);
    expect(ids([f('points', '<', 5)])).toEqual(['a']);
    expect(ids([f('points', '<=', 5)])).toEqual(['a', 'c']);
    expect(ids([f('owner', 'in', ['u1', 'u2'])])).toEqual(['a', 'c']);
    expect(ids([f('owner', 'not-in', ['u1'])])).toEqual(['c']);
    expect(ids([f('title', 'contains', 'task')])).toEqual(['a', 'b']);
    expect(ids([f('tags', 'array-contains', 'y')])).toEqual(['a', 'b']);
    expect(ids([f('tags', 'array-contains-any', ['x', 'z'])])).toEqual(['a']);
  });

  it('control: several filters must all match', () => {
    expect(filterRows(rows, [f('points', '>', 2), f('tags', 'array-contains', 'x')]).map((r) => r.id)).toEqual(['a']);
  });

  it('edge: a missing or null value matches only != against a non-null value', () => {
    expect(rowMatches({ id: 'z' }, f('owner', '==', 'u1'))).toBe(false);
    expect(rowMatches({ id: 'z', owner: null }, f('owner', '!=', 'u1'))).toBe(true);
    expect(rowMatches({ id: 'z', owner: null }, f('owner', '!=', null))).toBe(false);
  });
});

describe('pageRows', () => {
  it('filters, then searches case-insensitively, then sorts, then pages', () => {
    const page = pageRows(rows, { page: 1, pageSize: 1, filters: [f('points', '>', 2)], search: 'TASK', sortBy: 'points', sortOrder: 'desc' });
    expect(page).toEqual({ rows: [rows[1]], total: 2 });
    expect(pageRows(rows, { page: 2, pageSize: 1, search: 'task', sortBy: 'points', sortOrder: 'desc' }).rows.map((r) => r.id)).toEqual(['a']);
  });

  it('searches only the named fields when given', () => {
    expect(pageRows(rows, { page: 1, pageSize: 10, search: 'u2', searchFields: ['title'] }).total).toBe(0);
    expect(pageRows(rows, { page: 1, pageSize: 10, search: 'u2', searchFields: ['owner'] }).total).toBe(1);
  });

  it('edge: sorting puts missing values last in both directions', () => {
    const withGap: EntityRow[] = [{ id: '1', n: 2 }, { id: '2' }, { id: '3', n: 1 }];
    expect(pageRows(withGap, { page: 1, pageSize: 10, sortBy: 'n' }).rows.map((r) => r.id)).toEqual(['3', '1', '2']);
    expect(pageRows(withGap, { page: 1, pageSize: 10, sortBy: 'n', sortOrder: 'desc' }).rows.map((r) => r.id)).toEqual(['1', '3', '2']);
  });

  it('edge: a page past the end is empty but still reports the total', () => {
    expect(pageRows(rows, { page: 9, pageSize: 2 })).toEqual({ rows: [], total: 3 });
  });
});
