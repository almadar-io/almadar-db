import { describe, it, expect } from 'vitest';
import { persistenceSpecFromEnv } from '../src/backend/index.js';

const dev = { NODE_ENV: 'development' };

describe('persistenceSpecFromEnv', () => {
  it('defaults to firestore with the top-level root', () => {
    expect(persistenceSpecFromEnv(dev)).toEqual({ backend: 'firestore', root: '' });
    expect(persistenceSpecFromEnv({})).toEqual({ backend: 'firestore', root: '' });
    expect(persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'firebase' })).toEqual({ backend: 'firestore', root: '' });
  });

  it('USE_MOCK_DATA=true selects mock, and wins over DATA_BACKEND', () => {
    expect(persistenceSpecFromEnv({ ...dev, USE_MOCK_DATA: 'true' })).toEqual({ backend: 'mock' });
    expect(persistenceSpecFromEnv({ ...dev, USE_MOCK_DATA: 'true', DATA_BACKEND: 'postgres', DATABASE_URL: 'postgres://x' })).toEqual({ backend: 'mock' });
  });

  it('DATA_BACKEND=mock selects mock', () => {
    expect(persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'mock' })).toEqual({ backend: 'mock' });
  });

  it('postgres carries DATABASE_URL and PGPOOL_MAX when set', () => {
    expect(persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'postgres', DATABASE_URL: 'postgres://h/db' })).toEqual({
      backend: 'postgres',
      connectionString: 'postgres://h/db',
    });
    expect(persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'postgres', DATABASE_URL: 'postgres://h/db', PGPOOL_MAX: '12' })).toEqual({
      backend: 'postgres',
      connectionString: 'postgres://h/db',
      poolMax: 12,
    });
  });

  it('postgres without DATABASE_URL throws the server error', () => {
    expect(() => persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'postgres' })).toThrow(
      '@almadar/server: DATA_BACKEND=postgres requires DATABASE_URL to be set',
    );
    expect(() => persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'postgres', DATABASE_URL: '' })).toThrow(/requires DATABASE_URL/);
  });

  it('couchdb carries COUCHDB_URL and throws without it', () => {
    expect(persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'couchdb', COUCHDB_URL: 'http://c:5984' })).toEqual({ backend: 'couchdb', url: 'http://c:5984' });
    expect(() => persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'couchdb' })).toThrow(
      '@almadar/server: DATA_BACKEND=couchdb requires COUCHDB_URL to be set',
    );
  });

  it('refuses USE_MOCK_DATA=true in production, and when NODE_ENV is unset', () => {
    expect(() => persistenceSpecFromEnv({ NODE_ENV: 'production', USE_MOCK_DATA: 'true' })).toThrow(/USE_MOCK_DATA=true is not permitted when NODE_ENV=production/);
    expect(() => persistenceSpecFromEnv({ USE_MOCK_DATA: 'true' })).toThrow(/USE_MOCK_DATA=true is not permitted/);
  });

  it('refuses DATA_BACKEND=mock in production', () => {
    expect(() => persistenceSpecFromEnv({ NODE_ENV: 'production', DATA_BACKEND: 'mock' })).toThrow(/DATA_BACKEND=mock is not permitted when NODE_ENV=production/);
  });

  it('allows mock in test and development', () => {
    expect(persistenceSpecFromEnv({ NODE_ENV: 'test', USE_MOCK_DATA: 'true' })).toEqual({ backend: 'mock' });
  });

  it('production with a real backend is fine', () => {
    expect(persistenceSpecFromEnv({ NODE_ENV: 'production', DATA_BACKEND: 'postgres', DATABASE_URL: 'postgres://h/db' })).toMatchObject({ backend: 'postgres' });
  });

  it('hard-fails a typo in USE_MOCK_DATA or DATA_BACKEND instead of falling through', () => {
    expect(() => persistenceSpecFromEnv({ ...dev, USE_MOCK_DATA: 'yes' })).toThrow(/USE_MOCK_DATA must be/);
    expect(() => persistenceSpecFromEnv({ ...dev, DATA_BACKEND: 'mongo' })).toThrow(/DATA_BACKEND must be one of/);
  });
});
