/**
 * CouchDB internals: database naming, id minting, doc (de)serialization (ISO-string timestamps)
 * and the Mango operator mapping.
 */
import type { MangoSelector } from 'nano';
import type { EntityRow, FieldValue } from '@almadar/core';
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
  find(query: { selector: MangoSelector }): Promise<{ docs: D[] }>;
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
