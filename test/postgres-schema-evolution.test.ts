import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Entity } from '@almadar/core';
import { diffSchema, diffHasDestructive, applySchemaEvolution, type EvolutionGate } from '../src/postgres/schema/evolution.js';
import { generateSchemaDdl } from '../src/postgres/schema/ddl.js';

interface InfoColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  numeric_precision: number | null;
  numeric_scale: number | null;
}

interface InfoCheckRow {
  table_name: string;
  constraint_name: string;
  check_clause: string;
}

interface Fixture {
  tables: string[];
  columns: InfoColumnRow[];
  checks: InfoCheckRow[];
}

const BASE_COLS: InfoColumnRow[] = [
  { table_name: 'tasks', column_name: 'id', data_type: 'text', numeric_precision: null, numeric_scale: null },
  { table_name: 'tasks', column_name: 'created_at', data_type: 'timestamp with time zone', numeric_precision: null, numeric_scale: null },
  { table_name: 'tasks', column_name: 'updated_at', data_type: 'timestamp with time zone', numeric_precision: null, numeric_scale: null },
];

function textCol(table: string, name: string): InfoColumnRow {
  return { table_name: table, column_name: name, data_type: 'text', numeric_precision: null, numeric_scale: null };
}

function checkRow(table: string, name: string, clause: string): InfoCheckRow {
  return { table_name: table, constraint_name: name, check_clause: clause };
}

/** In-memory SqlExecutor: records SQL, serves information_schema fixtures. */
function fakeExecutor(fixture: Fixture) {
  const queries: string[] = [];
  const executor = {
    queries,
    query: vi.fn((sql: string, params?: string[]) => {
      queries.push(sql);
      if (sql.includes('information_schema.tables')) {
        const names = (params?.[1] ?? fixture.tables) as string[];
        return Promise.resolve({
          rows: fixture.tables.filter((t) => names.includes(t)).map((t) => ({ table_name: t })),
        });
      }
      if (sql.includes('information_schema.columns')) {
        const names = (params?.[1] ?? []) as string[];
        return Promise.resolve({ rows: fixture.columns.filter((c) => names.includes(c.table_name)) });
      }
      if (sql.includes('information_schema.table_constraints')) {
        const names = (params?.[1] ?? []) as string[];
        return Promise.resolve({ rows: fixture.checks.filter((c) => names.includes(c.table_name)) });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
  };
  return executor;
}

const V1: Entity[] = [
  {
    name: 'Task',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'status', type: 'enum', values: ['draft', 'published'] },
    ],
  },
];

const V2_ADD: Entity[] = [
  {
    name: 'Task',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'status', type: 'enum', values: ['draft', 'published', 'archived'] },
      { name: 'minutes', type: 'number' },
    ],
  },
];

const V2_DROP: Entity[] = [{ name: 'Task', fields: [{ name: 'title', type: 'string' }] }];

const V1_FIXTURE: Fixture = {
  tables: ['tasks'],
  columns: [
    ...BASE_COLS,
    textCol('tasks', 'title'),
    textCol('tasks', 'status'),
  ],
  checks: [checkRow('tasks', 'tasks_status_chk', `(("status")::text = ANY (ARRAY['draft'::text, 'published'::text]))`)],
};

