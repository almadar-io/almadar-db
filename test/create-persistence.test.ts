import { describe, it, expect, afterEach } from 'vitest';
import type { RowFirestore } from '../src/firestore/persistence.js';
import { createPersistence, type PersistenceSpec } from '../src/backend/index.js';
import { InMemoryPersistence, MockPersistenceAdapter } from '../src/mock/index.js';
import { FirestorePersistence } from '../src/firestore/persistence.js';
import { PostgresPersistence } from '../src/postgres/persistence.js';
import { CouchDBPersistence } from '../src/couchdb/persistence.js';
import { createPgPool } from '../src/postgres/pool.js';

const rowFirestore: RowFirestore = {
  collection: () => {
    throw new Error('not used');
  },
  runTransaction: () => {
    throw new Error('not used');
  },
};

describe('createPersistence', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  it('memory builds an InMemoryPersistence that stores rows', async () => {
    const store = createPersistence({ backend: 'memory' });
    expect(store).toBeInstanceOf(InMemoryPersistence);
    const { id } = await store.create('Task', { title: 'a' });
    expect(await store.getById('Task', id)).toMatchObject({ title: 'a' });
  });

  it('mock builds a fresh MockPersistenceAdapter from its config', () => {
    expect(createPersistence({ backend: 'mock' })).toBeInstanceOf(MockPersistenceAdapter);
    expect(createPersistence({ backend: 'mock', config: { seed: 7 } })).toBeInstanceOf(MockPersistenceAdapter);
  });

  it('mock hands back the host adapter when one is supplied', () => {
    const adapter = new InMemoryPersistence();
    expect(createPersistence({ backend: 'mock', adapter })).toBe(adapter);
  });

  it('mock refuses an adapter together with a config', () => {
    expect(() => createPersistence({ backend: 'mock', adapter: new InMemoryPersistence(), config: { seed: 1 } })).toThrow(/either an adapter or a config/);
  });

  it('firestore builds a FirestorePersistence on the supplied firestore, default root empty', () => {
    expect(createPersistence({ backend: 'firestore', firestore: rowFirestore })).toBeInstanceOf(FirestorePersistence);
  });

  it('firestore rejects a root that is not a document path', () => {
    expect(() => createPersistence({ backend: 'firestore', root: 'hosted', firestore: rowFirestore })).toThrow(/even number of segments/);
  });

  it('firestore accepts a document-path root', () => {
    expect(createPersistence({ backend: 'firestore', root: 'hosted/app1', firestore: rowFirestore })).toBeInstanceOf(FirestorePersistence);
  });

  it('postgres builds a PostgresPersistence that can be closed', async () => {
    const store = createPersistence({ backend: 'postgres', connectionString: 'postgres://u:p@127.0.0.1:1/db', poolMax: 3 });
    expect(store).toBeInstanceOf(PostgresPersistence);
    expect(typeof store.close).toBe('function');
    closers.push(async () => store.close?.());
  });

  it('couchdb builds a CouchDBPersistence', () => {
    expect(createPersistence({ backend: 'couchdb', url: 'http://admin:pw@127.0.0.1:5984' })).toBeInstanceOf(CouchDBPersistence);
  });

  it('every spec backend is handled', () => {
    const specs: PersistenceSpec[] = [
      { backend: 'memory' },
      { backend: 'mock' },
      { backend: 'firestore', firestore: rowFirestore },
      { backend: 'couchdb', url: 'http://127.0.0.1:5984' },
    ];
    for (const spec of specs) expect(() => createPersistence(spec)).not.toThrow();
  });
});

describe('createPgPool', () => {
  it('applies max and the statement timeouts only when given', async () => {
    const plain = createPgPool('postgres://u:p@127.0.0.1:1/db');
    const tuned = createPgPool('postgres://u:p@127.0.0.1:1/db', { max: 2, statementTimeoutMs: 500 });
    expect(plain.options.max).toBe(10);
    expect(plain.options.statement_timeout).toBeUndefined();
    expect(tuned.options.max).toBe(2);
    expect(tuned.options.statement_timeout).toBe(500);
    expect(tuned.options.query_timeout).toBe(500);
    await Promise.all([plain.end(), tuned.end()]);
  });
});
