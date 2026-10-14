/**
 * CouchDB implementation of PersistenceAdapter: one database per entity type, schemaless docs.
 * `query` pushes the Mango-expressible filters to `_find` and applies the rest in memory.
 */
import type { MangoQuery, MangoSelector } from 'nano';
import type { EntityRow, PersistenceAdapter, QueryCapabilities, RowQuery, RowQueryPage, StoreFilter } from '@almadar/core';
import { filterRows, totalFromWindow } from '../data/row-query.js';
import {
  COUCHDB_QUERY_CAPABILITIES,
  databaseNameFor,
  docToRow,
  mangoOperatorFor,
  mangoQueryFor,
  mintId,
  serializeRow,
  type CouchDBClient,
  type CouchDBDatabase,
  type CouchDoc,
} from './rows.js';

function statusOf(error: Error): number | undefined {
  return 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

function isNotFound(error: Error): boolean {
  return statusOf(error) === 404;
}

function isConflict(error: Error): boolean {
  return statusOf(error) === 409;
}

export interface CouchDBPersistenceOptions {
  client: CouchDBClient;
  /** Documents per `_find` request when `queryPage` reads without a limit or counts matches; default 1000. */
  pageSize?: number;
}

export class CouchDBPersistence implements PersistenceAdapter {
  private readonly client: CouchDBClient;
  private readonly ensured = new Set<string>();
  private readonly pageSize: number;

  constructor(options: CouchDBPersistenceOptions) {
    this.client = options.client;
    this.pageSize = options.pageSize ?? 1000;
  }

  private dbFor(entityType: string): CouchDBDatabase<CouchDoc> {
    return this.client.use(databaseNameFor(entityType));
  }

  private async ensureDatabase(entityType: string): Promise<void> {
    const name = databaseNameFor(entityType);
    if (this.ensured.has(name)) return;
    try {
      await this.client.db.create(name);
    } catch (error) {
      if (!(error instanceof Error && isConflict(error))) throw error; // database already exists
    }
    this.ensured.add(name);
  }

  async create(entityType: string, data: EntityRow): Promise<{ id: string }> {
    await this.ensureDatabase(entityType);
    const supplied = data.id;
    const id = typeof supplied === 'string' && supplied.length > 0 ? supplied : mintId();
    const doc = { ...serializeRow({ ...data, id }), _id: id };
    try {
      await this.dbFor(entityType).insert(doc);
    } catch (error) {
      if (error instanceof Error && isConflict(error)) {
        throw new Error(`Entity ${entityType} with id ${id} already exists`);
      }
      throw error;
    }
    return { id };
  }

  async update(entityType: string, id: string, data: EntityRow): Promise<void> {
    const db = this.dbFor(entityType);
    // Refetch-before-write (no _rev shadow): the current rev travels with the doc only.
    const current = await this.getDoc(db, id);
    if (!current) return; // mirror postgres: update on a miss is a silent no-op
    const record: EntityRow = { ...data };
    delete record.id;
    const next: CouchDoc = {
      ...current,
      ...serializeRow(record),
      _id: current._id,
      _rev: current._rev,
    };
    await db.insert(next);
  }

  async delete(entityType: string, id: string): Promise<void> {
    const db = this.dbFor(entityType);
    const current = await this.getDoc(db, id);
    if (!current) return;
    await db.destroy(current._id, current._rev);
  }

  private async getDoc(db: CouchDBDatabase<CouchDoc>, id: string): Promise<CouchDoc | null> {
    try {
      return await db.get(id);
    } catch (error) {
      if (error instanceof Error && isNotFound(error)) return null;
      throw error;
    }
  }

  async getById(entityType: string, id: string): Promise<EntityRow | null> {
    try {
      const doc = await this.dbFor(entityType).get(id);
      return docToRow(doc);
    } catch (error) {
      if (error instanceof Error && isNotFound(error)) return null;
      throw error;
    }
  }

  async list(entityType: string): Promise<EntityRow[]> {
    const result = await this.dbFor(entityType).list({ include_docs: true });
    return result.rows
      .map((row) => row.doc)
      .filter((doc): doc is CouchDoc => doc !== undefined)
      .map((doc) => docToRow(doc));
  }

  async query(entityType: string, filters: readonly StoreFilter<EntityRow>[]): Promise<EntityRow[]> {
    const selector: MangoSelector = {};
    const remainder: StoreFilter<EntityRow>[] = [];
    for (const filter of filters) {
      const mangoOp = mangoOperatorFor(filter.op);
      if (mangoOp && !(filter.field in selector)) selector[filter.field] = { [mangoOp]: filter.value };
      else remainder.push(filter);
    }
    const rows = Object.keys(selector).length > 0
      ? (await this.dbFor(entityType).find({ selector })).docs.map((doc) => docToRow(doc))
      : await this.list(entityType);
    return filterRows(rows, remainder);
  }

  queryCapabilities(_entityType: string): QueryCapabilities {
    return COUCHDB_QUERY_CAPABILITIES;
  }

  async queryPage(entityType: string, query: RowQuery): Promise<RowQueryPage> {
    const { selector, sort } = mangoQueryFor(query);
    const db = this.dbFor(entityType);
    const offset = query.offset ?? 0;
    const docs = query.limit === undefined
      ? await this.findAll(db, { selector, sort, ...(offset > 0 ? { skip: offset } : {}) })
      : query.limit === 0
        ? []
        : (await db.find({ selector, sort, skip: offset, limit: query.limit })).docs;
    const rows = docs.map((d) => docToRow(d));
    const known = totalFromWindow(docs.length, offset, query.limit);
    if (known !== null) return { rows, total: known };
    return { rows, total: (await this.findAll(db, { selector, fields: ['_id'] })).length };
  }

  /** Every document the query matches, read `pageSize` at a time through the bookmark (a query's `skip` applies to the first request only). */
  private async findAll(db: CouchDBDatabase<CouchDoc>, query: MangoQuery): Promise<CouchDoc[]> {
    const out: CouchDoc[] = [];
    let bookmark: string | undefined;
    for (;;) {
      const page = await db.find({ ...query, limit: this.pageSize, ...(bookmark === undefined ? {} : { bookmark, skip: undefined }) });
      out.push(...page.docs);
      if (page.docs.length < this.pageSize) return out;
      if (page.bookmark === undefined) throw new Error('CouchDB _find returned a full page without a bookmark, so the next page cannot be requested');
      bookmark = page.bookmark;
    }
  }
}
