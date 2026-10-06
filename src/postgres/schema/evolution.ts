/**
 * Schema evolution for the Postgres adapter: diff the declared Entity[] schema
 * against information_schema and apply the delta under an explicit policy.
 * Additive changes (new table/column/CHECK-widen/junction/FK) apply
 * automatically; destructive changes (drop column, retype, CHECK-narrow,
 * junction drop) apply only when BOTH the caller opts in via
 * `policy.destructive` AND the host sets PG_MIGRATE_DESTRUCTIVE=apply.
 * In production, destructive changes without that explicit env opt-in
 * fail closed: an error is logged and an exception is thrown.
 */
import { createLogger } from '@almadar/logger';
import type { Entity } from '@almadar/core';
import { quoteIdent } from '../rows.js';
import {
  escapeLiteral,
  createTableDdl,
  createJunctionDdl,
  schemaModelFor,
  type SqlExecutor,
  type TableModel,
} from './ddl.js';

const log = createLogger('almadar:server:postgres:evolution');

export interface ColumnDiff {
  table: string;
  column: string;
  /** canonical SQL type currently in the database (null = column absent). */
  from: string | null;
  /** canonical SQL type the declared schema requires (null = column removed). */
  to: string | null;
}

export type CheckDiffKind = 'add' | 'widen' | 'narrow' | 'drop';

export interface CheckDiff {
  table: string;
  constraint: string;
  column: string;
  kind: CheckDiffKind;
  /** full expected value list for add/widen/narrow (constraint is replaced with it). */
  values: string[];
}

export interface SchemaDiff {
  /** tables present in the declared schema but missing from the database. */
  tablesToCreate: string[];
  columnsToAdd: ColumnDiff[];
  columnsToDrop: ColumnDiff[];
  columnsToRetype: ColumnDiff[];
  checksToAdd: CheckDiff[];
  checksToNarrow: CheckDiff[];
  /** orphaned CHECK constraints owned by our naming convention (drop is row-safe). */
  checksToDrop: CheckDiff[];
  junctionsToCreate: string[];
  junctionsToDrop: string[];
}

export function diffHasDestructive(diff: SchemaDiff): boolean {
  return (
    diff.columnsToDrop.length > 0 ||
    diff.columnsToRetype.length > 0 ||
    diff.checksToNarrow.length > 0 ||
    diff.junctionsToDrop.length > 0
  );
}

export interface EvolutionPolicy {
  /** caller opt-in for destructive changes; still gated by PG_MIGRATE_DESTRUCTIVE. */
  destructive?: boolean;
}

export interface RefusedChange {
  change: string;
  reason: string;
}

export interface EvolutionReport {
  /** SQL statements executed, in order. */
  applied: string[];
  /** destructive changes not applied, with a human-readable reason. */
  refused: RefusedChange[];
}

interface InfoTableRow {
  table_name: string;
}

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

function isTableRow(row: object): row is InfoTableRow {
  return 'table_name' in row && typeof row.table_name === 'string';
}

function isColumnRow(row: object): row is InfoColumnRow {
  return (
    isTableRow(row) &&
    'column_name' in row && typeof row.column_name === 'string' &&
    'data_type' in row && typeof row.data_type === 'string' &&
    'numeric_precision' in row && (row.numeric_precision === null || typeof row.numeric_precision === 'number') &&
    'numeric_scale' in row && (row.numeric_scale === null || typeof row.numeric_scale === 'number')
  );
}

function isCheckRow(row: object): row is InfoCheckRow {
  return (
    isTableRow(row) &&
    'constraint_name' in row && typeof row.constraint_name === 'string' &&
    'check_clause' in row && typeof row.check_clause === 'string'
  );
}

function rowsOf<T extends object>(result: { rows?: object[] }, isRow: (row: object) => row is T): T[] {
  return (result.rows ?? []).filter(isRow);
}

// CHECK clause literal extraction: the constraint names are ours (ddl.ts),
// so the clause shape is deterministic — `'a'::text` / `''`-escaped literals.
function parseCheckLiterals(clause: string): string[] {
  const values: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clause)) !== null) {
    values.push(m[1].replace(/''/g, "'"));
  }
  return values;
}

function canonicalFromInfo(row: InfoColumnRow): string {
  switch (row.data_type) {
    case 'text':
      return 'text';
    case 'jsonb':
      return 'jsonb';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'double precision':
      return 'double precision';
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'numeric':
      return `numeric(${row.numeric_precision},${row.numeric_scale})`;
    default:
      return row.data_type;
  }
}

