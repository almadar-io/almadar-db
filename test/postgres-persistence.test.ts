import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const queryMocks: Mock[] = [];

vi.mock('pg', async () => {
  const { vi: v } = await import('vitest');
  class DatabaseError extends Error {
    code?: string;
    constructor(message?: string) {
      super(message);
      this.name = 'DatabaseError';
    }
  }
  class Pool {
    query = v.fn();
    end = v.fn(() => Promise.resolve());
    constructor() {
      queryMocks.push(this.query);
    }
  }
  return { Pool, DatabaseError };
});

import { Pool, DatabaseError } from 'pg';
import { PostgresPersistence } from '../src/postgres/persistence.js';

let pool: Pool;
let queryMock: Mock;

beforeEach(() => {
  vi.clearAllMocks();
  queryMocks.length = 0;
  pool = new Pool();
  queryMock = queryMocks[0];
});

function makeAdapter(): PostgresPersistence {
  return new PostgresPersistence({ pool });
}

function queryResult(rows: object[], rowCount = rows.length) {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

describe('PostgresPersistence.create', () => {
  it('honors a supplied non-empty string id (R-MOCK-STORE-REKEYS-EXPLICIT-CREATE-ID parity)', async () => {
    const adapter = makeAdapter();
    queryMock.mockResolvedValue(queryResult([], 1));
    const result = await adapter.create('Task', { id: 'task-explicit-1', title: 'Explicit' });
    expect(result.id).toBe('task-explicit-1');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO "tasks"');
    expect(params).toContain('task-explicit-1');
  });

  it('throws on duplicate id', async () => {
    const adapter = makeAdapter();
    const err = new DatabaseError('duplicate key', 0, 'error');
    err.code = '23505';
    queryMock.mockRejectedValue(err);
    await expect(adapter.create('Task', { id: 'dupe' })).rejects.toThrow('Entity Task with id dupe already exists');
  });

  it('mints a uuid when id is absent or empty', async () => {
    const adapter = makeAdapter();
    queryMock.mockResolvedValue(queryResult([], 1));
    const result = await adapter.create('Task', { title: 'No id' });
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    const [, params] = queryMock.mock.calls[0];
    expect(params).toContain(result.id);
  });
});

describe('PostgresPersistence.update / delete', () => {
  it('update issues a parameterized UPDATE scoped by id', async () => {
    const adapter = makeAdapter();
    queryMock.mockResolvedValue(queryResult([], 1));
    await adapter.update('Task', 'task-1', { title: 'New' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toBe('UPDATE "tasks" SET "title" = $1 WHERE "id" = $2');
    expect(params).toEqual(['New', 'task-1']);
  });

  it('delete issues a parameterized DELETE scoped by id', async () => {
    const adapter = makeAdapter();
    queryMock.mockResolvedValue(queryResult([], 0));
    await adapter.delete('Task', 'missing');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toBe('DELETE FROM "tasks" WHERE "id" = $1');
    expect(params).toEqual(['missing']);
  });
});

describe('PostgresPersistence.getById / list', () => {
  it('getById returns null on miss, deserializes timestamps on hit', async () => {
    const adapter = makeAdapter();
    queryMock.mockResolvedValueOnce(queryResult([], 0));
    expect(await adapter.getById('Task', 'x')).toBeNull();
    queryMock.mockResolvedValueOnce(
      queryResult([{ id: 'x', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]),
    );
    const row = await adapter.getById('Task', 'x');
    expect(row?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('list returns all rows of the entity table', async () => {
    const adapter = makeAdapter();
    queryMock.mockResolvedValue(queryResult([{ id: 'a' }, { id: 'b' }]));
    const rows = await adapter.list('Task');
    expect(rows).toHaveLength(2);
    const [sql] = queryMock.mock.calls[0];
    expect(sql).toBe('SELECT * FROM "tasks"');
  });
});

describe('PostgresPersistence.query', () => {
  it('pushes supported filters into SQL and deserializes rows', async () => {
    queryMock.mockResolvedValue(queryResult([{ id: 'a' }, { id: 'b' }]));
    const rows = await makeAdapter().query('Task', [
      { field: 'title', op: 'contains', value: 'foo' },
      { field: 'done', op: '==', value: true },
      { field: 'tags', op: 'in', value: ['x', 'y'] },
    ]);
    expect(rows).toHaveLength(2);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toBe(`SELECT * FROM "tasks" WHERE "title"::text ILIKE '%' || $1 || '%' AND "done" = $2 AND "tags" = ANY($3)`);
    expect(params).toEqual(['foo', true, ['x', 'y']]);
  });

  it('control: an operator SQL does not express (array-contains) is applied in memory, never dropped', async () => {
    queryMock.mockResolvedValue(queryResult([{ id: 'a', tags: ['x'] }, { id: 'b', tags: ['y'] }]));
    const rows = await makeAdapter().query('Task', [{ field: 'tags', op: 'array-contains', value: 'y' }]);
    expect(rows.map((r) => r.id)).toEqual(['b']);
    expect(queryMock.mock.calls[0][0]).toBe('SELECT * FROM "tasks"');
  });
});

describe('PostgresPersistence.listPage', () => {
  it('pages in SQL with a count query for the total', async () => {
    queryMock
      .mockResolvedValueOnce(queryResult([{ id: 'a' }, { id: 'b' }]))
      .mockResolvedValueOnce(queryResult([{ total: 7 }]));
    const page = await makeAdapter().listPage('Task', { page: 2, pageSize: 2, sortBy: 'title', sortOrder: 'desc' });
    expect(page).toEqual({ rows: [{ id: 'a' }, { id: 'b' }], total: 7 });
    expect(queryMock.mock.calls[0][0]).toContain('ORDER BY "title" DESC NULLS LAST LIMIT $1 OFFSET $2');
    expect(queryMock.mock.calls[1]).toEqual(['SELECT COUNT(*)::int AS total FROM "tasks"', []]);
  });

  it('edge: a filter SQL does not express pages in memory so the total stays right', async () => {
    queryMock.mockResolvedValue(queryResult([{ id: 'a', tags: ['x'] }, { id: 'b', tags: ['y'] }, { id: 'c', tags: ['y'] }]));
    const page = await makeAdapter().listPage('Task', { page: 1, pageSize: 1, filters: [{ field: 'tags', op: 'array-contains', value: 'y' }] });
    expect(page).toEqual({ rows: [{ id: 'b', tags: ['y'] }], total: 2 });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
