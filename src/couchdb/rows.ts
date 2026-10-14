/**
 * CouchDB internals: database naming, id minting, doc (de)serialization (ISO-string timestamps)
 * and the Mango operator mapping.
 */
import type { MangoQuery, MangoSelector } from 'nano';
import { queryUnsupportedReason, type EntityRow, type FieldValue, type QueryCapabilities, type RowPredicate, type RowQuery } from '@almadar/core';
import { isoTimestamps } from '../data/timestamps.js';

// Database naming stays single-owned by the postgres rows module
// (same deterministic entityType → name mapping, reused verbatim).
import { tableNameFor as databaseNameFor, mintId } from '../postgres/rows.js';

export { databaseNameFor, mintId };

export interface CouchDoc {
  _id: string;
  _rev: string;
  [key: string]: FieldValue | undefined;
}

/**
 * Narrow structural view of the nano client surface the adapters use.
 * nano's `ServerScope` satisfies this structurally; tests can supply a double
 * implementing it directly (no casts).
 */
export interface CouchDBDatabase<D extends CouchDoc> {
  insert(doc: EntityRow & { _id: string; _rev?: string }): Promise<object>;
  get(docname: string): Promise<D>;
  destroy(docname: string, rev: string): Promise<object>;
  list(params: { include_docs: boolean }): Promise<{ rows: { doc?: D }[] }>;
  find(query: MangoQuery): Promise<{ docs: D[]; bookmark?: string }>;
}

export interface CouchDBClient {
  db: { create(name: string): Promise<object> };
  use(name: string): CouchDBDatabase<CouchDoc>;
}

/** EntityRow → CouchDB doc body: undefined dropped, Date → ISO at the top level. */
export function serializeRow(row: EntityRow): EntityRow {
  const doc: EntityRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue;
    doc[key] = value instanceof Date ? value.toISOString() : value;
  }
  return doc;
}

/** CouchDB doc → row: strip _id/_rev; timestamps stay ISO strings. */
export function docToRow(doc: CouchDoc): EntityRow {
  const { _id: _docId, _rev: _docRev, ...rest } = doc;
  return isoTimestamps(rest);
}

/**
 * Ops pushed into Mango `_find`; the rest (`contains`, `array-contains`, `array-contains-any`)
 * are filtered in memory by `row-query`.
 */
export function mangoOperatorFor(op: string): '$eq' | '$ne' | '$lt' | '$lte' | '$gt' | '$gte' | '$in' | '$nin' | null {
  switch (op) {
    case '==':
      return '$eq';
    case '!=':
      return '$ne';
    case '<':
      return '$lt';
    case '<=':
      return '$lte';
    case '>':
      return '$gt';
    case '>=':
      return '$gte';
    case 'in':
      return '$in';
    case 'not-in':
      return '$nin';
    default:
      return null;
  }
}

/**
 * What Mango expresses with the shared two-valued semantics. Ordering comparisons are left out
 * (Mango compares across types and strings by ICU collation, not binary order), as is `contains`
 * (its case-insensitive form is ASCII-only), and only `id` can be ordered (a sort needs an index
 * and skips documents lacking the field; `_id` is the one field every document has).
 */
export const COUCHDB_QUERY_CAPABILITIES: QueryCapabilities = {
  leaves: ['compare', 'member', 'hasElement', 'isNull'],
  combinators: ['all', 'any', 'not'],
  compareOps: ['==', '!='],
  orderableFields: { kind: 'listed', fields: ['id'] },
  window: true,
  exactTotal: true,
};

const MATCH_NONE: MangoSelector = { _id: { $exists: false } };
const MATCH_ALL: MangoSelector = { _id: { $exists: true } };

function mangoScalar(value: FieldValue): string | number | boolean | null | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return undefined;
}

function mangoPredicate(predicate: RowPredicate): MangoSelector {
  switch (predicate.kind) {
    case 'const': return predicate.value ? MATCH_ALL : MATCH_NONE;
    case 'compare': {
      const { field, op, value } = predicate;
      if (value === null) return op === '!=' ? { $and: [{ [field]: { $exists: true } }, { [field]: { $ne: null } }] } : MATCH_NONE;
      const scalar = mangoScalar(value);
      if (scalar === undefined) return op === '!=' ? MATCH_ALL : MATCH_NONE;
      if (op === '==') return { [field]: { $eq: scalar } };
      return { $or: [{ [field]: { $exists: false } }, { [field]: { $ne: scalar } }] };
    }
    case 'member': {
      const values = predicate.values.map(mangoScalar).filter((v) => v !== undefined && v !== null);
      return values.length === 0 ? MATCH_NONE : { [predicate.field]: { $in: values } };
    }
    case 'hasElement': {
      const scalar = mangoScalar(predicate.value);
      return scalar === undefined ? MATCH_NONE : { [predicate.field]: { $elemMatch: { $eq: scalar } } };
    }
    case 'isNull':
      return predicate.isNull
        ? { $or: [{ [predicate.field]: { $exists: false } }, { [predicate.field]: { $eq: null } }] }
        : { $and: [{ [predicate.field]: { $exists: true } }, { [predicate.field]: { $ne: null } }] };
    case 'all': return predicate.of.length === 0 ? MATCH_ALL : { $and: predicate.of.map(mangoPredicate) };
    case 'any': return predicate.of.length === 0 ? MATCH_NONE : { $or: predicate.of.map(mangoPredicate) };
    case 'not': return { $not: mangoPredicate(predicate.of) };
    case 'contains': throw new Error('couchdb queryPage: leaf-unsupported (contains)');
  }
}

/** A `RowQuery` as a Mango selector and `_id` sort; throws for a query outside `COUCHDB_QUERY_CAPABILITIES`. */
export function mangoQueryFor(query: RowQuery): { selector: MangoSelector; sort: { _id: 'asc' | 'desc' }[] } {
  const reason = queryUnsupportedReason(COUCHDB_QUERY_CAPABILITIES, query);
  if (reason) throw new Error(`couchdb queryPage: ${reason}`);
  const parts = [{ _id: { $gt: null } }, ...[query.policy, query.filter].filter((p): p is RowPredicate => p !== undefined).map(mangoPredicate)];
  return { selector: { $and: parts }, sort: [{ _id: query.order?.direction ?? 'asc' }] };
}