async function queryExistingTables(executor: SqlExecutor, names: string[]): Promise<Set<string>> {
  const result = await executor.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2)',
    ['public', names],
  );
  return new Set(rowsOf(result, isTableRow).map((r) => r.table_name));
}

async function queryPublicTables(executor: SqlExecutor): Promise<Set<string>> {
  const result = await executor.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'",
    ['public'],
  );
  return new Set(rowsOf(result, isTableRow).map((r) => r.table_name));
}

async function queryExistingColumns(executor: SqlExecutor, names: string[]): Promise<InfoColumnRow[]> {
  const result = await executor.query(
    'SELECT table_name, column_name, data_type, numeric_precision, numeric_scale ' +
      'FROM information_schema.columns WHERE table_schema = $1 AND table_name = ANY($2)',
    ['public', names],
  );
  return rowsOf(result, isColumnRow);
}

async function queryExistingChecks(executor: SqlExecutor, names: string[]): Promise<InfoCheckRow[]> {
  const result = await executor.query(
    'SELECT tc.table_name, tc.constraint_name, cc.check_clause ' +
      'FROM information_schema.table_constraints tc ' +
      'JOIN information_schema.check_constraints cc ON cc.constraint_schema = tc.constraint_schema ' +
      'AND cc.constraint_name = tc.constraint_name ' +
      "WHERE tc.table_schema = $1 AND tc.constraint_type = 'CHECK' AND tc.table_name = ANY($2)",
    ['public', names],
  );
  return rowsOf(result, isCheckRow);
}

/** Compare the declared schema against information_schema for the tables tableNameFor produces. */
export async function diffSchema(executor: SqlExecutor, entities: Entity[]): Promise<SchemaDiff> {
  const model = schemaModelFor(entities);
  const diff: SchemaDiff = {
    tablesToCreate: [],
    columnsToAdd: [],
    columnsToDrop: [],
    columnsToRetype: [],
    checksToAdd: [],
    checksToNarrow: [],
    checksToDrop: [],
    junctionsToCreate: [],
    junctionsToDrop: [],
  };

  const expectedTableNames = model.tables.map((t) => t.table);
  const expectedJunctionNames = model.junctions.map((j) => j.table);
  const allNames = [...expectedTableNames, ...expectedJunctionNames];
  const existing = await queryExistingTables(executor, allNames);

  const existingTableModels = model.tables.filter((t) => existing.has(t.table));
  diff.tablesToCreate = expectedTableNames.filter((t) => !existing.has(t));
  diff.junctionsToCreate = expectedJunctionNames.filter((t) => !existing.has(t));

  // Orphaned junction tables: any public table named exactly <left>_<right>
  // where at least one half is a declared table name and the table is no
  // longer in the model. (A false positive here is a destructive, refused-
  // by-default DROP TABLE entry in the report — visible, never silent.)
  const expectedNames = new Set(allNames);
  const knownNames = new Set(expectedTableNames);
  const publicTables = await queryPublicTables(executor);
  for (const name of publicTables) {
    if (expectedNames.has(name) || !name.includes('_')) continue;
    const splitAt = name.indexOf('_');
    const left = name.slice(0, splitAt);
    const right = name.slice(splitAt + 1);
    if (knownNames.has(left) || knownNames.has(right)) {
      diff.junctionsToDrop.push(name);
    }
  }

  // Columns for existing tables.
  const existingColumns = await queryExistingColumns(
    executor,
    existingTableModels.map((t) => t.table),
  );
  const columnsByTable = new Map<string, Map<string, string>>();
  for (const row of existingColumns) {
    let map = columnsByTable.get(row.table_name);
    if (!map) {
      map = new Map();
      columnsByTable.set(row.table_name, map);
    }
    map.set(row.column_name, canonicalFromInfo(row));
  }
  for (const table of existingTableModels) {
    const existingCols = columnsByTable.get(table.table) ?? new Map<string, string>();
    for (const column of table.columns) {
      const current = existingCols.get(column.name);
      if (current === undefined) {
        diff.columnsToAdd.push({ table: table.table, column: column.name, from: null, to: column.sqlType });
      } else if (current !== column.sqlType) {
        diff.columnsToRetype.push({ table: table.table, column: column.name, from: current, to: column.sqlType });
      }
    }
    for (const [name, type] of existingCols) {
      if (!table.columns.some((c) => c.name === name)) {
        diff.columnsToDrop.push({ table: table.table, column: name, from: type, to: null });
      }
    }
  }

  // CHECK constraints for existing tables.
  const existingChecks = await queryExistingChecks(
    executor,
    existingTableModels.map((t) => t.table),
  );
  const checksByName = new Map<string, InfoCheckRow>();
  for (const row of existingChecks) checksByName.set(`${row.table_name}.${row.constraint_name}`, row);

  const expectedCheckNames = new Set<string>();
  for (const table of existingTableModels) {
    for (const check of table.checks) {
      expectedCheckNames.add(`${table.table}.${check.constraint}`);
      const row = checksByName.get(`${table.table}.${check.constraint}`);
      if (!row) {
        diff.checksToAdd.push({
          table: table.table,
          constraint: check.constraint,
          column: check.column,
          kind: 'add',
          values: check.values,
        });
        continue;
      }
      const currentValues = parseCheckLiterals(row.check_clause);
      const currentSet = new Set(currentValues);
      const expectedSet = new Set(check.values);
      const gained = check.values.filter((v) => !currentSet.has(v));
      const lost = currentValues.filter((v) => !expectedSet.has(v));
      if (lost.length > 0) {
        diff.checksToNarrow.push({
          table: table.table,
          constraint: check.constraint,
          column: check.column,
          kind: 'narrow',
          values: check.values,
        });
      } else if (gained.length > 0) {
        diff.checksToAdd.push({
          table: table.table,
          constraint: check.constraint,
          column: check.column,
          kind: 'widen',
          values: check.values,
        });
      }
    }
  }

  // Orphaned CHECK constraints under our `<table>_<column>_chk` naming, on
  // declared tables, whose constraint the schema no longer declares (e.g.
  // enum field retyped). Dropping a CHECK is row-safe, so this is additive.
  for (const row of existingChecks) {
    const key = `${row.table_name}.${row.constraint_name}`;
    if (expectedCheckNames.has(key)) continue;
    if (!row.constraint_name.endsWith('_chk')) continue;
    const column = row.constraint_name.slice(row.table_name.length + 1, -'_chk'.length);
    const table = model.tables.find((t) => t.table === row.table_name);
    if (!table || !table.columns.some((c) => c.name === column)) continue;
    diff.checksToDrop.push({ table: row.table_name, constraint: row.constraint_name, column, kind: 'drop', values: [] });
  }

  return diff;
}

