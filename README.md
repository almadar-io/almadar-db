# @almadar/db

Database clients, bootstrap and every storage adapter behind the `PersistenceAdapter` contract from `@almadar/core`.

- `@almadar/db`: Firestore, Postgres, CouchDB, file-credential, in-memory and mock adapters, plus `observedPersistence`.
- `@almadar/db/mock`: the isomorphic subset (`InMemoryPersistence`, `MockPersistenceAdapter`), free of node-only dependencies.
- `@almadar/db/firebase`: Firebase Admin bootstrap (`initializeFirebase`, `getFirestore`, `getAuth`, `getStorage`, `isFirebaseConfigured`) and the `DocumentDb` interface. Honours `FIRESTORE_EMULATOR_HOST` and `FIREBASE_AUTH_EMULATOR_HOST`.
- `@almadar/db/browser`: `IndexedDbPersistence`, no node dependencies.