describe('diffSchema', () => {
  it('reports nothing for a database matching the declared schema', async () => {
    const executor = fakeExecutor(V1_FIXTURE);
    const diff = await diffSchema(executor, V1);
    expect(diff).toEqual({
      tablesToCreate: [],
      columnsToAdd: [],
      columnsToDrop: [],
      columnsToRetype: [],
      checksToAdd: [],
      checksToNarrow: [],
      checksToDrop: [],
      junctionsToCreate: [],
      junctionsToDrop: [],
    });
    expect(diffHasDestructive(diff)).toBe(false);
  });

  it('reports a missing table for fresh databases', async () => {
    const executor = fakeExecutor({ tables: [], columns: [], checks: [] });
    const diff = await diffSchema(executor, V1);
    expect(diff.tablesToCreate).toEqual(['tasks']);
  });

  it('reports added columns, enum widening, and no drops', async () => {
    const executor = fakeExecutor(V1_FIXTURE);
    const diff = await diffSchema(executor, V2_ADD);
    expect(diff.columnsToAdd).toEqual([
      { table: 'tasks', column: 'minutes', from: null, to: 'double precision' },
    ]);
    expect(diff.checksToAdd).toEqual([
      {
        table: 'tasks',
        constraint: 'tasks_status_chk',
        column: 'status',
        kind: 'widen',
        values: ['draft', 'published', 'archived'],
      },
    ]);
    expect(diff.columnsToDrop).toEqual([]);
    expect(diffHasDestructive(diff)).toBe(false);
  });

  it('reports dropped columns and check narrowing as destructive', async () => {
    const executor = fakeExecutor(V1_FIXTURE);
    const diff = await diffSchema(executor, V2_DROP);
    expect(diff.columnsToDrop).toEqual([
      { table: 'tasks', column: 'status', from: 'text', to: null },
    ]);
    // The orphaned CHECK rides with the column (dropped implicitly with it).
    expect(diff.checksToDrop).toEqual([]);
    expect(diffHasDestructive(diff)).toBe(true);
  });

  it('reports an orphaned CHECK as a safe drop when the column survives a retype', async () => {
    const fixture: Fixture = {
      tables: ['tasks'],
      columns: [...BASE_COLS, textCol('tasks', 'title'), textCol('tasks', 'status')],
      checks: [checkRow('tasks', 'tasks_status_chk', `(("status")::text = ANY (ARRAY['draft'::text, 'published'::text]))`)],
    };
    const retyped: Entity[] = [
      { name: 'Task', fields: [{ name: 'title', type: 'string' }, { name: 'status', type: 'string' }] },
    ];
    const executor = fakeExecutor(fixture);
    const diff = await diffSchema(executor, retyped);
    expect(diff.checksToDrop).toEqual([
      { table: 'tasks', constraint: 'tasks_status_chk', column: 'status', kind: 'drop', values: [] },
    ]);
    expect(diff.columnsToRetype).toEqual([]);
    expect(diffHasDestructive(diff)).toBe(false);
  });

  it('reports retype as destructive', async () => {
    const fixture: Fixture = {
      tables: ['tasks'],
      columns: [...BASE_COLS, textCol('tasks', 'title'), textCol('tasks', 'status')],
      checks: [checkRow('tasks', 'tasks_status_chk', `(("status")::text = ANY (ARRAY['draft'::text, 'published'::text]))`)],
    };
    // declared: title as object (jsonb) instead of string (text)
    const retyped: Entity[] = [
      {
        name: 'Task',
        fields: [
          { name: 'title', type: 'object' },
          { name: 'status', type: 'enum', values: ['draft', 'published'] },
        ],
      },
    ];
    const executor = fakeExecutor(fixture);
    const diff = await diffSchema(executor, retyped);
    expect(diff.columnsToRetype).toEqual([
      { table: 'tasks', column: 'title', from: 'text', to: 'jsonb' },
    ]);
    expect(diffHasDestructive(diff)).toBe(true);
  });

  it('reports junction tables to create and drop', async () => {
    const withJunction: Entity[] = [
      { name: 'Post', fields: [{ name: 'title', type: 'string' }, { name: 'tags', type: 'relation', relation: { entity: 'Tag', cardinality: 'many-to-many' } }] },
      { name: 'Tag', fields: [{ name: 'label', type: 'string' }] },
    ];
    const executor = fakeExecutor({ tables: ['posts', 'tags', 'posts_tags'], columns: [], checks: [] });
    const diff = await diffSchema(executor, withJunction);
    expect(diff.junctionsToCreate).toEqual([]);
    expect(diff.junctionsToDrop).toEqual([]);

    const executor2 = fakeExecutor({ tables: ['posts', 'tags'], columns: [], checks: [] });
    const diff2 = await diffSchema(executor2, withJunction);
    expect(diff2.junctionsToCreate).toEqual(['posts_tags']);

    const executor3 = fakeExecutor({ tables: ['posts', 'tags', 'posts_tags'], columns: [], checks: [] });
    const diff3 = await diffSchema(executor3, withJunction.slice(1));
    expect(diff3.junctionsToDrop).toEqual(['posts_tags']);
    expect(diffHasDestructive(diff3)).toBe(true);
  });
});