function addColumnSql(diff: ColumnDiff, table: TableModel | undefined): string {
  const column = table?.columns.find((c) => c.name === diff.column);
  if (column?.fk) {
    return (
      `ALTER TABLE ${quoteIdent(diff.table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(diff.column)} text ` +
      `REFERENCES ${quoteIdent(column.fk.table)}(${quoteIdent(column.fk.column)})${column.fk.onDelete}`
    );
  }
  return `ALTER TABLE ${quoteIdent(diff.table)} ADD COLUMN IF NOT EXISTS ${quoteIdent(diff.column)} ${diff.to ?? 'text'}`;
}

function dropColumnSql(diff: ColumnDiff): string {
  return `ALTER TABLE ${quoteIdent(diff.table)} DROP COLUMN IF EXISTS ${quoteIdent(diff.column)}`;
}

function retypeColumnSql(diff: ColumnDiff): string {
  return `ALTER TABLE ${quoteIdent(diff.table)} ALTER COLUMN ${quoteIdent(diff.column)} TYPE ${diff.to ?? 'text'}`;
}

function addCheckSql(check: CheckDiff): string {
  const values = check.values.map(escapeLiteral).join(', ');
  return (
    `ALTER TABLE ${quoteIdent(check.table)} ADD CONSTRAINT ${quoteIdent(check.constraint)} ` +
    `CHECK (${quoteIdent(check.column)} IN (${values}))`
  );
}

function replaceCheckSql(check: CheckDiff): string[] {
  return [
    `ALTER TABLE ${quoteIdent(check.table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(check.constraint)}`,
    addCheckSql(check),
  ];
}

function dropCheckSql(check: CheckDiff): string {
  return `ALTER TABLE ${quoteIdent(check.table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(check.constraint)}`;
}

function describeChange(kind: string, sql: string): string {
  return `${kind}: ${sql}`;
}

/** The host's declared environment: whether it is production and whether the operator opted in to destructive changes. */
export interface EvolutionGate {
  production: boolean;
  destructiveOptIn: boolean;
}

