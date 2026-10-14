import { describe, it, expect } from 'vitest';
import type { RowQuery } from '@almadar/core';
import { firestoreQueryCapabilities, planQuery } from '../src/firestore/query-plan.js';
import { totalFromWindow } from '../src/data/row-query.js';

const plan = (query: RowQuery, orderable: readonly string[] = []) => planQuery(query, orderable);

describe('firestoreQueryCapabilities', () => {
  it('lists exactly what native filters express with the shared semantics', () => {
    expect(firestoreQueryCapabilities([])).toEqual({
      leaves: ['compare', 'member', 'hasElement'],
      combinators: ['all'],
      compareOps: ['=='],
      orderableFields: { kind: 'listed', fields: ['id'] },
      window: true,
      exactTotal: true,
    });
  });
  it('adds only the fields the host guarantees every document carries', () => {
    expect(firestoreQueryCapabilities(['createdAt']).orderableFields).toEqual({ kind: 'listed', fields: ['id', 'createdAt'] });
  });
});

describe('planQuery', () => {
  it('no query: every document by document id', () => {
    expect(plan({})).toEqual({ wheres: [], orderBy: [{ field: '__name__', direction: 'asc' }] });
  });

  it('policy and filter become one AND of where clauses; id maps to the document id', () => {
    expect(
      plan({
        policy: { kind: 'compare', field: 'owner', op: '==', value: 'u1' },
        filter: { kind: 'all', of: [{ kind: 'compare', field: 'priority', op: '==', value: 3 }, { kind: 'compare', field: 'id', op: '==', value: 't09' }] },
      })?.wheres,
    ).toEqual([
      { field: 'owner', op: '==', value: 'u1' },
      { field: 'priority', op: '==', value: 3 },
      { field: '__name__', op: '==', value: 't09' },
    ]);
  });

  it('member is in, hasElement is array-contains', () => {
    expect(plan({ filter: { kind: 'member', field: 'status', values: ['a', null, 'b'] } })?.wheres).toEqual([{ field: 'status', op: 'in', value: ['a', 'b'] }]);
    expect(plan({ filter: { kind: 'hasElement', field: 'tags', value: 'c' } })?.wheres).toEqual([{ field: 'tags', op: 'array-contains', value: 'c' }]);
  });

  it('a predicate that can match nothing plans to null, before any read', () => {
    expect(plan({ policy: { kind: 'const', value: false } })).toBeNull();
    expect(plan({ filter: { kind: 'member', field: 's', values: [null] } })).toBeNull();
    expect(plan({ filter: { kind: 'compare', field: 'a', op: '==', value: null } })).toBeNull();
    expect(plan({ filter: { kind: 'compare', field: 'a', op: '==', value: ['x'] } })).toBeNull();
    expect(plan({ filter: { kind: 'hasElement', field: 'a', value: ['x'] } })).toBeNull();
    expect(plan({ filter: { kind: 'all', of: [{ kind: 'const', value: false }, { kind: 'compare', field: 'a', op: '==', value: 1 }] } })).toBeNull();
  });

  it('control: a true predicate adds no clause', () => {
    expect(plan({ policy: { kind: 'const', value: true }, filter: { kind: 'all', of: [] } })?.wheres).toEqual([]);
  });

  it('order: id either way is the document id; a declared field gets the id tie-break', () => {
    expect(plan({ order: { field: 'id', direction: 'desc' } })?.orderBy).toEqual([{ field: '__name__', direction: 'desc' }]);
    expect(plan({ order: { field: 'createdAt', direction: 'desc' } }, ['createdAt'])?.orderBy).toEqual([
      { field: 'createdAt', direction: 'desc' },
      { field: '__name__', direction: 'asc' },
    ]);
  });

  it('the window is carried as given', () => {
    expect(plan({ offset: 5, limit: 2 })).toMatchObject({ offset: 5, limit: 2 });
    expect(plan({})).not.toHaveProperty('offset');
    expect(plan({})).not.toHaveProperty('limit');
  });

  it('refuses what the capabilities exclude instead of guessing', () => {
    expect(() => plan({ filter: { kind: 'compare', field: 'a', op: '!=', value: 1 } })).toThrow(/leaf-unsupported/);
    expect(() => plan({ filter: { kind: 'compare', field: 'a', op: '>', value: 1 } })).toThrow(/leaf-unsupported/);
    expect(() => plan({ filter: { kind: 'any', of: [] } })).toThrow(/combinator-unsupported/);
    expect(() => plan({ order: { field: 'score', direction: 'asc' } })).toThrow(/order-field/);
    expect(() => plan({ filter: { kind: 'isNull', field: 'a', isNull: false } })).toThrow(/leaf-unsupported/);
  });

  it('refuses a membership list past the in limit', () => {
    const values = Array.from({ length: 31 }, (_, i) => `v${i}`);
    expect(() => plan({ filter: { kind: 'member', field: 'a', values } })).toThrow(/30/);
    expect(plan({ filter: { kind: 'member', field: 'a', values: values.slice(0, 30) } })?.wheres).toHaveLength(1);
  });
});

describe('totalFromWindow', () => {
  it('knows the total only when the window ended before its limit', () => {
    expect(totalFromWindow(2, 3, 4)).toBe(5);
    expect(totalFromWindow(4, 0, 4)).toBeNull();
    expect(totalFromWindow(7, 1, undefined)).toBe(8);
  });
  it('an empty first page is total 0, a past-the-end window is unknown, a zero limit is unknown', () => {
    expect(totalFromWindow(0, 0, 10)).toBe(0);
    expect(totalFromWindow(0, 0, undefined)).toBe(0);
    expect(totalFromWindow(0, 50, 5)).toBeNull();
    expect(totalFromWindow(0, 0, 0)).toBeNull();
  });
});
