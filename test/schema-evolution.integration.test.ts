/**
 * Schema-evolution integration tests against a real PostgreSQL — skipped unless
 * TEST_DATABASE_URL is set (e.g. TEST_DATABASE_URL=postgres://localhost:5432/test).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { Pool } from 'pg';
import type { Entity } from '@almadar/core';
import { ensureSchema } from '../src/postgres/schema/ddl.js';
import { diffSchema, diffHasDestructive, applySchemaEvolution, type EvolutionGate } from '../src/postgres/schema/evolution.js';

const connectionString = process.env.TEST_DATABASE_URL;
const gate: EvolutionGate = { production: false, destructiveOptIn: false };

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

describe.skipIf(!connectionString)('schema evolution integration (TEST_DATABASE_URL)', () => {
  const pool = new Pool({ connectionString });

  afterAll(async () => {
    if (!connectionString) return;
    await pool.query('DROP TABLE IF EXISTS tasks CASCADE');
    await pool.end();
  });

  it('fresh create → evolve-add applies additively → evolve-drop is refused by default', async () => {
    await pool.query('DROP TABLE IF EXISTS tasks CASCADE');
    await ensureSchema(pool, V1);

    const noOp = await diffSchema(pool, V1);
    expect(diffHasDestructive(noOp)).toBe(false);
    expect(noOp.columnsToAdd).toEqual([]);
    expect(noOp.tablesToCreate).toEqual([]);

    // Insert a row so destructive refusal is observable against live data.
    await pool.query(`INSERT INTO tasks (id, title, status) VALUES ('t1', 'hello', 'draft')`);

    const addDiff = await diffSchema(pool, V2_ADD);
    expect(addDiff.columnsToAdd.map((c) => c.column)).toEqual(['minutes']);
    expect(addDiff.checksToAdd).toHaveLength(1);
    expect(addDiff.checksToAdd[0].kind).toBe('widen');

    const addReport = await applySchemaEvolution(pool, V2_ADD, {}, gate);
    expect(addReport.refused).toEqual([]);
    await pool.query(`UPDATE tasks SET minutes = 30 WHERE id = 't1'`);

    // Evolve down: column drop + CHECK narrowing are destructive → refused by default.
    const dropReport = await applySchemaEvolution(pool, V1, {}, gate);
    expect(dropReport.applied).toEqual([]);
    expect(dropReport.refused.length).toBeGreaterThan(0);
    const stillThere = await pool.query(
      `SELECT minutes FROM tasks WHERE id = 't1'`,
    );
    expect(stillThere.rows[0].minutes).toBe(30);

    // Narrowing an enum with an existing row outside the new set stays refused.
    const narrowReport = await applySchemaEvolution(
      pool,
      [{ name: 'Task', fields: [{ name: 'title', type: 'string' }, { name: 'status', type: 'enum', values: ['draft'] }] }],
      { destructive: true },
      gate,
    );
    expect(narrowReport.refused.some((r) => r.change.includes('tasks_status_chk'))).toBe(true);
    const statusRow = await pool.query(`SELECT status FROM tasks WHERE id = 't1'`);
    expect(statusRow.rows[0].status).toBe('draft');
  });
});