/**
 * Apply a schema diff. Additive changes are always applied (idempotently
 * where PG supports it). Destructive changes are applied only when
 * `policy.destructive` is true AND `gate.destructiveOptIn` (PG_MIGRATE_DESTRUCTIVE=apply in the server); otherwise
 * they land in `report.refused`. In production, destructive changes present
 * without the explicit env opt-in log an error and throw.
 */
export async function applySchemaEvolution(
  executor: SqlExecutor,
  entities: Entity[],
  policy: EvolutionPolicy,
  gate: EvolutionGate,
): Promise<EvolutionReport> {
  const diff = await diffSchema(executor, entities);
  const model = schemaModelFor(entities);
  const report: EvolutionReport = { applied: [], refused: [] };

  const destructive = diffHasDestructive(diff);
  const destructiveDescriptions = [
    ...diff.columnsToDrop.map((c) => `drop column ${c.table}.${c.column}`),
    ...diff.columnsToRetype.map((c) => `retype column ${c.table}.${c.column} (${c.from} → ${c.to})`),
    ...diff.checksToNarrow.map((c) => `narrow CHECK ${c.constraint} on ${c.table}`),
    ...diff.junctionsToDrop.map((t) => `drop junction table ${t}`),
  ];

  const envOptIn = gate.destructiveOptIn;
  if (destructive && gate.production && !envOptIn) {
    log.error('Refusing destructive schema evolution in production without PG_MIGRATE_DESTRUCTIVE=apply', {
      refused: destructiveDescriptions,
      fix: 'set PG_MIGRATE_DESTRUCTIVE=apply to opt in explicitly, or resolve the schema drift additively',
    });
    throw new Error(
      '@almadar/db: destructive schema evolution refused in production (PG_MIGRATE_DESTRUCTIVE not set to apply): ' +
        destructiveDescriptions.join('; '),
    );
  }
  const destructiveAllowed = destructive && policy.destructive === true && envOptIn;

  const run = async (sql: string): Promise<void> => {
    await executor.query(sql);
    report.applied.push(sql);
  };

  for (const table of diff.tablesToCreate) {
    const model2 = model.tables.find((t) => t.table === table);
    if (model2) await run(createTableDdl(model2));
  }
  for (const junction of diff.junctionsToCreate) {
    const j = model.junctions.find((x) => x.table === junction);
    if (j) await run(createJunctionDdl(j));
  }
  for (const check of diff.checksToDrop) {
    await run(dropCheckSql(check));
  }
  for (const column of diff.columnsToAdd) {
    await run(addColumnSql(column, model.tables.find((t) => t.table === column.table)));
  }
  for (const check of diff.checksToAdd) {
    if (check.kind === 'add') {
      await run(addCheckSql(check));
    } else {
      for (const sql of replaceCheckSql(check)) await run(sql);
    }
  }

  for (const column of diff.columnsToDrop) {
    if (destructiveAllowed) {
      await run(dropColumnSql(column));
    } else {
      report.refused.push({
        change: describeChange('drop column', `${column.table}.${column.column}`),
        reason: 'destructive: requires policy.destructive=true and PG_MIGRATE_DESTRUCTIVE=apply',
      });
    }
  }
  for (const column of diff.columnsToRetype) {
    if (destructiveAllowed) {
      await run(retypeColumnSql(column));
    } else {
      report.refused.push({
        change: describeChange('retype column', `${column.table}.${column.column} (${column.from} → ${column.to})`),
        reason: 'destructive: requires policy.destructive=true and PG_MIGRATE_DESTRUCTIVE=apply',
      });
    }
  }
  for (const check of diff.checksToNarrow) {
    if (destructiveAllowed) {
      for (const sql of replaceCheckSql(check)) await run(sql);
    } else {
      report.refused.push({
        change: describeChange('narrow CHECK', `${check.constraint} on ${check.table}`),
        reason:
          'destructive: narrowing a CHECK can invalidate existing rows; requires policy.destructive=true and PG_MIGRATE_DESTRUCTIVE=apply',
      });
    }
  }
  for (const junction of diff.junctionsToDrop) {
    if (destructiveAllowed) {
      await run(`DROP TABLE IF EXISTS ${quoteIdent(junction)}`);
    } else {
      report.refused.push({
        change: describeChange('drop junction table', junction),
        reason: 'destructive: requires policy.destructive=true and PG_MIGRATE_DESTRUCTIVE=apply',
      });
    }
  }

  return report;
}
