import { describe, it, expect, vi } from 'vitest';
import type { Entity, EntityField } from '@almadar/core';
import { tableNameFor, snakeNameFor, buildWhere, buildPageQueries } from '../src/postgres/rows.js';
import { columnTypeFor, generateSchemaDdl, ensureSchema } from '../src/postgres/schema/ddl.js';

describe('tableNameFor — deterministic entityType → snake_case plural naming', () => {
  it.each([
    ['TimeEntry', 'time_entries'],
    ['Task', 'tasks'],
    ['User', 'users'],
    ['Category', 'categories'],
    ['Bus', 'buses'],
    ['Person', 'persons'],
    ['userProfile', 'user_profiles'],
  ])('%s → %s', (input, expected) => {
    expect(tableNameFor(input)).toBe(expected);
  });

  it('snakeNameFor inserts underscores at lowercase→uppercase transitions only', () => {
    expect(snakeNameFor('TimeEntry')).toBe('time_entry');
    expect(snakeNameFor('URLMap')).toBe('urlmap');
  });
});

describe('columnTypeFor — full field-type → SQL mapping matrix', () => {
  const enumField: EntityField = { name: 'f', type: 'enum', values: ['a'] };
  it.each([
    [{ name: 'f', type: 'string' }, 'text'],
    [{ name: 'f', type: 'email' }, 'text'],
    [{ name: 'f', type: 'url' }, 'text'],
    [{ name: 'f', type: 'phone' }, 'text'],
    [{ name: 'f', type: 'uuid' }, 'text'],
    [{ name: 'f', type: 'image' }, 'text'],
    [{ name: 'f', type: 'event' }, 'text'],
    [{ name: 'f', type: 'trait' }, 'text'],
    [{ name: 'f', type: 'slot' }, 'text'],
    [{ name: 'f', type: 'number' }, 'double precision'],
    [{ name: 'f', type: 'money' }, 'numeric(19,4)'],
    [{ name: 'f', type: 'boolean' }, 'boolean'],
    [{ name: 'f', type: 'date' }, 'date'],
    [{ name: 'f', type: 'timestamp' }, 'timestamptz'],
    [{ name: 'f', type: 'datetime' }, 'timestamptz'],
    [enumField, 'text'],
    [{ name: 'f', type: 'file' }, 'jsonb'],
    [{ name: 'f', type: 'pattern' }, 'jsonb'],
    [{ name: 'f', type: 'node' }, 'jsonb'],
    [{ name: 'f', type: 'object' }, 'jsonb'],
    [{ name: 'f', type: 'union', values: ['A'] }, 'jsonb'],
    [{ name: 'f', type: 'array' }, 'jsonb'],
    [{ name: 'f', type: 'scalar' }, 'jsonb'],
  ] as const)('field %o → %s', (f, expected) => {
    expect(columnTypeFor(f as EntityField)).toBe(expected);
  });
});

describe('generateSchemaDdl', () => {
  it('emits base columns and an enum CHECK constraint with escaped literals', () => {
    const entity: Entity = {
      name: 'Task',
      fields: [
        { name: 'title', type: 'string' },
        { name: 'status', type: 'enum', values: ['draft', "pub'lished"] },
      ],
    };
    const [ddl] = generateSchemaDdl([entity]);
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "tasks"');
    expect(ddl).toContain('"id" text PRIMARY KEY');
    expect(ddl).toContain('"created_at" timestamptz NOT NULL DEFAULT now()');
    expect(ddl).toContain('"updated_at" timestamptz NOT NULL DEFAULT now()');
    expect(ddl).toContain('"title" text');
    expect(ddl).toContain(`CONSTRAINT "tasks_status_chk" CHECK ("status" IN ('draft', 'pub''lished'))`);
  });

  it('emits an FK column for one / many-to-one with ON DELETE actions', () => {
    const entities: Entity[] = [
      { name: 'User', fields: [{ name: 'name', type: 'string' }] },
      {
        name: 'TimeEntry',
        fields: [
          { name: 'note', type: 'string' },
          { name: 'ownerId', type: 'relation', relation: { entity: 'User', cardinality: 'one', onDelete: 'cascade' } },
          { name: 'reviewerId', type: 'relation', relation: { entity: 'User', cardinality: 'many-to-one', onDelete: 'nullify' } },
          { name: 'approverId', type: 'relation', relation: { entity: 'User', cardinality: 'one', onDelete: 'restrict' } },
          { name: 'viewerId', type: 'relation', relation: { entity: 'User', cardinality: 'one' } },
        ],
      },
    ];
    const timeEntryDdl = generateSchemaDdl(entities)[1];
    expect(timeEntryDdl).toContain('"ownerId" text REFERENCES "users"("id") ON DELETE CASCADE');
    expect(timeEntryDdl).toContain('"reviewerId" text REFERENCES "users"("id") ON DELETE SET NULL');
    expect(timeEntryDdl).toContain('"approverId" text REFERENCES "users"("id") ON DELETE RESTRICT');
    expect(timeEntryDdl).toContain('"viewerId" text REFERENCES "users"("id") ON DELETE NO ACTION');
  });

  it('puts the FK on the target table for one-to-many', () => {
    const entities: Entity[] = [
      { name: 'Team', fields: [{ name: 'name', type: 'string' }, { name: 'members', type: 'relation', relation: { entity: 'Player', cardinality: 'one-to-many', onDelete: 'cascade' } }] },
      { name: 'Player', fields: [{ name: 'name', type: 'string' }] },
    ];
    const ddls = generateSchemaDdl(entities);
    expect(ddls[0]).toContain('CREATE TABLE IF NOT EXISTS "teams"');
    expect(ddls[1]).toContain('"team_id" text REFERENCES "teams"("id") ON DELETE CASCADE');
  });

  it('emits a junction table for many-to-many', () => {
    const entities: Entity[] = [
      { name: 'Post', fields: [{ name: 'title', type: 'string' }, { name: 'tags', type: 'relation', relation: { entity: 'Tag', cardinality: 'many-to-many' } }] },
      { name: 'Tag', fields: [{ name: 'label', type: 'string' }] },
    ];
    const ddls = generateSchemaDdl(entities);
    const junction = ddls.find((d) => d.includes('"posts_tags"'));
    expect(junction).toBeDefined();
    expect(junction).toContain('"post_id" text NOT NULL REFERENCES "posts"("id")');
    expect(junction).toContain('"tag_id" text NOT NULL REFERENCES "tags"("id")');
    expect(junction).toContain('PRIMARY KEY ("post_id", "tag_id")');
  });
});

