/**
 * The Firestore surface knowledge stores use, written structurally so the real firebase-admin
 * `Firestore` is assignable with no cast (proved by `test/document-db.test-d.ts`). Document data
 * is `JsonObject` from `@almadar/core`: readers narrow it at the boundary rather than trusting a
 * generic.
 */
import type { JsonObject, JsonValue } from '@almadar/core';

export type DocumentData = JsonObject;

export type WhereOp = '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';

export interface DocumentSnapshot {
  readonly id: string;
  readonly exists: boolean;
  data(): DocumentData | undefined;
}

export interface QuerySnapshot {
  readonly docs: readonly DocumentSnapshot[];
}

export interface Query {
  get(): Promise<QuerySnapshot>;
  where(field: string, op: WhereOp, value: JsonValue): Query;
  orderBy(field: string, direction?: 'asc' | 'desc'): Query;
  select(...fields: string[]): Query;
}

export interface CollectionRef extends Query {
  doc(id: string): DocumentRef;
  add(data: DocumentData): Promise<{ readonly id: string }>;
}

export interface DocumentRef {
  readonly id: string;
  get(): Promise<DocumentSnapshot>;
  set(data: JsonValue, opts?: { merge: boolean }): Promise<object>;
  update(data: DocumentData): Promise<object>;
  delete(): Promise<object>;
  collection(path: string): CollectionRef;
}

export interface DocumentTransaction {
  get(ref: DocumentRef): Promise<DocumentSnapshot>;
  set(ref: DocumentRef, data: JsonValue, opts?: { merge: boolean }): object;
}

export interface DocumentDb {
  collection(path: string): CollectionRef;
  runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
}
