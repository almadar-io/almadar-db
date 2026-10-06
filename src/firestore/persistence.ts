/**
 * Firestore implementation of the runtime's `PersistenceAdapter`, the one Firestore row store:
 * a playground behavior's store, the tenant credential store and a hosted app's data are all
 * instances of it, differing only in `root`.
 *
 * Layout: with a `root` document path, entity rows live at `<root>/entities/<Entity>/rows/<id>`;
 * with an empty root, at the top-level collection `<Entity>/<id>` (the credential store's layout).
 * Call records and row quotas are `observedPersistence`'s, over any backend.
 */
import type { DocumentData } from 'firebase-admin/firestore';
import type { EntityRow, FieldValue, PersistenceAdapter, RowPage, RowPageRequest, StoreFilter, StoreFilterOp } from '@almadar/core';
import { getFirestore } from '../firebase/index.js';
import { filterRows, pageRows } from '../data/row-query.js';

export interface RowDoc {
  readonly id: string;
  set(data: DocumentData, options?: { merge: boolean }): Promise<void>;
  get(): Promise<{ exists: boolean; data(): DocumentData | undefined }>;
  delete(): Promise<void>;
}

/** Every store operator except `contains` (substring), which Firestore cannot express. */
export type RowWhereOp = Exclude<StoreFilterOp, 'contains'>;

function isWhereOp(op: StoreFilterOp): op is RowWhereOp {
  return op !== 'contains';
}

export interface RowQuery {
  where(field: string, op: RowWhereOp, value: FieldValue | undefined): RowQuery;
  get(): Promise<{ docs: ReadonlyArray<{ readonly id: string; data(): DocumentData }> }>;
}

export interface RowCollection extends RowQuery {
  doc(id?: string): RowDoc;
  count(): Promise<number>;
}

/**
 * The slice of an Admin SDK `Firestore` that `firestoreRows` adapts. A host whose firebase-admin
 * copy is not this package's (the builder) passes its own instance, which satisfies it.
 */
export interface AdminQuery {
  where(field: string, op: RowWhereOp, value: FieldValue | undefined): AdminQuery;
  get(): Promise<{ docs: ReadonlyArray<{ readonly id: string; data(): DocumentData }> }>;
}

export interface AdminDoc {
  readonly id: string;
  set(data: DocumentData, options?: { merge: boolean }): Promise<object>;
  get(): Promise<{ exists: boolean; data(): DocumentData | undefined }>;
  delete(): Promise<object>;
}

export interface AdminFirestore {
  collection(path: string): AdminQuery & {
    doc(id?: string): AdminDoc;
    count(): { get(): Promise<{ data(): { count: number } }> };
  };
}

function rowQuery(query: AdminQuery): RowQuery {
  return {
    where: (field, op, value) => rowQuery(query.where(field, op, value)),
    async get() { const snap = await query.get(); return { docs: snap.docs }; },
  };
}

/** The slice of Firestore the store uses; `firestoreRows()` adapts the Admin SDK to it. */
export interface RowFirestore {
  collection(path: string): RowCollection;
}

/** An Admin SDK Firestore (this package's own when none is given) as a `RowFirestore`. */
export function firestoreRows(db: AdminFirestore = getFirestore()): RowFirestore {
  return {
    collection(path: string): RowCollection {
      const ref = db.collection(path);
      return {
        ...rowQuery(ref),
        doc(id?: string): RowDoc {
          const doc = id === undefined ? ref.doc() : ref.doc(id);
          return {
            id: doc.id,
            async set(data, options) { await (options ? doc.set(data, options) : doc.set(data)); },
            async get() { const snap = await doc.get(); return { exists: snap.exists, data: () => snap.data() }; },
            async delete() { await doc.delete(); },
          };
        },
        async count() { const agg = await ref.count().get(); return agg.data().count; },
      };
    },
  };
}

/** Firestore rejects `undefined` anywhere in a document; an unset field is simply absent. */
function encodeValue(value: FieldValue): FieldValue {
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: { [key: string]: FieldValue } = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) out[key] = encodeValue(field);
  }
  return out;
}

function encodeRow(row: EntityRow): DocumentData {
  const out: DocumentData = {};
  for (const [key, field] of Object.entries(row)) {
    if (field !== undefined) out[key] = encodeValue(field);
  }
  return out;
}

export interface FirestorePersistenceOptions {
  /** Document path the rows hang under (`hosted/<appId>`), or '' for top-level entity collections. */
  root: string;
  firestore?: RowFirestore;
}

export class FirestorePersistence implements PersistenceAdapter {
  private readonly root: string;
  private readonly db: RowFirestore;

  constructor(options: FirestorePersistenceOptions) {
    if (options.root !== '' && options.root.split('/').filter(Boolean).length % 2 !== 0) {
      throw new Error(`FirestorePersistence root "${options.root}" is not a document path (it needs an even number of segments)`);
    }
    this.root = options.root;
    this.db = options.firestore ?? firestoreRows();
  }

  /** Path of the document an entity's rows hang under (holds per-entity markers); '' root has none. */
  protected entityDocPath(entityType: string): string | null {
    return this.root === '' ? null : `${this.root}/entities/${entityType}`;
  }

  /** Path of the collection holding an entity's rows. */
  protected rowsPath(entityType: string): string {
    const parent = this.entityDocPath(entityType);
    return parent === null ? entityType : `${parent}/rows`;
  }

  protected rows(entityType: string): RowCollection {
    return this.db.collection(this.rowsPath(entityType));
  }

  async create(entityType: string, data: EntityRow): Promise<{ id: string }> {
    const rows = this.rows(entityType);
    const { id: supplied, ...fields } = data;
    const doc = typeof supplied === 'string' && supplied.length > 0 ? rows.doc(supplied) : rows.doc();
    await doc.set({ ...encodeRow(fields), id: doc.id });
    return { id: doc.id };
  }

  update(entityType: string, id: string, data: EntityRow): Promise<void> {
    return this.rows(entityType).doc(id).set(encodeRow(data), { merge: true });
  }

  delete(entityType: string, id: string): Promise<void> {
    return this.rows(entityType).doc(id).delete();
  }

  countRows(entityType: string): Promise<number> {
    return this.rows(entityType).count();
  }

  async getById(entityType: string, id: string): Promise<EntityRow | null> {
    const snap = await this.rows(entityType).doc(id).get();
    const data = snap.exists ? snap.data() : undefined;
    if (data === undefined) return null;
    const row: EntityRow = { ...data, id };
    return row;
  }

  async list(entityType: string): Promise<EntityRow[]> {
    return this.read(this.rows(entityType));
  }

  async query(entityType: string, filters: readonly StoreFilter<EntityRow>[]): Promise<EntityRow[]> {
    let query: RowQuery = this.rows(entityType);
    const remainder: StoreFilter<EntityRow>[] = [];
    for (const filter of filters) {
      if (isWhereOp(filter.op)) query = query.where(filter.field, filter.op, filter.value);
      else remainder.push(filter);
    }
    return filterRows(await this.read(query), remainder);
  }

  /** Filters run in Firestore; search, sort and paging in memory, so rows missing the sort field are kept. */
  async listPage(entityType: string, request: RowPageRequest<EntityRow>): Promise<RowPage<EntityRow>> {
    const matched = await this.query(entityType, request.filters ?? []);
    return pageRows(matched, { ...request, filters: [] });
  }

  private async read(query: RowQuery): Promise<EntityRow[]> {
    const snap = await query.get();
    return snap.docs.map((d) => {
      const row: EntityRow = { ...d.data(), id: d.id };
      return row;
    });
  }
}
