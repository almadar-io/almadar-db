import 'fake-indexeddb/auto';
import { InMemoryPersistence } from '../src/mock/index.js';
import { IndexedDbPersistence } from '../src/browser/index.js';
import { runPersistenceContract } from './support/persistence-contract';

let n = 0;
runPersistenceContract('InMemoryPersistence', async () => new InMemoryPersistence());
runPersistenceContract('IndexedDbPersistence', async () =>
  IndexedDbPersistence.open({ databaseName: `contract-${++n}`, entityTypes: ['Invoice', 'Ledger', 'Empty'] }),
);
