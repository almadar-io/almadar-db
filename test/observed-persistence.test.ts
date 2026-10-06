/**
 * Call records and the per-app row quota belong to no single backend: `observedPersistence`
 * wraps any `PersistenceAdapter` (Firestore, Postgres, CouchDB, in-memory) and adds both, so every
 * backend reports its calls and enforces the same quota. The same contract runs over two
 * different adapters below.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryPersistence } from '../src/mock/index.js';
import { configureLogOutput } from '@almadar/logger';
import { isStructuredLogEntry, type EntityRow, type JsonValue, type PersistenceAdapter } from '@almadar/core';
import { observedPersistence, RowQuotaExceededError } from '../src/observed/observed-persistence.js';

/** In-memory adapter that can count, the capability a quota needs. */
class CountingMemory extends InMemoryPersistence {
  async countRows(entityType: string): Promise<number> {
    return (await this.list(entityType)).length;
  }
}

const backends: Array<[string, () => PersistenceAdapter & { countRows(entityType: string): Promise<number> }]> = [
  ['in-memory', () => new CountingMemory()],
  ['a second backend', () => {
    const rows = new Map<string, EntityRow>();
    let n = 0;
    return {
      async create(_t: string, data: EntityRow) { const id = String(data.id ?? `r${++n}`); rows.set(id, { ...data, id }); return { id }; },
      async update(_t: string, id: string, data: EntityRow) { rows.set(id, { ...rows.get(id), ...data }); },
      async delete(_t: string, id: string) { rows.delete(id); },
      async getById(_t: string, id: string) { return rows.get(id) ?? null; },
      async list() { return [...rows.values()]; },
      async countRows() { return rows.size; },
    };
  }],
];

describe.each(backends)('observedPersistence over %s', (_label, make) => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    configureLogOutput({ format: 'json', context: { appId: 'app-1' } });
  });
  afterEach(() => {
    configureLogOutput({ format: 'console' });
    log.mockRestore();
  });

  const ops = () => log.mock.calls
    .map((args) => { const v: JsonValue = JSON.parse(String(args[0])); return v; })
    .map((line) => (isStructuredLogEntry(line) && line.call ? `${line.call.service} ${line.call.op} ${line.call.ok}` : null));

  it('records each operation as a db call on the named service, and passes results through', async () => {
    const store = observedPersistence(make(), { service: 'test-db' });
    const { id } = await store.create('Order', { title: 't' });
    await store.update('Order', id, { status: 'open' });
    expect(await store.getById('Order', id)).toMatchObject({ id, title: 't', status: 'open' });
    expect(await store.list('Order')).toHaveLength(1);
    await store.delete('Order', id);
    expect(ops()).toEqual([
      'test-db create:Order true', 'test-db update:Order true', 'test-db get:Order true',
      'test-db list:Order true', 'test-db delete:Order true',
    ]);
  });

  it('refuses a create beyond the row quota with a typed error, recorded as a failed call, keeping every row', async () => {
    const store = observedPersistence(make(), { service: 'test-db', rowQuota: 1 });
    await store.create('Order', { id: 'a' });
    await expect(store.create('Order', { id: 'b' })).rejects.toBeInstanceOf(RowQuotaExceededError);
    expect((await store.list('Order')).map((r) => r.id)).toEqual(['a']);
    expect(ops()).toContain('test-db create:Order false');
  });

  it('control: without a quota, creates are never counted or refused', async () => {
    const inner = make();
    const count = vi.spyOn(inner, 'countRows');
    const store = observedPersistence(inner, { service: 'test-db' });
    await store.create('Order', { id: 'a' });
    await store.create('Order', { id: 'b' });
    expect(count).not.toHaveBeenCalled();
  });
});

it('edge: a quota on an adapter that cannot count is refused at construction, never silently skipped', () => {
  expect(() => observedPersistence(new InMemoryPersistence(), { service: 'mem', rowQuota: 5 })).toThrow(/countRows/);
});

it('passes an adapter\'s native query and listPage through, recorded as calls', async () => {
  const inner = new CountingMemory();
  let queried = 0;
  let paged = 0;
  const withPushdown: PersistenceAdapter = Object.assign(inner, {
    query: async (t: string) => { queried++; return inner.list(t); },
    listPage: async (t: string) => { paged++; return { rows: await inner.list(t), total: 0 }; },
  });
  const store = observedPersistence(withPushdown, { service: 'test-db' });
  await store.query?.('Order', []);
  await store.listPage?.('Order', { page: 1, pageSize: 5 });
  expect([queried, paged]).toEqual([1, 1]);
});

it('control: an adapter without them gets none, so callers fall back', () => {
  const store = observedPersistence(new InMemoryPersistence(), { service: 'mem' });
  expect(store.query).toBeUndefined();
  expect(store.listPage).toBeUndefined();
});
