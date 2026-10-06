import { expectTypeOf, test } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import type { DocumentDb } from '../src/firebase/index.js';

test('the real firebase-admin Firestore is a DocumentDb with no cast', () => {
  expectTypeOf<Firestore>().toMatchTypeOf<DocumentDb>();
  const assign = (firestore: Firestore): DocumentDb => firestore;
  expectTypeOf(assign).returns.toEqualTypeOf<DocumentDb>();
});
