import { describe, it, expect, vi } from 'vitest';
import type { MangoQuery } from 'nano';
import { COUCHDB_QUERY_CAPABILITIES } from '../src/couchdb/rows.js';
import type { CouchDBClient, CouchDoc } from '../src/couchdb/rows.js';
import { CouchDBPersistence } from '../src/couchdb/persistence.js';
import { partitionCases } from './support/query-cases';

const doc = (id: string): CouchDoc => ({ _id: id, _rev: '1-x', id, n: 1 });

/** A Mango double that serves `matching` documents in _id order, honouring skip, limit, fields and bookmark. */
function client(matching: string[]) {
  const finds: MangoQuery[] = [];
  const find = vi.fn(async (query: MangoQuery) => {
    finds.push(query);
    const start = query.bookmark ? Number(query.bookmark) : (query.skip ?? 0);
    const end = start + (query.limit ?? 25);
    const slice = matching.slice(start, end);
    const docs = query.fields ? slice.map((id) => ({ _id: id, _rev: '' })) : slice.map(doc);
    return { docs, bookmark: String(end) };
  });
  const c: CouchDBClient = {
    db: { create: async () => ({}) },
    use: () => ({ insert: vi.fn(), get: vi.fn(), destroy: vi.fn(), list: vi.fn(), find }),
  };
  return { c, finds };
}

describe('CouchDBPersistence.queryPage', () => {
  it('declares the Mango capabilities', () => {
    const { c } = client([]);
    expect(new CouchDBPersistence({ client: c }).queryCapabilities('Task')).toEqual(COUCHDB_QUERY_CAPABILITIES);
  });

  it('a short window needs no count: skip and limit go to _find and the total is offset plus what came back', async () => {
    const { c, finds } = client(['a', 'b', 'c', 'd', 'e']);
    const page = await new CouchDBPersistence({ client: c }).queryPage('Task', { offset: 3, limit: 4 });
    expect(page.rows.map((r) => r.id)).toEqual(['d', 'e']);
    expect(page.total).toBe(5);
    expect(finds).toHaveLength(1);
    expect(finds[0]).toMatchObject({ skip: 3, limit: 4, sort: [{ _id: 'asc' }] });
  });

  it('strips _id and _rev from returned rows', async () => {
    const { c } = client(['a']);
    const page = await new CouchDBPersistence({ client: c }).queryPage('Task', { limit: 5 });
    expect(page.rows).toEqual([{ id: 'a', n: 1 }]);
  });

  it('a full window counts the matches by paging ids, so the total ignores the window', async () => {
    const { c, finds } = client(['a', 'b', 'c', 'd', 'e']);
    const page = await new CouchDBPersistence({ client: c, pageSize: 2 }).queryPage('Task', { limit: 2 });
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.total).toBe(5);
    const counts = finds.filter((q) => q.fields);
    expect(counts.map((q) => q.fields)).toEqual([['_id'], ['_id'], ['_id']]);
    expect(counts.map((q) => q.bookmark)).toEqual([undefined, '2', '4']);
  });

  it('no limit pages through the bookmark until a short page, applying skip once', async () => {
    const { c, finds } = client(['a', 'b', 'c', 'd', 'e']);
    const page = await new CouchDBPersistence({ client: c, pageSize: 2 }).queryPage('Task', { offset: 1 });
    expect(page.rows.map((r) => r.id)).toEqual(['b', 'c', 'd', 'e']);
    expect(page.total).toBe(5);
    expect(finds.map((q) => [q.skip, q.bookmark])).toEqual([[1, undefined], [undefined, '3'], [undefined, '5']]);
  });

  it('a window past the end returns no rows and the full total', async () => {
    const { c } = client(['a', 'b', 'c']);
    expect(await new CouchDBPersistence({ client: c }).queryPage('Task', { offset: 50, limit: 5 })).toEqual({ rows: [], total: 3 });
  });

  it('control: an empty result at offset 0 is total 0 without a count', async () => {
    const { c, finds } = client([]);
    expect(await new CouchDBPersistence({ client: c }).queryPage('Task', {})).toEqual({ rows: [], total: 0 });
    expect(finds).toHaveLength(1);
  });

  it('a zero limit still reports the total', async () => {
    const { c } = client(['a', 'b']);
    expect(await new CouchDBPersistence({ client: c }).queryPage('Task', { limit: 0 })).toEqual({ rows: [], total: 2 });
  });

  it('refuses a query outside its capabilities', async () => {
    const { c, finds } = client(['a']);
    await expect(
      new CouchDBPersistence({ client: c }).queryPage('Task', { filter: { kind: 'compare', field: 'n', op: '<', value: 3 } }),
    ).rejects.toThrow(/leaf-unsupported/);
    expect(finds).toEqual([]);
  });
});

describe('CouchDBPersistence.queryPage without a bookmark', () => {
  it('fails loudly rather than re-reading the first page forever', async () => {
    const c: CouchDBClient = {
      db: { create: async () => ({}) },
      use: () => ({
        insert: vi.fn(), get: vi.fn(), destroy: vi.fn(), list: vi.fn(),
        find: vi.fn(async () => ({ docs: [doc('a'), doc('b')] })),
      }),
    };
    await expect(new CouchDBPersistence({ client: c, pageSize: 2 }).queryPage('Task', {})).rejects.toThrow(/bookmark/);
  });
});

describe('CouchDBPersistence push-down coverage of the shared cases', () => {
  it('declines exactly the cases that order by a non-id field, compare with an ordering operator or use contains', () => {
    const { c } = client([]);
    const { supported, declined } = partitionCases(new CouchDBPersistence({ client: c }));
    expect(declined.map((x) => x.name)).toEqual([
      'filter-equals', 'order-desc-missing-last', 'order-asc-missing-last', 'order-ties-break-by-id', 'range-and',
      'range-skips-missing', 'not-over-missing-field', 'contains-case-insensitive', 'contains-case-sensitive', 'policy-hides-most-rows',
    ]);
    expect(supported).toHaveLength(19);
  });
});
