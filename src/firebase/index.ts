/**
 * Database Accessors & Initialization (firebase-admin v14)
 *
 * v14 uses modular subpath exports: `firebase-admin/app`, `firebase-admin/firestore`,
 * `firebase-admin/auth`. Named databases are supported via `initializeFirestore(app,
 * settings, databaseId)` — v12's `app.firestore(databaseId)` silently fell back to
 * (default), which is why this file exists.
 */

import { createLogger } from '@almadar/logger';
import {
  initializeApp,
  getApps,
  getApp,
  cert,
  applicationDefault,
  type App,
} from 'firebase-admin/app';
import {
  getFirestore as adminGetFirestore,
  initializeFirestore,
  type Firestore,
  type FirestoreSettings,
} from 'firebase-admin/firestore';
import { getAuth as adminGetAuth, type Auth } from 'firebase-admin/auth';
import { getStorage as adminGetStorage, type Storage } from 'firebase-admin/storage';
import type { DocumentDb } from './document-db.js';

export type {
  CollectionRef,
  DocumentData,
  DocumentDb,
  DocumentRef,
  DocumentSnapshot,
  DocumentTransaction,
  Query,
  QuerySnapshot,
  WhereOp,
} from './document-db.js';

const dbLog = createLogger('almadar:db:firebase');

/**
 * Initialize Firebase Admin SDK from environment variables.
 *
 * Reads: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
 *        FIREBASE_SERVICE_ACCOUNT_PATH, FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST
 *
 * Safe to call multiple times — returns existing app if already initialized.
 */
export function initializeFirebase(): App {
  if (getApps().length > 0) {
    return getApp();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST;
  // Optional everywhere below: `getStorage().bucket()` (no explicit name)
  // needs this wired at app-init time or it throws "Bucket name not
  // specified" — Admin SDK does NOT infer it from `projectId` alone,
  // verified against the Storage emulator 2026-09-15. Callers that never
  // touch Storage are unaffected by it being unset.
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  if (emulatorHost) {
    const app = initializeApp({ projectId: projectId || 'demo-almadar', storageBucket });
    dbLog.info('Firebase Admin initialized for emulator', { emulatorHost });
    return app;
  }

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (serviceAccountPath) {
    return initializeApp({
      credential: cert(serviceAccountPath),
      projectId,
      storageBucket,
    });
  }

  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return initializeApp({
      credential: cert({ projectId, clientEmail, privateKey: privateKey.replace(/\\n/g, '\n') }),
      projectId,
      storageBucket,
    });
  }

  if (projectId) {
    return initializeApp({
      credential: applicationDefault(),
      projectId,
      storageBucket,
    });
  }

  throw new Error(
    '@almadar/db/firebase: Cannot initialize Firebase — no credentials found. ' +
    'Set FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, ' +
    'or FIREBASE_SERVICE_ACCOUNT_PATH, or FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST.'
  );
}

/**
 * True iff SOME credential condition `initializeFirebase` accepts is present:
 * an emulator host (Firestore or Auth), a service-account file, or a bare projectId (the
 * applicationDefault path). Pure env inspection — no side effects, never
 * initializes anything; the local-dev routing in
 * `@almadar-io/playground-runtime` uses it to decide Firestore vs. an
 * in-memory shared store without paying `initializeFirebase`'s throw.
 */
export type FirestoreTarget = 'emulator' | 'project';

/**
 * Where Firestore calls would go under `env`: the emulator (`FIRESTORE_EMULATOR_HOST`), a project
 * (`FIREBASE_SERVICE_ACCOUNT_PATH`, or `FIREBASE_PROJECT_ID` with application-default credentials),
 * or nowhere. A `demo-` project exists only in an emulator, so without the Firestore emulator it is nowhere.
 */
export function firestoreTargetOf(env: Readonly<Record<string, string | undefined>>): FirestoreTarget | null {
  if (env['FIRESTORE_EMULATOR_HOST']) return 'emulator';
  if (env['FIREBASE_SERVICE_ACCOUNT_PATH']) return 'project';
  const projectId = env['FIREBASE_PROJECT_ID'];
  if (projectId && !projectId.startsWith('demo-')) return 'project';
  return null;
}

export function isFirebaseConfigured(): boolean {
  return Boolean(
    process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.FIREBASE_AUTH_EMULATOR_HOST ||
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      process.env.FIREBASE_PROJECT_ID,
  );
}

function getAppInstance(): App {
  if (getApps().length === 0) {
    if (process.env.NODE_ENV !== 'production') {
      dbLog.warn('Firebase not yet initialized in this module instance (possible pnpm module duplication); auto-initializing from env');
      return initializeFirebase();
    }
    throw new Error(
      '@almadar/db/firebase: Firebase Admin SDK is not initialized. ' +
      'Call initializeFirebase() before using the Firestore, Auth or Storage accessors.'
    );
  }
  return getApp();
}

/**
 * Settings passed to initializeFirestore at creation time. firebase-admin v14's
 * FirestoreSettings type only exposes preferRest, but the underlying
 * @google-cloud/firestore accepts more — we extend the interface to add them.
 */
interface FirestoreInitSettings extends FirestoreSettings {
  ignoreUndefinedProperties?: boolean;
}

/**
 * Get Firestore instance for the named database from env.
 *
 * Uses `initializeFirestore(app, settings, databaseId)` which creates a separate
 * Firestore instance per databaseId (firebase-admin v14). Falls back to (default)
 * when no env var is set.
 *
 * Reads FIRESTORE_DATABASE_ID (canonical) or FB_DB_ID (legacy app alias).
 */
export function getFirestore(): Firestore {
  const app = getAppInstance();
  const databaseId = process.env.FIREBASE_DATABASE_ID ?? process.env.FB_DB_ID;
  const settings: FirestoreInitSettings = { ignoreUndefinedProperties: true };
  return databaseId
    ? initializeFirestore(app, settings, databaseId)
    : initializeFirestore(app, settings);
}

export function getAuth(): Auth {
  return adminGetAuth(getAppInstance());
}

export function getStorage(): Storage {
  return adminGetStorage(getAppInstance());
}

export function getDocumentDb(): DocumentDb {
  return getFirestore();
}

export const db = new Proxy({} as Firestore, {
  get(_target, prop, receiver) {
    const firestore = getFirestore();
    const value = Reflect.get(firestore, prop, receiver);
    return typeof value === 'function' ? value.bind(firestore) : value;
  },
});
