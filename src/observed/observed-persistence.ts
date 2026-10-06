/**
 * Wraps any `PersistenceAdapter` (Firestore, Postgres, CouchDB, in-memory) with what every backend
 * owes a hosted app: each operation recorded as a `db` call on `service`, and an optional
 * per-entity row quota. A create beyond the quota is refused with `RowQuotaExceededError`; nothing
 * is ever dropped.
 */
import type { EntityRow, PersistenceAdapter, RowPageRequest, StoreFilter } from '@almadar/core';
import { createLogger, timeCall } from '@almadar/logger';

/** A create refused because the entity already holds `quota` rows in this store. */
export class RowQuotaExceededError extends Error {
  constructor(readonly entityType: string, readonly quota: number) {
    super(`${entityType} already holds ${quota} rows, the most this app may store`);
    this.name = 'RowQuotaExceededError';
  }
}

export interface ObservedPersistenceOptions {
  /** The backend named on each call record (`firestore`, `postgres`, `couchdb`). */
  service: string;
  /** Most rows one entity may hold; requires an adapter that implements `countRows`. */
  rowQuota?: number;
}

const dataLog = createLogger('almadar:server:data');

export function observedPersistence(inner: PersistenceAdapter, options: ObservedPersistenceOptions): PersistenceAdapter {
  const { service, rowQuota } = options;
  const countRows = inner.countRows?.bind(inner);
  const query = inner.query?.bind(inner);
  const listPage = inner.listPage?.bind(inner);
  if (rowQuota !== undefined && !countRows) {
    throw new Error(`A row quota needs an adapter that implements countRows; the ${service} adapter does not`);
  }
  const op = <T>(verb: string, entityType: string, fn: () => Promise<T>): Promise<T> =>
    timeCall(dataLog, { kind: 'db', service, op: `${verb}:${entityType}` }, fn);

  return {
    create: (entityType: string, data: EntityRow) => op('create', entityType, async () => {
      if (rowQuota !== undefined && countRows && (await countRows(entityType)) >= rowQuota) {
        throw new RowQuotaExceededError(entityType, rowQuota);
      }
      return inner.create(entityType, data);
    }),
    update: (entityType, id, data) => op('update', entityType, () => inner.update(entityType, id, data)),
    delete: (entityType, id) => op('delete', entityType, () => inner.delete(entityType, id)),
    getById: (entityType, id) => op('get', entityType, () => inner.getById(entityType, id)),
    list: (entityType) => op('list', entityType, () => inner.list(entityType)),
    ...(countRows ? { countRows: (entityType: string) => op('count', entityType, () => countRows(entityType)) } : {}),
    ...(query ? { query: (entityType: string, filters: readonly StoreFilter<EntityRow>[]) => op('query', entityType, () => query(entityType, filters)) } : {}),
    ...(listPage ? { listPage: (entityType: string, request: RowPageRequest<EntityRow>) => op('page', entityType, () => listPage(entityType, request)) } : {}),
  };
}