describe('buildWhere — filter-op → SQL translation matrix', () => {
  it.each([
    ['==', '"age" = $1'],
    ['!=', '"age" <> $1'],
    ['<', '"age" < $1'],
    ['<=', '"age" <= $1'],
    ['>', '"age" > $1'],
    ['>=', '"age" >= $1'],
    ['in', '"age" = ANY($1)'],
    ['not-in', '"age" <> ALL($1)'],
    ['contains', `"age"::text ILIKE '%' || $1 || '%'`],
  ] as const)('op %s → %s', (op, clause) => {
    const { where, params } = buildWhere([{ field: 'age', op, value: 42 }]);
    expect(where).toBe(` WHERE ${clause}`);
    expect(params).toEqual([42]);
  });

  it('unknown ops are permissive (no condition), matching the mock', () => {
    const { where, params } = buildWhere([{ field: 'age', op: 'array-contains', value: 1 }]);
    expect(where).toBe('');
    expect(params).toEqual([]);
  });

  it('ANDs multiple filters with running parameter indices', () => {
    const { where, params } = buildWhere([
      { field: 'a', op: '==', value: 1 },
      { field: 'b', op: '>', value: 2 },
    ]);
    expect(where).toBe(' WHERE "a" = $1 AND "b" > $2');
    expect(params).toEqual([1, 2]);
  });
});

describe('buildPageQueries — search / sort / pagination', () => {
  it('searches named fields case-insensitively and sorts NULLS LAST with LIMIT/OFFSET', () => {
    const { sql, countSql, params } = buildPageQueries('tasks', [], {
      page: 2,
      pageSize: 10,
      search: 'abc',
      searchFields: ['title'],
      sortBy: 'title',
      sortOrder: 'desc',
    });
    expect(sql).toBe(
      `SELECT * FROM "tasks" WHERE ("title"::text ILIKE '%' || $1 || '%') ORDER BY "title" DESC NULLS LAST LIMIT $2 OFFSET $3`,
    );
    expect(countSql).toBe(`SELECT COUNT(*)::int AS total FROM "tasks" WHERE ("title"::text ILIKE '%' || $1 || '%')`);
    expect(params).toEqual(['abc', 10, 10]);
  });

  it('searches the whole row when no searchFields are given', () => {
    const { sql } = buildPageQueries('tasks', [], {
      page: 1,
      pageSize: 20,
      search: 'x',
      sortOrder: 'asc',
    });
    expect(sql).toContain('WHERE t::text ILIKE');
  });

  it('combines filters AND search with sequential params', () => {
    const { sql, params } = buildPageQueries('tasks', [{ field: 'done', op: '==', value: false }], {
      page: 1,
      pageSize: 5,
      search: 'q',
      searchFields: ['title', 'note'],
      sortOrder: 'asc',
    });
    expect(sql).toContain(`WHERE "done" = $1 AND ("title"::text ILIKE '%' || $2 || '%' OR "note"::text ILIKE '%' || $2 || '%')`);
    expect(params).toEqual([false, 'q', 5, 0]);
  });
});

describe('ensureSchema', () => {
  it('runs every generated statement against the pool in order', async () => {
    const queries: string[] = [];
    const executor = {
      query: vi.fn((sql: string) => {
        queries.push(sql);
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
    };
    const entities: Entity[] = [
      { name: 'A', fields: [{ name: 'x', type: 'string' }] },
      { name: 'B', fields: [{ name: 'y', type: 'number' }] },
    ];
    await ensureSchema(executor, entities);
    expect(queries).toHaveLength(generateSchemaDdl(entities).length);
    expect(queries[0]).toContain('"as"');
    expect(queries[1]).toContain('"bs"');
  });
});
