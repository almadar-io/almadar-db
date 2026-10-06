import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteApp, getApps } from 'firebase-admin/app';
import { getFirestore, initializeFirebase, isFirebaseConfigured } from '../src/firebase/index';

const KEYS = ['FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST'] as const;
const saved = new Map<string, string | undefined>();

async function resetApps(): Promise<void> {
  await Promise.all(getApps().map((app) => deleteApp(app)));
}

describe('firebase db accessors without an initialized app', () => {
  beforeEach(async () => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
    await resetApps();
  });

  afterEach(async () => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await resetApps();
  });

  it('reports the missing credentials instead of a bare "not initialized"', () => {
    expect(() => getFirestore()).toThrow(/no credentials found/);
  });

  it('names the package that owns the accessor', () => {
    expect(() => getFirestore()).toThrow(/^@almadar\/db\/firebase:/);
  });

  it('control: an emulator host initializes on first use', () => {
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    expect(() => getFirestore()).not.toThrow();
  });

  it('control: an Auth emulator host alone initializes on first use', () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    expect(() => getFirestore()).not.toThrow();
  });

  it('an emulator host without a project id initializes the demo-almadar project', () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    expect(initializeFirebase().options.projectId).toBe('demo-almadar');
  });

  it('an emulator host keeps an explicit project id', () => {
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    process.env.FIREBASE_PROJECT_ID = 'my-project';
    expect(initializeFirebase().options.projectId).toBe('my-project');
  });

  it('isFirebaseConfigured is true for either emulator host and false with nothing set', () => {
    expect(isFirebaseConfigured()).toBe(false);
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    expect(isFirebaseConfigured()).toBe(true);
    delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    expect(isFirebaseConfigured()).toBe(true);
  });
});

describe('firestoreTargetOf', () => {
  it('the Firestore emulator wins', async () => {
    const { firestoreTargetOf } = await import('../src/firebase/index.js');
    expect(firestoreTargetOf({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_PROJECT_ID: 'kflow-prod' })).toBe('emulator');
  });
  it('a service account or a real project id is the project', async () => {
    const { firestoreTargetOf } = await import('../src/firebase/index.js');
    expect(firestoreTargetOf({ FIREBASE_SERVICE_ACCOUNT_PATH: '/sa.json' })).toBe('project');
    expect(firestoreTargetOf({ FIREBASE_PROJECT_ID: 'kflow-prod' })).toBe('project');
  });
  it('control: the Auth emulator alone, a demo project, or nothing is no Firestore', async () => {
    const { firestoreTargetOf } = await import('../src/firebase/index.js');
    expect(firestoreTargetOf({ FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIREBASE_PROJECT_ID: 'demo-almadar' })).toBeNull();
    expect(firestoreTargetOf({})).toBeNull();
  });
});
