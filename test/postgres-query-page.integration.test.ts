/**
 * queryPage against a real PostgreSQL over the shared push-down cases: skipped unless
 * TEST_DATABASE_URL is set (e.g. TEST_DATABASE_URL=postgres://postgres:pw@localhost:55432/postgres).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { Entity } from '@almadar/core';
import { ensureSchema } from '../src/postgres/schema/ddl.js';
import { PostgresPersistence } from '../src/postgres/persistence.js';
import { FIXTURE_ENTITY, FIXTURE_ROWS, partitionCases, runQueryPageCases } from './support/query-cases';

const connectionString = process.env.TEST_DATABASE_URL;

const TICKET: Entity = {
  name: FIXTURE_ENTITY,
  fields: [
    { name: 'title', type: 'string' },
    { name: 'status', type: 'string' },
    { name: 'priority', type: 'number' },
    { name: 'owner', type: 'string' },
    { name: 'tags', type: 'array', items: { name: 'tag', type: 'string' } },
    { name: 'score', type: 'number' },
  ],
};

describe.skipIf(!connectionString)('PostgresPersistence.queryPage (TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString });
  let ready: Promise<PostgresPersistence> | undefined;

  const make = (): Promise<PostgresPersistence> => {
    ready ??= (async () => {
      await pool.query('DROP TABLE IF EXISTS tickets CASCADE');
      await ensureSchema(pool, [TICKET]);
      const store = new PostgresPersistence({ pool });
      for (const row of FIXTURE_ROWS) await store.create(FIXTURE_ENTITY, { ...row });
      return store;
    })();
    return ready;
  };

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS tickets CASCADE');
    await pool.end();
  });

  runQueryPageCases('PostgresPersistence (live)', make);

  it('pushes down every one of the 29 cases', async () => {
    expect(partitionCases(await make()).declined).toEqual([]);
  });

  it('a field the table does not have is missing on every row', async () => {
    const store = await make();
    const all = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'isNull', field: 'nowhere', isNull: true } });
    expect(all.total).toBe(FIXTURE_ROWS.length);
    const none = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'compare', field: 'nowhere', op: '==', value: 'x' } });
    expect(none).toEqual({ rows: [], total: 0 });
  });

  it('% and _ in contains text are literal', async () => {
    const store = await make();
    await store.create(FIXTURE_ENTITY, { id: 'z1', title: '100% sure_', status: 'open' });
    await store.create(FIXTURE_ENTITY, { id: 'z2', title: '100x sureX', status: 'open' });
    const page = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'contains', field: 'title', text: '0% sure_', caseSensitive: true } });
    expect(page.rows.map((r) => r.id)).toEqual(['z1']);
    await store.delete(FIXTURE_ENTITY, 'z1');
    await store.delete(FIXTURE_ENTITY, 'z2');
  });

  it('text order is binary, not locale order', async () => {
    const store = await make();
    await store.create(FIXTURE_ENTITY, { id: 'zb', title: 'B', status: 's' });
    await store.create(FIXTURE_ENTITY, { id: 'za', title: 'a', status: 's' });
    const page = await store.queryPage(FIXTURE_ENTITY, { filter: { kind: 'compare', field: 'status', op: '==', value: 's' }, order: { field: 'title', direction: 'asc' } });
    expect(page.rows.map((r) => r.id)).toEqual(['zb', 'za']);
    await store.delete(FIXTURE_ENTITY, 'zb');
    await store.delete(FIXTURE_ENTITY, 'za');
  });
});
