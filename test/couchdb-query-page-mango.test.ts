import { describe, it, expect } from 'vitest';
import type { RowQuery } from '@almadar/core';
import { COUCHDB_QUERY_CAPABILITIES, mangoQueryFor } from '../src/couchdb/rows.js';

const sel = (filter: RowQuery['filter'], policy?: RowQuery['policy']) =>
  mangoQueryFor({ ...(filter ? { filter } : {}), ...(policy ? { policy } : {}) }).selector;
const ID = { _id: { $gt: null } };

describe('COUCHDB_QUERY_CAPABILITIES', () => {
  it('lists exactly what Mango expresses with the shared semantics', () => {
    expect(COUCHDB_QUERY_CAPABILITIES).toEqual({
      leaves: ['compare', 'member', 'hasElement', 'isNull'],
      combinators: ['all', 'any', 'not'],
      compareOps: ['==', '!='],
      orderableFields: { kind: 'listed', fields: ['id'] },
      window: true,
      exactTotal: true,
    });
  });
});

describe('mangoQueryFor', () => {
  it('no query: every document through the primary index, in _id order', () => {
    expect(mangoQueryFor({})).toEqual({ selector: { $and: [ID] }, sort: [{ _id: 'asc' }] });
    expect(mangoQueryFor({ order: { field: 'id', direction: 'desc' } }).sort).toEqual([{ _id: 'desc' }]);
  });

  it('== is $eq and requires the field; != also matches a missing field', () => {
    expect(sel({ kind: 'compare', field: 'status', op: '==', value: 'open' })).toEqual({ $and: [ID, { status: { $eq: 'open' } }] });
    expect(sel({ kind: 'compare', field: 'priority', op: '!=', value: 5 })).toEqual({
      $and: [ID, { $or: [{ priority: { $exists: false } }, { priority: { $ne: 5 } }] }],
    });
  });

  it('null and non-scalar compare targets follow the shared semantics', () => {
    expect(sel({ kind: 'compare', field: 'a', op: '==', value: null })).toEqual({ $and: [ID, { _id: { $exists: false } }] });
    expect(sel({ kind: 'compare', field: 'a', op: '!=', value: null })).toEqual({ $and: [ID, { $and: [{ a: { $exists: true } }, { a: { $ne: null } }] }] });
    expect(sel({ kind: 'compare', field: 'a', op: '==', value: ['x'] })).toEqual({ $and: [ID, { _id: { $exists: false } }] });
    expect(sel({ kind: 'compare', field: 'a', op: '!=', value: ['x'] })).toEqual({ $and: [ID, { _id: { $exists: true } }] });
  });

  it('a Date target is compared as its ISO string, the form documents store', () => {
    expect(sel({ kind: 'compare', field: 'at', op: '==', value: new Date('2026-01-02T03:04:05.000Z') })).toEqual({
      $and: [ID, { at: { $eq: '2026-01-02T03:04:05.000Z' } }],
    });
  });

  it('member drops nulls and non-scalars; hasElement is $elemMatch; isNull covers missing and null', () => {
    expect(sel({ kind: 'member', field: 's', values: ['a', null, ['x'], 'b'] })).toEqual({ $and: [ID, { s: { $in: ['a', 'b'] } }] });
    expect(sel({ kind: 'member', field: 's', values: [null] })).toEqual({ $and: [ID, { _id: { $exists: false } }] });
    expect(sel({ kind: 'hasElement', field: 'tags', value: 'c' })).toEqual({ $and: [ID, { tags: { $elemMatch: { $eq: 'c' } } }] });
    expect(sel({ kind: 'isNull', field: 'score', isNull: true })).toEqual({ $and: [ID, { $or: [{ score: { $exists: false } }, { score: { $eq: null } }] }] });
    expect(sel({ kind: 'isNull', field: 'score', isNull: false })).toEqual({ $and: [ID, { $and: [{ score: { $exists: true } }, { score: { $ne: null } }] }] });
  });

  it('combinators nest, and policy comes before filter', () => {
    const eq = (field: string, value: string): RowQuery['filter'] => ({ kind: 'compare', field, op: '==', value });
    expect(sel({ kind: 'not', of: { kind: 'any', of: [eq('a', '1'), eq('b', '2')] } }, eq('owner', 'u1'))).toEqual({
      $and: [ID, { owner: { $eq: 'u1' } }, { $not: { $or: [{ a: { $eq: '1' } }, { b: { $eq: '2' } }] } }],
    });
    expect(sel({ kind: 'all', of: [] })).toEqual({ $and: [ID, { _id: { $exists: true } }] });
    expect(sel({ kind: 'any', of: [] })).toEqual({ $and: [ID, { _id: { $exists: false } }] });
  });

  it('refuses what the capabilities exclude instead of guessing', () => {
    expect(() => sel({ kind: 'compare', field: 'a', op: '<', value: 1 })).toThrow(/leaf-unsupported/);
    expect(() => sel({ kind: 'contains', field: 'a', text: 'x', caseSensitive: true })).toThrow(/leaf-unsupported/);
    expect(() => mangoQueryFor({ order: { field: 'score', direction: 'asc' } })).toThrow(/order-field/);
  });
});

describe('mangoQueryFor edge', () => {
  it('hasElement with a non-scalar value matches nothing, like the shared evaluator', () => {
    expect(sel({ kind: 'hasElement', field: 'tags', value: ['x'] })).toEqual({ $and: [ID, { _id: { $exists: false } }] });
  });
});
