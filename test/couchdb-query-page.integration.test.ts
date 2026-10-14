/**
 * queryPage against a real CouchDB over the shared push-down cases: skipped unless TEST_COUCHDB_URL
 * is set (e.g. TEST_COUCHDB_URL=http://admin:pw@localhost:55984).
 */
import { describe, it, expect, afterAll } from 'vitest';
import nano from 'nano';
import { CouchDBPersistence } from '../src/couchdb/persistence.js';
import { databaseNameFor } from '../src/couchdb/rows.js';
import { FIXTURE_ENTITY, FIXTURE_ROWS, runQueryPageCases } from './support/query-cases';

const url = process.env.TEST_COUCHDB_URL;

describe.skipIf(!url)('CouchDBPersistence.queryPage (TEST_COUCHDB_URL)', () => {
  const server = nano(url ?? 'http://localhost:5984');
  let ready: Promise<CouchDBPersistence> | undefined;

  const make = (): Promise<CouchDBPersistence> => {
    ready ??= (async () => {
      try {
        await server.db.destroy(databaseNameFor(FIXTURE_ENTITY));
      } catch {
        // nothing to drop
      }
      const store = new CouchDBPersistence({ client: server, pageSize: 5 });
      for (const row of FIXTURE_ROWS) await store.create(FIXTURE_ENTITY, { ...row });
      return store;
    })();
    return ready;
  };

  afterAll(async () => {
    await server.db.destroy(databaseNameFor(FIXTURE_ENTITY));
  });

  runQueryPageCases('CouchDBPersistence (live)', make);
});
