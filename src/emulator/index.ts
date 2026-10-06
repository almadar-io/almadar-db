import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join } from 'node:path';
import { createLogger } from '@almadar/logger';

const emulatorLog = createLogger('almadar:db:emulator');

export type EmulatorService = 'firestore' | 'auth';

export interface EmulatorOptions {
  /** Must start with `demo-`: a demo project can never reach a real Firebase project. */
  projectId: string;
  /** Holds the generated `firebase.json`, the log, and the data exported on exit and imported on the next start. */
  dataDir: string;
  services: readonly EmulatorService[];
  ports: { firestore: number; auth: number };
  /** The `firebase` CLI (firebase-tools). */
  firebaseBin: string;
  /** A Java 21+ home; firebase-tools runs the Firestore emulator on it. */
  javaHome: string;
  /** The host's environment; refused when `NODE_ENV=production`. */
  env: Readonly<Record<string, string | undefined>>;
}

export interface EmulatorPlan {
  command: string;
  args: string[];
  configPath: string;
  config: { emulators: Record<string, { host: string; port: number } | { enabled: boolean }>; firestore?: { rules: string } };
  childEnv: Record<string, string>;
  /** What every process that should use the emulators needs in its environment. */
  clientEnv: EmulatorEnv;
  logPath: string;
}

export interface EmulatorEnv {
  FIREBASE_PROJECT_ID: string;
  GCLOUD_PROJECT: string;
  FIRESTORE_EMULATOR_HOST?: string;
  FIREBASE_AUTH_EMULATOR_HOST?: string;
}

export interface RunningEmulators {
  env: EmulatorEnv;
  /** True when every requested port was already listening and this call started nothing. */
  reused: boolean;
  stop(): Promise<void>;
}

const HOST = '127.0.0.1';
const EXPORT_DIR = 'export';
const PID_FILE = 'emulator.pid';
const OPEN_RULES = "rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read, write: if true; } } }\n";

/** The command, config and environment a start would use. Pure: no process is spawned. */
export function emulatorPlan(options: EmulatorOptions): EmulatorPlan {
  if (options.env['NODE_ENV'] === 'production') {
    throw new Error('@almadar/db/emulator: refusing to start the Firebase emulators with NODE_ENV=production');
  }
  if (!options.projectId.startsWith('demo-')) {
    throw new Error(`@almadar/db/emulator: projectId must start with "demo-" (got "${options.projectId}") so it can never reach a real project`);
  }
  if (options.services.length === 0) throw new Error('@almadar/db/emulator: no services requested');

  const configPath = join(options.dataDir, 'firebase.json');
  const exportDir = join(options.dataDir, EXPORT_DIR);
  const emulators: EmulatorPlan['config']['emulators'] = { ui: { enabled: false }, singleProjectMode: { enabled: true } };
  for (const service of options.services) emulators[service] = { host: HOST, port: options.ports[service] };
  const config: EmulatorPlan['config'] = {
    emulators,
    ...(options.services.includes('firestore') ? { firestore: { rules: 'firestore.rules' } } : {}),
  };

  const args = ['emulators:start', '--only', options.services.join(','), '--project', options.projectId, '--config', configPath, '--export-on-exit', exportDir];
  if (existsSync(join(exportDir, 'firebase-export-metadata.json'))) args.push('--import', exportDir);

  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env)) if (value !== undefined) childEnv[key] = value;
  childEnv['JAVA_HOME'] = options.javaHome;
  childEnv['PATH'] = [join(options.javaHome, 'bin'), options.env['PATH'] ?? ''].join(delimiter);

  const clientEnv: EmulatorEnv = {
    FIREBASE_PROJECT_ID: options.projectId,
    GCLOUD_PROJECT: options.projectId,
    ...(options.services.includes('firestore') ? { FIRESTORE_EMULATOR_HOST: `${HOST}:${options.ports.firestore}` } : {}),
    ...(options.services.includes('auth') ? { FIREBASE_AUTH_EMULATOR_HOST: `${HOST}:${options.ports.auth}` } : {}),
  };

  return { command: options.firebaseBin, args, configPath, config, childEnv, clientEnv, logPath: join(options.dataDir, 'emulator.log') };
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function allListening(ports: readonly number[]): Promise<boolean> {
  const states = await Promise.all(ports.map(listening));
  return states.every(Boolean);
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
}

/**
 * Start the Firebase emulator suite (or reuse one already listening on every requested port) and
 * return the environment the host passes to whatever it forks. Data is exported on exit and
 * imported on the next start, so local rows and users survive restarts.
 */
