import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  JAVA21_CANDIDATES,
  emulatorPlan,
  findJava21Home,
  startFirebaseEmulators,
  stopEmulatorsIn,
  type EmulatorOptions,
} from '../src/emulator/index.js';

function options(overrides: Partial<EmulatorOptions> = {}): EmulatorOptions {
  return {
    projectId: 'demo-almadar',
    dataDir: mkdtempSync(join(tmpdir(), 'almadar-emu-')),
    services: ['firestore', 'auth'],
    ports: { firestore: 8080, auth: 9099 },
    firebaseBin: 'firebase',
    javaHome: '/opt/java21',
    env: { PATH: '/usr/bin', NODE_ENV: 'development' },
    ...overrides,
  };
}

describe('emulatorPlan', () => {
  it('starts the requested services under the demo project with its own config and export dir', () => {
    const o = options();
    const plan = emulatorPlan(o);
    expect(plan.command).toBe('firebase');
    expect(plan.args).toEqual([
      'emulators:start', '--only', 'firestore,auth', '--project', 'demo-almadar',
      '--config', join(o.dataDir, 'firebase.json'), '--export-on-exit', join(o.dataDir, 'export'),
    ]);
    expect(plan.config.emulators).toEqual({
      ui: { enabled: false },
      singleProjectMode: { enabled: true },
      firestore: { host: '127.0.0.1', port: 8080 },
      auth: { host: '127.0.0.1', port: 9099 },
    });
  });

  it('imports the previous export only when one exists', () => {
    const o = options();
    expect(emulatorPlan(o).args).not.toContain('--import');
    mkdirSync(join(o.dataDir, 'export'), { recursive: true });
    writeFileSync(join(o.dataDir, 'export', 'firebase-export-metadata.json'), '{}');
    expect(emulatorPlan(o).args.slice(-2)).toEqual(['--import', join(o.dataDir, 'export')]);
  });

  it('hands clients the emulator hosts and project for exactly the services started', () => {
    expect(emulatorPlan(options()).clientEnv).toEqual({
      FIREBASE_PROJECT_ID: 'demo-almadar',
      GCLOUD_PROJECT: 'demo-almadar',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    });
    expect(emulatorPlan(options({ services: ['firestore'] })).clientEnv).toEqual({
      FIREBASE_PROJECT_ID: 'demo-almadar',
      GCLOUD_PROJECT: 'demo-almadar',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    });
  });

  it('puts Java 21 first on the child PATH', () => {
    const plan = emulatorPlan(options());
    expect(plan.childEnv['JAVA_HOME']).toBe('/opt/java21');
    expect(plan.childEnv['PATH']?.startsWith('/opt/java21/bin')).toBe(true);
  });

  it('refuses production', () => {
    expect(() => emulatorPlan(options({ env: { NODE_ENV: 'production' } }))).toThrow(/NODE_ENV=production/);
  });

  it('refuses a project that is not a demo project', () => {
    expect(() => emulatorPlan(options({ projectId: 'kflow-prod' }))).toThrow(/must start with "demo-"/);
  });

  it('refuses an empty service list', () => {
    expect(() => emulatorPlan(options({ services: [] }))).toThrow(/no services/);
  });
});

describe('startFirebaseEmulators port check', () => {
  it('refuses when only some requested ports are taken: that is not one emulator suite', async () => {
    const squatter = createServer();
    await new Promise<void>((resolve) => squatter.listen(18190, '127.0.0.1', resolve));
    try {
      await expect(startFirebaseEmulators(options({ ports: { firestore: 18190, auth: 18191 } })))
        .rejects.toThrow(/port 18190 is in use but 18191 is not/);
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});

describe('findJava21Home', () => {
  const fakeHome = () => {
    const home = mkdtempSync(join(tmpdir(), 'java21-'));
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin', 'java'), '');
    return home;
  };

  it('JAVA21_HOME wins', () => {
    const home = fakeHome();
    expect(findJava21Home({ JAVA21_HOME: home }, ['/nowhere'])).toBe(home);
  });
  it('a JAVA21_HOME without bin/java is an error, not a fallback', () => {
    expect(() => findJava21Home({ JAVA21_HOME: '/nowhere' }, [fakeHome()])).toThrow(/has no bin\/java/);
  });
  it('else the first candidate that has bin/java', () => {
    const home = fakeHome();
    expect(findJava21Home({}, ['/nowhere', home])).toBe(home);
  });
  it('none found names the candidates', () => {
    expect(() => findJava21Home({}, ['/a', '/b'])).toThrow(/looked in \/a, \/b/);
  });
});

function open(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

describe.runIf(process.env['ALMADAR_EMULATOR_LIVE'] === '1')('startFirebaseEmulators (live)', () => {
  it('starts, reuses while up, and stops', async () => {
    const o = options({
      ports: { firestore: 18080, auth: 19099 },
      javaHome: findJava21Home(process.env, JAVA21_CANDIDATES),
      env: { ...process.env, NODE_ENV: 'development' },
    });
    const first = await startFirebaseEmulators(o);
    try {
      expect(first.reused).toBe(false);
      expect(await open(18080)).toBe(true);
      expect(await open(19099)).toBe(true);
      const second = await startFirebaseEmulators(o);
      expect(second.reused).toBe(true);
      expect(second.env).toEqual(first.env);
    } finally {
      await first.stop();
    }
    expect(await open(18080)).toBe(false);
  }, 180_000);

  it('stopEmulatorsIn stops what a start in that dir left running, and exports its data', async () => {
    const o = options({
      ports: { firestore: 18083, auth: 19096 },
      javaHome: findJava21Home(process.env, JAVA21_CANDIDATES),
      env: { ...process.env, NODE_ENV: 'development' },
    });
    await startFirebaseEmulators(o, 120_000, true);
    expect(await open(18083)).toBe(true);
    expect(await stopEmulatorsIn(o.dataDir)).toBe(true);
    expect(await open(18083)).toBe(false);
    expect(existsSync(join(o.dataDir, 'export', 'firebase-export-metadata.json'))).toBe(true);
    expect(await stopEmulatorsIn(o.dataDir)).toBe(false);
  }, 180_000);
});
