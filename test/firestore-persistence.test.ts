/**
 * One Firestore `PersistenceAdapter` for every Firestore-backed store. Before, there were three:
 * the playground's per-behavior store, the tenant credential store and (planned) hosted apps. Each
 * instance is rooted at a document path, so two apps rooted apart never see each other's rows.
 * It is pure storage; call records and quotas come from `observedPersistence`, over any backend.
 *
 * Runs on an in-process Firestore stand-in; the same contract runs on the emulator when
 * `FIRESTORE_EMULATOR_HOST` is set.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { DocumentData } from 'firebase-admin/firestore';
import type { StoreFilter, EntityRow, FieldValue } from '@almadar/core';
import { FirestorePersistence, type RowFirestore, type RowDoc, type RowCollection, type RowQuery, type RowWhereOp } from '../src/firestore/persistence.js';
import { filterRows } from '../src/data/row-query.js';

function memoryFirestore(): RowFirestore & { paths(): string[]; wheres: StoreFilter<EntityRow>[][] } {
  const wheres: StoreFilter<EntityRow>[][] = [];
  const tables = new Map<string, Map<string, DocumentData>>();
  const table = (path: string): Map<string, DocumentData> => {
    let t = tables.get(path);
    if (!t) tables.set(path, (t = new Map()));
    return t;
  };
  let nextId = 0;
  const snapshot = (path: string) => ({ docs: [...table(path).entries()].map(([id, data]) => ({ id, data: () => data })) });
  const query = (path: string, applied: StoreFilter<EntityRow>[]): RowQuery => ({
    where(field: string, op: RowWhereOp, value: FieldValue | undefined) { return query(path, [...applied, { field, op, value }]); },
    async get() {
      wheres.push(applied);
      const docs = snapshot(path).docs.filter((d) => filterRows([{ ...d.data(), id: d.id }], applied).length === 1);
      return { docs };
    },
  });
  const collection = (path: string): RowCollection => ({
    ...query(path, []),
    doc(id?: string): RowDoc {
      const docId = id ?? `auto-${++nextId}`;
      return {
        id: docId,
        async set(data: DocumentData, options?: { merge: boolean }) {
          const prior = options?.merge ? table(path).get(docId) ?? {} : {};
          table(path).set(docId, { ...prior, ...data });
        },
        async get() {
          const data = table(path).get(docId);
          return { exists: data !== undefined, data: () => data };
        },
        async delete() { table(path).delete(docId); },
      };
    },
    async count() {
      return table(path).size;
    },
  });
  return { collection, wheres, paths: () => [...tables.keys()].filter((p) => table(p).size > 0).sort() };
}

describe('FirestorePersistence', () => {
  let db: ReturnType<typeof memoryFirestore>;
  beforeEach(() => { db = memoryFirestore(); });

  it('stores rows under its root and reads them back', async () => {
    const store = new FirestorePersistence({ root: 'hosted/app-1', firestore: db });
    const { id } = await store.create('Order', { title: 'first' });
    await store.update('Order', id, { status: 'open' });
    expect(await store.getById('Order', id)).toEqual({ id, title: 'first', status: 'open' });
    expect(await store.list('Order')).toEqual([{ id, title: 'first', status: 'open' }]);
    expect(db.paths()).toEqual(['hosted/app-1/entities/Order/rows']);
    await store.delete('Order', id);
    expect(await store.getById('Order', id)).toBeNull();
  });

  it('edge: a row stored without an id field (older credential rows) still reads back with its document id', async () => {
    await db.collection('TenantCredential').doc('legacy-1').set({ cipher: 'x' });
    const store = new FirestorePersistence({ root: '', firestore: db });
    expect(await store.list('TenantCredential')).toEqual([{ cipher: 'x', id: 'legacy-1' }]);
    expect(await store.getById('TenantCredential', 'legacy-1')).toEqual({ cipher: 'x', id: 'legacy-1' });
  });

  it('keeps a supplied id', async () => {
    const store = new FirestorePersistence({ root: 'hosted/app-1', firestore: db });
    expect(await store.create('Order', { id: 'o-7', title: 't' })).toEqual({ id: 'o-7' });
  });

  it('control: two apps rooted apart never see each other\'s rows', async () => {
    const a = new FirestorePersistence({ root: 'hosted/app-a', firestore: db });
    const b = new FirestorePersistence({ root: 'hosted/app-b', firestore: db });
    await a.create('Order', { id: 'shared-id', owner: 'a' });
    expect(await b.list('Order')).toEqual([]);
    expect(await b.getById('Order', 'shared-id')).toBeNull();
  });

  it('an empty root keeps the credential store\'s top-level layout', async () => {
    const store = new FirestorePersistence({ root: '', firestore: db });
    await store.create('TenantCredential', { id: 'c1', cipher: 'x' });
    expect(db.paths()).toEqual(['TenantCredential']);
  });

  it('edge: a root that is not a document path is refused at construction', () => {
    expect(() => new FirestorePersistence({ root: 'hosted', firestore: db })).toThrow(/document path/);
  });

  it('counts an entity\'s rows under its root only', async () => {
    const a = new FirestorePersistence({ root: 'hosted/app-a', firestore: db });
    const b = new FirestorePersistence({ root: 'hosted/app-b', firestore: db });
    await a.create('Order', { id: '1' });
    await a.create('Order', { id: '2' });
    expect(await a.countRows('Order')).toBe(2);
    expect(await b.countRows('Order')).toBe(0);
  });
});

describe('FirestorePersistence encoding', () => {
  it('drops undefined fields, at any depth, so Firestore accepts the write (an unset optional field)', async () => {
    const db = memoryFirestore();
    const written: DocumentData[] = [];
    const strict: RowFirestore = {
      collection(path) {
        const inner = db.collection(path);
        return {
          ...inner,
          doc(id) {
            const d = inner.doc(id);
            return {
              ...d,
              async set(data: DocumentData, options?: { merge: boolean }) {
                if (JSON.stringify(data, (_k, v: FieldValue | undefined) => (v === undefined ? '__undefined__' : v)).includes('__undefined__')) {
                  throw new Error('Cannot use "undefined" as a Firestore value');
                }
                written.push(data);
                return d.set(data, options);
              },
            };
          },
        };
      },
    };
    const store = new FirestorePersistence({ root: 'hosted/app-1', firestore: strict });
    const { id } = await store.create('Note', { title: 't', parentId: undefined, meta: { a: 1, b: undefined }, tags: ['x'] });
    await store.update('Note', id, { title: 'u', icon: undefined });
    expect(await store.getById('Note', id)).toEqual({ id, title: 'u', meta: { a: 1 }, tags: ['x'] });
  });

  it('control: null is a value and is kept', async () => {
    const store = new FirestorePersistence({ root: 'hosted/app-1', firestore: memoryFirestore() });
    const { id } = await store.create('Note', { title: 't', parentId: null });
    expect(await store.getById('Note', id)).toEqual({ id, title: 't', parentId: null });
  });
});

describe('FirestorePersistence query and paging', () => {
  let db: ReturnType<typeof memoryFirestore>;
  let store: FirestorePersistence;
  beforeEach(async () => {
    db = memoryFirestore();
    store = new FirestorePersistence({ root: 'hosted/app-1', firestore: db });
    await store.create('Task', { id: 'a', title: 'alpha entry', minutes: 10, tags: ['x'] });
    await store.create('Task', { id: 'b', title: 'beta entry', minutes: 20, tags: ['y'] });
    await store.create('Task', { id: 'c', title: 'gamma', minutes: 30 });
    db.wheres.length = 0;
  });

  it('pushes every Firestore operator as a where clause and filters contains in memory', async () => {
    const rows = await store.query('Task', [
      { field: 'minutes', op: '>', value: 5 },
      { field: 'tags', op: 'array-contains', value: 'y' },
      { field: 'title', op: 'contains', value: 'ENTRY' },
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b']);
    expect(db.wheres).toEqual([[{ field: 'minutes', op: '>', value: 5 }, { field: 'tags', op: 'array-contains', value: 'y' }]]);
  });

  it('control: a contains-only query reads the collection with no where clause', async () => {
    const rows = await store.query('Task', [{ field: 'title', op: 'contains', value: 'gam' }]);
    expect(rows.map((r) => r.id)).toEqual(['c']);
    expect(db.wheres).toEqual([[]]);
  });

  it('listPage pushes the filters, then searches, sorts and pages the matches', async () => {
    const page = await store.listPage('Task', { page: 1, pageSize: 1, filters: [{ field: 'minutes', op: '>=', value: 20 }], sortBy: 'minutes', sortOrder: 'desc' });
    expect(page).toEqual({ rows: [{ id: 'c', title: 'gamma', minutes: 30 }], total: 2 });
    expect(db.wheres).toEqual([[{ field: 'minutes', op: '>=', value: 20 }]]);
  });

  it('edge: sorting keeps rows missing the sort field (last), which a native orderBy would drop', async () => {
    await store.create('Task', { id: 'd', title: 'no minutes' });
    const page = await store.listPage('Task', { page: 1, pageSize: 10, sortBy: 'minutes', sortOrder: 'asc' });
    expect(page.rows.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