export async function startFirebaseEmulators(
  options: EmulatorOptions,
  readyTimeoutMs = 120_000,
  /** Let the emulators outlive this process (shared by every dev host on the machine). */
  outlive = false,
): Promise<RunningEmulators> {
  const plan = emulatorPlan(options);
  const ports = options.services.map((s) => options.ports[s]);
  const states = await Promise.all(ports.map(listening));
  if (states.every(Boolean)) {
    emulatorLog.info('emulator:reused', { ports, projectId: options.projectId });
    return { env: plan.clientEnv, reused: true, stop: async () => {} };
  }
  const taken = ports.filter((_, i) => states[i]);
  if (taken.length > 0) {
    throw new Error(`@almadar/db/emulator: port ${taken.join(', ')} is in use but ${ports.filter((_, i) => !states[i]).join(', ')} is not, so this is not one emulator suite; stop what holds ${taken.join(', ')} or declare other ports`);
  }

  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(plan.configPath, JSON.stringify(plan.config, null, 2));
  if (plan.config.firestore) writeFileSync(join(options.dataDir, plan.config.firestore.rules), OPEN_RULES);
  const log = openSync(plan.logPath, 'a');
  const child = spawn(plan.command, plan.args, { env: plan.childEnv, stdio: ['ignore', log, log], detached: true });
  if (child.pid !== undefined) writeFileSync(join(options.dataDir, PID_FILE), String(child.pid));
  emulatorLog.info('emulator:starting', { args: plan.args, log: plan.logPath });

  const deadline = Date.now() + readyTimeoutMs;
  while (!(await allListening(ports))) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`@almadar/db/emulator: firebase exited (${child.exitCode ?? child.signalCode}) before listening; see ${plan.logPath}`);
    }
    if (Date.now() > deadline) {
      process.kill(-(child.pid ?? 0), 'SIGTERM');
      throw new Error(`@almadar/db/emulator: not listening on ${ports.join(', ')} after ${readyTimeoutMs} ms; see ${plan.logPath}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  emulatorLog.info('emulator:ready', { ...plan.clientEnv });
  if (outlive) child.unref();

  return {
    env: plan.clientEnv,
    reused: false,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      process.kill(-(child.pid ?? 0), 'SIGINT');
      await exited(child);
    },
  };
}

/** Java 21+: `JAVA21_HOME` when set, else the first known install location that has `bin/java`. */
export function findJava21Home(env: Readonly<Record<string, string | undefined>>, candidates: readonly string[]): string {
  const declared = env['JAVA21_HOME'];
  if (declared) {
    if (!existsSync(join(declared, 'bin', 'java'))) throw new Error(`@almadar/db/emulator: JAVA21_HOME=${declared} has no bin/java`);
    return declared;
  }
  const found = candidates.find((home) => existsSync(join(home, 'bin', 'java')));
  if (!found) {
    throw new Error(`@almadar/db/emulator: no Java 21 found; set JAVA21_HOME (looked in ${candidates.join(', ')})`);
  }
  return found;
}

export const JAVA21_CANDIDATES: readonly string[] = [
  '/opt/homebrew/opt/openjdk@21',
  '/usr/local/opt/openjdk@21',
  '/usr/lib/jvm/java-21-openjdk-amd64',
  '/usr/lib/jvm/java-21-openjdk',
];

export const DEV_EMULATOR_PROJECT = 'demo-almadar';
export const DEV_EMULATOR_PORTS = { firestore: 8080, auth: 9099 } as const;

/**
 * The dev default every host uses: Firestore + Auth on 8080/9099 under `demo-almadar`, the
 * `firebase` CLI from `FIREBASE_TOOLS_BIN` (else `firebase` on PATH), Java from {@link findJava21Home}.
 * Started once per machine and left running for every later host to reuse. Hosts and a `demo-`
 * project the caller already declares (`FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST`,
 * `FIREBASE_PROJECT_ID`) take precedence over the defaults.
 */
export function startDevEmulators(dataDir: string, env: Readonly<Record<string, string | undefined>>): Promise<RunningEmulators> {
  return startFirebaseEmulators({
    projectId: env['FIREBASE_PROJECT_ID']?.startsWith('demo-') ? env['FIREBASE_PROJECT_ID'] : DEV_EMULATOR_PROJECT,
    dataDir,
    services: ['firestore', 'auth'],
    ports: {
      firestore: portOf(env['FIRESTORE_EMULATOR_HOST']) ?? DEV_EMULATOR_PORTS.firestore,
      auth: portOf(env['FIREBASE_AUTH_EMULATOR_HOST']) ?? DEV_EMULATOR_PORTS.auth,
    },
    firebaseBin: env['FIREBASE_TOOLS_BIN'] ?? 'firebase',
    javaHome: findJava21Home(env, JAVA21_CANDIDATES),
    env,
  }, 120_000, true);
}

/**
 * Stop the emulators a start under `dataDir` left running (they export their data on the way out).
 * Answers false when none was started from there or it is already gone.
 */
export async function stopEmulatorsIn(dataDir: string, timeoutMs = 60_000): Promise<boolean> {
  const pidPath = join(dataDir, PID_FILE);
  if (!existsSync(pidPath)) return false;
  const pid = Number(readFileSync(pidPath, 'utf-8'));
  rmSync(pidPath);
  try {
    process.kill(-pid, 'SIGINT');
  } catch {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) throw new Error(`@almadar/db/emulator: pid ${pid} still running ${timeoutMs} ms after SIGINT`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function portOf(host: string | undefined): number | undefined {
  if (host === undefined) return undefined;
  const port = Number(host.slice(host.lastIndexOf(':') + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`@almadar/db/emulator: "${host}" is not host:port`);
  return port;
}
