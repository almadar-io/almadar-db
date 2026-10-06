import type { PersistenceSpec } from './create-persistence.js';

export type PersistenceEnv = Readonly<Record<string, string | undefined>>;

const DATA_BACKENDS = ['mock', 'firebase', 'postgres', 'couchdb'] as const;
type DataBackend = (typeof DATA_BACKENDS)[number];

function isDataBackend(value: string): value is DataBackend {
  return (DATA_BACKENDS as readonly string[]).includes(value);
}

/**
 * Maps the server env contract onto a `PersistenceSpec`: `DATA_BACKEND` (mock | firebase |
 * postgres | couchdb, default firebase), the `USE_MOCK_DATA` legacy flag (wins over the
 * backend), `DATABASE_URL`, `PGPOOL_MAX`, `COUCHDB_URL`. Mock is refused under
 * `NODE_ENV=production` (unset NODE_ENV counts as production): its rows are fabricated and
 * lost on restart, so a production server must never serve them.
 */
export function persistenceSpecFromEnv(env: PersistenceEnv): PersistenceSpec {
  const nodeEnv = env['NODE_ENV'] ?? 'production';
  const flag = env['USE_MOCK_DATA'] ?? 'false';
  if (flag !== 'true' && flag !== 'false') {
    throw new Error(`@almadar/db: USE_MOCK_DATA must be 'true' or 'false', got '${flag}'`);
  }
  const useMock = flag === 'true';
  const rawBackend = env['DATA_BACKEND'] ?? 'firebase';
  if (!isDataBackend(rawBackend)) {
    throw new Error(`@almadar/db: DATA_BACKEND must be one of ${DATA_BACKENDS.join(', ')}, got '${rawBackend}'`);
  }

  if (nodeEnv === 'production' && useMock) {
    throw new Error(
      '@almadar/server: USE_MOCK_DATA=true is not permitted when NODE_ENV=production. ' +
        'Unset USE_MOCK_DATA to use the real data source, or set NODE_ENV=development.',
    );
  }
  if (nodeEnv === 'production' && rawBackend === 'mock') {
    throw new Error(
      '@almadar/server: DATA_BACKEND=mock is not permitted when NODE_ENV=production. ' +
        "Set DATA_BACKEND=postgres or 'firebase', or set NODE_ENV=development.",
    );
  }

  if (useMock || rawBackend === 'mock') return { backend: 'mock' };

  if (rawBackend === 'postgres') {
    const connectionString = env['DATABASE_URL'];
    if (!connectionString) {
      throw new Error('@almadar/server: DATA_BACKEND=postgres requires DATABASE_URL to be set');
    }
    const poolMax = env['PGPOOL_MAX'] ? parseInt(env['PGPOOL_MAX'], 10) : undefined;
    return { backend: 'postgres', connectionString, ...(poolMax !== undefined ? { poolMax } : {}) };
  }

  if (rawBackend === 'couchdb') {
    const url = env['COUCHDB_URL'];
    if (!url) {
      throw new Error('@almadar/server: DATA_BACKEND=couchdb requires COUCHDB_URL to be set');
    }
    return { backend: 'couchdb', url };
  }

  return { backend: 'firestore', root: '' };
}
