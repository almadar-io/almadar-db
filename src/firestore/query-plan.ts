/**
 * A `RowQuery` as native Firestore operations: AND-ed `where` clauses, `orderBy`, `offset`, `limit`.
 * Only what Firestore does with the shared two-valued semantics is declared, so a query outside
 * `firestoreQueryCapabilities` is refused here and the kernel reads rows instead:
 * `!=` and `not-in` skip documents lacking the field, `orderBy` on a field drops them, an `isNull`
 * test cannot see a missing field, `contains` has no native form, and an inequality (`<`, `>`, ...)
 * forces the first sort onto its own field, so no inequality query can order by document id
 * (the emulator rejects it: "order by clause cannot contain more fields after the key").
 */
import {
  queryUnsupportedReason,
  type FieldValue,
  type QueryCapabilities,
  type RowCompareOp,
  type RowPredicate,
  type RowQuery,
} from '@almadar/core';

/** Firestore's field path for the document id. */
export const DOCUMENT_ID = '__name__';

/** The most values one `in` clause accepts. */
export const IN_LIMIT = 30;

export interface FirestoreWhere {
  field: string;
  op: Extract<RowCompareOp, '=='> | 'in' | 'array-contains';
  value: FieldValue;
}

export interface FirestoreOrderBy {
  field: string;
  direction: 'asc' | 'desc';
}

export interface FirestoreQueryPlan {
  wheres: FirestoreWhere[];
  orderBy: FirestoreOrderBy[];
  offset?: number;
  limit?: number;
}

/** `orderableFields` are the fields (besides `id`) the host guarantees every document carries, non-null and indexed. */
export function firestoreQueryCapabilities(orderableFields: readonly string[]): QueryCapabilities {
  return {
    leaves: ['compare', 'member', 'hasElement'],
    combinators: ['all'],
    compareOps: ['=='],
    orderableFields: { kind: 'listed', fields: ['id', ...orderableFields] },
    window: true,
    exactTotal: true,
  };
}

function isScalar(value: FieldValue): value is string | number | boolean | Date {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value instanceof Date;
}

function fieldPath(field: string): string {
  return field === 'id' ? DOCUMENT_ID : field;
}

/** The clauses a predicate needs, or null when it can match nothing. */
function clausesOf(predicate: RowPredicate): FirestoreWhere[] | null {
  switch (predicate.kind) {
    case 'const': return predicate.value ? [] : null;
    case 'compare': {
      if (predicate.op !== '==' || !isScalar(predicate.value)) return null;
      return [{ field: fieldPath(predicate.field), op: predicate.op, value: predicate.value }];
    }
    case 'member': {
      const values = predicate.values.filter((v) => v !== null && isScalar(v));
      if (values.length === 0) return null;
      if (values.length > IN_LIMIT) throw new Error(`firestore queryPage: a membership list of ${values.length} values exceeds Firestore's in limit of ${IN_LIMIT}`);
      return [{ field: fieldPath(predicate.field), op: 'in', value: values }];
    }
    case 'hasElement':
      return predicate.value === null || isScalar(predicate.value)
        ? [{ field: fieldPath(predicate.field), op: 'array-contains', value: predicate.value }]
        : null;
    case 'all': {
      const out: FirestoreWhere[] = [];
      for (const child of predicate.of) {
        const clauses = clausesOf(child);
        if (clauses === null) return null;
        out.push(...clauses);
      }
      return out;
    }
    case 'any':
    case 'not':
    case 'contains':
    case 'isNull':
      throw new Error(`firestore queryPage: ${predicate.kind} is not expressible`);
  }
}

/** The plan for `query`, or null when it can match nothing (no read needed). Throws outside the capabilities. */
export function planQuery(query: RowQuery, orderableFields: readonly string[]): FirestoreQueryPlan | null {
  const reason = queryUnsupportedReason(firestoreQueryCapabilities(orderableFields), query);
  if (reason) throw new Error(`firestore queryPage: ${reason}`);
  const wheres: FirestoreWhere[] = [];
  for (const predicate of [query.policy, query.filter]) {
    if (predicate === undefined) continue;
    const clauses = clausesOf(predicate);
    if (clauses === null) return null;
    wheres.push(...clauses);
  }
  const order = query.order;
  const orderBy: FirestoreOrderBy[] =
    order === undefined || order.field === 'id'
      ? [{ field: DOCUMENT_ID, direction: order?.direction ?? 'asc' }]
      : [{ field: order.field, direction: order.direction }, { field: DOCUMENT_ID, direction: 'asc' }];
  return {
    wheres,
    orderBy,
    ...(query.offset !== undefined ? { offset: query.offset } : {}),
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
  };
}