describe('applySchemaEvolution', () => {
  it('auto-applies ADD COLUMN and CHECK widening, issuing no destructive SQL', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const executor = fakeExecutor(V1_FIXTURE);
    const report = await applySchemaEvolution(executor, V2_ADD, {}, gate);
    expect(report.refused).toEqual([]);
    expect(report.applied).toEqual([
      'ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "minutes" double precision',
      'ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_status_chk"',
      `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_chk" CHECK ("status" IN ('draft', 'published', 'archived'))`,
    ]);
  });

  it('adds a brand-new CHECK constraint when the enum column predates the check', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const fixture: Fixture = {
      tables: ['tasks'],
      columns: [...BASE_COLS, textCol('tasks', 'title'), textCol('tasks', 'status')],
      checks: [],
    };
    const executor = fakeExecutor(fixture);
    const report = await applySchemaEvolution(executor, V1, {}, gate);
    expect(report.applied).toEqual([
      `ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_chk" CHECK ("status" IN ('draft', 'published'))`,
    ]);
  });

  it('adds a new table via CREATE TABLE IF NOT EXISTS', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const executor = fakeExecutor({ tables: [], columns: [], checks: [] });
    const report = await applySchemaEvolution(executor, V1, {}, gate);
    expect(report.applied).toEqual(generateSchemaDdl(V1));
  });

  it('refuses a column drop by default with a human-readable reason', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const executor = fakeExecutor(V1_FIXTURE);
    const report = await applySchemaEvolution(executor, V2_DROP, {}, gate);
    expect(report.applied).toEqual([]);
    expect(report.refused).toEqual([
      {
        change: 'drop column: tasks.status',
        reason: 'destructive: requires policy.destructive=true and PG_MIGRATE_DESTRUCTIVE=apply',
      },
    ]);
  });

  it('refuses a retype by default', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const retyped: Entity[] = [
      { name: 'Task', fields: [{ name: 'title', type: 'object' }] },
    ];
    const executor = fakeExecutor({
      tables: ['tasks'],
      columns: [...BASE_COLS, textCol('tasks', 'title')],
      checks: [],
    });
    const report = await applySchemaEvolution(executor, retyped, {}, gate);
    expect(report.applied).toEqual([]);
    expect(report.refused.map((r) => r.change)).toEqual(['retype column: tasks.title (text → jsonb)']);
  });

  it('applies a column drop when policy.destructive and PG_MIGRATE_DESTRUCTIVE=apply', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: true };
    const executor = fakeExecutor(V1_FIXTURE);
    const report = await applySchemaEvolution(executor, V2_DROP, { destructive: true }, gate);
    expect(report.applied).toContain('ALTER TABLE "tasks" DROP COLUMN IF EXISTS "status"');
    expect(report.refused).toEqual([]);
  });

  it('still refuses destructive changes when the env opt-in is missing, even with policy.destructive', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const executor = fakeExecutor(V1_FIXTURE);
    const report = await applySchemaEvolution(executor, V2_DROP, { destructive: true }, gate);
    expect(report.applied).toEqual([]);
    expect(report.refused).toHaveLength(1);
  });

  it('throws in production when destructive changes are present without the env opt-in', async () => {
    const gate: EvolutionGate = { production: true, destructiveOptIn: false };
    const executor = fakeExecutor(V1_FIXTURE);
    await expect(applySchemaEvolution(executor, V2_DROP, { destructive: true }, gate)).rejects.toThrow(
      /destructive schema evolution refused in production.*drop column tasks\.status/,
    );
  });

  it('full sequence: fresh create → evolve-add → evolve-drop(refused) on one fixture', async () => {
    const gate: EvolutionGate = { production: false, destructiveOptIn: false };
    const executor = fakeExecutor({ tables: [], columns: [], checks: [] });
    const createReport = await applySchemaEvolution(executor, V1, {}, gate);
    expect(createReport.applied).toEqual(generateSchemaDdl(V1));
    expect(createReport.refused).toEqual([]);

    // Simulate the database now holding V1.
    const evolved: Fixture = {
      tables: ['tasks'],
      columns: [...BASE_COLS, textCol('tasks', 'title'), textCol('tasks', 'status')],
      checks: [checkRow('tasks', 'tasks_status_chk', `(("status")::text = ANY (ARRAY['draft'::text, 'published'::text]))`)],
    };
    const executor2 = fakeExecutor(evolved);
    const addReport = await applySchemaEvolution(executor2, V2_ADD, {}, gate);
    expect(addReport.refused).toEqual([]);
    expect(
      addReport.applied.some((s) => s.includes('ADD COLUMN IF NOT EXISTS "minutes"')),
    ).toBe(true);

    const dropReport = await applySchemaEvolution(executor2, V2_DROP, {}, gate);
    expect(dropReport.refused.map((r) => r.change)).toEqual(['drop column: tasks.status']);
  });
});
