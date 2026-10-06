import nano from 'nano';
import type { PersistenceAdapter } from '@almadar/core';
import { InMemoryPersistence, MockPersistenceAdapter, type MockPersistenceConfig } from '../mock/index.js';
import { FirestorePersistence, type RowFirestore } from '../firestore/persistence.js';
import { PostgresPersistence } from '../postgres/persistence.js';
import { createPgPool } from '../postgres/pool.js';
import { CouchDBPersistence } from '../couchdb/persistence.js';

export type PersistenceSpec =
  | { backend: 'memory' }
  | { backend: 'mock'; adapter?: PersistenceAdapter; config?: MockPersistenceConfig }
  | { backend: 'firestore'; root?: string; firestore?: RowFirestore }
  | { backend: 'postgres'; connectionString: string; poolMax?: number }
  | { backend: 'couchdb'; url: string };

export type PersistenceBackend = PersistenceSpec['backend'];

export type ClosablePersistence = PersistenceAdapter & { close?(): Promise<void> };

/**
 * The one declared selection of a storage backend. The host names the backend; nothing here
 * reads the environment. A `mock` spec carrying `adapter` hands back the host's own seeded mock
 * store (the compiled apps seed a collection-keyed service); without it a fresh
 * `MockPersistenceAdapter` is built from `config`. IndexedDB is browser-only and constructed
 * directly from `@almadar/db/browser`.
 */
export function createPersistence(spec: PersistenceSpec): ClosablePersistence {
  switch (spec.backend) {
    case 'memory':
      return new InMemoryPersistence();
    case 'mock':
      if (spec.adapter !== undefined && spec.config !== undefined) {
        throw new Error('@almadar/db: a mock spec takes either an adapter or a config, not both');
      }
      return spec.adapter ?? new MockPersistenceAdapter(spec.config ?? {});
    case 'firestore':
      return new FirestorePersistence({ root: spec.root ?? '', ...(spec.firestore ? { firestore: spec.firestore } : {}) });
    case 'postgres':
      return new PostgresPersistence({
        pool: createPgPool(spec.connectionString, spec.poolMax !== undefined ? { max: spec.poolMax } : {}),
      });
    case 'couchdb':
      return new CouchDBPersistence({ client: nano(spec.url) });
  }
}
