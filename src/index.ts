export type { PersistenceAdapter } from '@almadar/core';

export * from './mock/index.js';

export {
  FirestorePersistence,
  firestoreRows,
  type AdminFirestore,
  type FirestorePersistenceOptions,
  type RowFirestore,
  type RowCollection,
  type RowDoc,
  type RowQuery,
  type RowWhereOp,
} from './firestore/persistence.js';
export { FirestoreCredentialPersistence } from './credentials/firestore-credential-persistence.js';
export { FileCredentialPersistence, CREDENTIALS_FILE_ENV } from './credentials/file-credential-persistence.js';

export { PostgresPersistence, type PostgresPersistenceOptions } from './postgres/persistence.js';
export {
  tableNameFor,
  snakeNameFor,
  quoteIdent,
  buildWhere,
  buildPageQueries,
  type SqlFilter,
} from './postgres/rows.js';
export { ensureSchema, generateSchemaDdl, columnTypeFor, type SqlExecutor } from './postgres/schema/ddl.js';
export {
  diffSchema,
  applySchemaEvolution,
  diffHasDestructive,
  type SchemaDiff,
  type ColumnDiff,
  type CheckDiff,
  type EvolutionPolicy,
  type EvolutionGate,
  type EvolutionReport,
  type RefusedChange,
} from './postgres/schema/evolution.js';

export { CouchDBPersistence, type CouchDBPersistenceOptions } from './couchdb/persistence.js';
export { databaseNameFor, type CouchDBClient, type CouchDoc } from './couchdb/rows.js';

export { observedPersistence, RowQuotaExceededError, type ObservedPersistenceOptions } from './observed/observed-persistence.js';
export { filterRows, pageRows, rowMatches, sortRows } from './data/row-query.js';
export { isoTimestamps } from './data/timestamps.js';
export { createPgPool, type PgPoolOptions } from './postgres/pool.js';
