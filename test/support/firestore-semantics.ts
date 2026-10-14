/**
 * An in-process Firestore row store that follows Firestore's own query rules rather than the shared
 * two-valued semantics: a `where` never matches a document lacking the field and inequalities stay
 * within one type, `orderBy` drops documents lacking the field and sorts null first, types sort
 * null < boolean < number < string. The same tests also run against the Firestore emulator
 * (`FIRESTORE_EMULATOR_HOST`), which is what keeps this model honest.
 */
import type { DocumentData } from 'firebase-admin/firestore';
import type { FieldValue } from '@almadar/core';
import type { RowCollection, RowDoc, RowFirestore } from '../../src/firestore/persistence.js';
import type { FirestoreQueryPlan, FirestoreWhere } from '../../src/firestore/query-plan.js';

type Stored = DocumentData;

function rank(value: FieldValue | undefined): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return 1;
  if (typeof value === 'number') return 2;
  if (value instanceof Date) return 3;
  if (typeof value === 'string') return 4;
  return 5;
}

function codePoints(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i].codePointAt(0) ?? 0) - (y[i].codePointAt(0) ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return Math.sign(x.length - y.length);
}

function compareValues(a: FieldValue, b: FieldValue): number {
  if (rank(a) !== rank(b)) return rank(a) < rank(b) ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') return codePoints(a, b);
  if (typeof a === 'number' && typeof b === 'number') return Math.sign(a - b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (a instanceof Date && b instanceof Date) return Math.sign(a.getTime() - b.getTime());
  return 0;
}

function valueOf(id: string, data: Stored, field: string): FieldValue | undefined {
  return field === '__name__' ? id : data[field];
}

function matches(id: string, data: Stored, w: FirestoreWhere): boolean {
  const have = valueOf(id, data, w.field);
  if (have === undefined) return false;
  switch (w.op) {
    case '==': return compareValues(have, w.value) === 0 && rank(have) === rank(w.value);
    case 'in': return Array.isArray(w.value) && w.value.some((v) => rank(have) === rank(v) && compareValues(have, v) === 0);
    case 'array-contains': return Array.isArray(have) && have.some((v) => v === w.value);
    default: {
      if (rank(have) !== rank(w.value)) return false;
      const c = compareValues(have, w.value);
      return w.op === '<' ? c < 0 : w.op === '<=' ? c <= 0 : w.op === '>' ? c > 0 : c >= 0;
    }
  }
}

export function semanticFirestore(): RowFirestore {
  const tables = new Map<string, Map<string, Stored>>();
  const table = (path: string): Map<string, Stored> => {
    let t = tables.get(path);
    if (!t) tables.set(path, (t = new Map()));
    return t;
  };
  let auto = 0;
  const collection = (path: string): RowCollection => {
    const all = () => [...table(path).entries()].map(([id, data]) => ({ id, data: () => data }));
    const query = (wheres: FirestoreWhere[]): Pick<RowCollection, 'where' | 'get'> => ({
      where(field, op, value) {
        if (op === '!=' || op === 'not-in' || op === 'array-contains-any') throw new Error(`semantic stand-in: ${op} not modelled`);
        return query([...wheres, { field, op, value: value ?? null }]) as ReturnType<RowCollection['where']>;
      },
      async get() {
        return { docs: all().filter((d) => wheres.every((w) => matches(d.id, d.data(), w))) };
      },
    });
    return {
      ...query([]),
      doc(id?: string): RowDoc {
        const docId = id ?? `auto-${++auto}`;
        return {
          id: docId,
          async set(data, options) {
            const prior = options?.merge ? table(path).get(docId) ?? {} : {};
            table(path).set(docId, { ...prior, ...data });
          },
          async get() {
            const data = table(path).get(docId);
            return { exists: data !== undefined, data: () => data };
          },
          async delete() { table(path).delete(docId); },
        };
      },
      async count() { return table(path).size; },
      async runPlan(plan: FirestoreQueryPlan) {
        let docs = all().filter((d) => plan.wheres.every((w) => matches(d.id, d.data(), w)));
        docs = docs.filter((d) => plan.orderBy.every((o) => valueOf(d.id, d.data(), o.field) !== undefined));
        const total = docs.length;
        docs.sort((a, b) => {
          for (const o of plan.orderBy) {
            const x = valueOf(a.id, a.data(), o.field);
            const y = valueOf(b.id, b.data(), o.field);
            if (x === undefined || y === undefined) continue;
            const c = compareValues(x, y);
            if (c !== 0) return o.direction === 'asc' ? c : -c;
          }
          return 0;
        });
        const start = plan.offset ?? 0;
        return { docs: docs.slice(start, plan.limit === undefined ? undefined : start + plan.limit), total };
      },
    };
  };
  return { collection };
}
