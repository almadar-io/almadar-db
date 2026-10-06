/**
 * DDL generator: Entity (from @almadar/core) → idempotent CREATE TABLE
 * statements, including FK columns and junction tables for relations.
 * The expected-column model (`schemaModelFor`) is shared with
 * `schema/evolution.ts` so the diff can never diverge from the generator.
 */
import type { Entity, EntityField, RelationConfig } from '@almadar/core';
import { snakeNameFor, tableNameFor, quoteIdent } from '../rows.js';

const TEXT_TYPES = new Set(['string', 'email', 'url', 'phone', 'uuid', 'image', 'event', 'trait', 'slot']);
const JSONB_TYPES = new Set(['file', 'pattern', 'node', 'object', 'union', 'array', 'scalar']);

export function columnTypeFor(field: EntityField): string {
  switch (field.type) {
    case 'number':
      return 'double precision';
    case 'money':
      return 'numeric(19,4)';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
    case 'datetime':
      return 'timestamptz';
    case 'enum':
      return 'text';
    default:
      return TEXT_TYPES.has(field.type) ? 'text' : JSONB_TYPES.has(field.type) ? 'jsonb' : 'text';
  }
}

function onDeleteAction(relation: RelationConfig): string {
  switch (relation.onDelete) {
    case 'cascade':
      return ' ON DELETE CASCADE';
    case 'nullify':
      return ' ON DELETE SET NULL';
    case 'restrict':
      return ' ON DELETE RESTRICT';
    default:
      return ' ON DELETE NO ACTION';
  }
}

export function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export interface FkModel {
  table: string;
  column: string;
  onDelete: string;
}

export interface ColumnModel {
  name: string;
  sqlType: string;
  fk?: FkModel;
}

export interface CheckModel {
  constraint: string;
  column: string;
  values: string[];
}

export interface TableModel {
  table: string;
  columns: ColumnModel[];
  checks: CheckModel[];
}

export interface JunctionModel {
  table: string;
  leftTable: string;
  leftCol: string;
  rightTable: string;
  rightCol: string;
}

export interface SchemaModel {
  tables: TableModel[];
  junctions: JunctionModel[];
}

function fkColumnModel(fieldName: string, relation: RelationConfig): ColumnModel {
  return {
    name: fieldName,
    sqlType: 'text',
    fk: {
      table: tableNameFor(relation.entity),
      column: relation.field ?? 'id',
      onDelete: onDeleteAction(relation),
    },
  };
}

function junctionModelFor(entity: Entity, field: EntityField): JunctionModel | null {
  if (field.type !== 'relation') return null;
  const cardinality = field.relation.cardinality ?? 'one';
  if (cardinality !== 'many' && cardinality !== 'many-to-many') return null;
  const left = tableNameFor(entity.name);
  const right = tableNameFor(field.relation.entity);
  return {
    table: `${left}_${right}`,
    leftTable: left,
    leftCol: `${snakeNameFor(entity.name)}_id`,
    rightTable: right,
    rightCol: `${snakeNameFor(field.relation.entity)}_id`,
  };
}

/** Expected structural model for the declared entities — the single source for both DDL generation and schema diffing. */
export function schemaModelFor(entities: Entity[]): SchemaModel {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const tables: TableModel[] = [];
  const junctions: JunctionModel[] = [];

  // Incoming one-to-many relations contribute an FK column on the TARGET table.
  const incomingFk = new Map<string, ColumnModel[]>();
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.type !== 'relation') continue;
      if ((field.relation.cardinality ?? 'one') !== 'one-to-many') continue;
      if (!byName.has(field.relation.entity)) continue;
      const col = fkColumnModel(`${snakeNameFor(entity.name)}_id`, {
        ...field.relation,
        entity: entity.name,
      });
      const list = incomingFk.get(field.relation.entity) ?? [];
      list.push(col);
      incomingFk.set(field.relation.entity, list);
    }
  }

  for (const entity of entities) {
    const table = tableNameFor(entity.name);
    const columns: ColumnModel[] = [
      { name: 'id', sqlType: 'text' },
      { name: 'created_at', sqlType: 'timestamptz' },
      { name: 'updated_at', sqlType: 'timestamptz' },
    ];
    const checks: CheckModel[] = [];

    for (const field of entity.fields) {
      if (!field.name) continue;
      if (field.type === 'relation') {
        const cardinality = field.relation.cardinality ?? 'one';
        if (cardinality === 'one' || cardinality === 'many-to-one') {
          columns.push(fkColumnModel(field.name, field.relation));
        }
        // one-to-many: FK lives on the target table (incomingFk); many/many-to-many: junction table below.
        continue;
      }
      columns.push({ name: field.name, sqlType: columnTypeFor(field) });
      if (field.type === 'enum') {
        checks.push({ constraint: `${table}_${field.name}_chk`, column: field.name, values: field.values });
      }
    }

    columns.push(...(incomingFk.get(entity.name) ?? []));
    tables.push({ table, columns, checks });
  }

  for (const entity of entities) {
    for (const field of entity.fields) {
      const junction = junctionModelFor(entity, field);
      if (junction) junctions.push(junction);
    }
  }

  return { tables, junctions };
}

function columnDefSql(column: ColumnModel): string {
  if (column.fk) {
    const fk = column.fk;
    return `${quoteIdent(column.name)} text REFERENCES ${quoteIdent(fk.table)}(${quoteIdent(fk.column)})${fk.onDelete}`;
  }
  return `${quoteIdent(column.name)} ${column.sqlType}`;
}

function checkSql(table: string, check: CheckModel): string {
  const values = check.values.map(escapeLiteral).join(', ');
  return `CONSTRAINT ${quoteIdent(check.constraint)} CHECK (${quoteIdent(check.column)} IN (${values}))`;
}

export function createTableDdl(table: TableModel): string {
  const columnDefs = [
    `${quoteIdent('id')} text PRIMARY KEY`,
    `${quoteIdent('created_at')} timestamptz NOT NULL DEFAULT now()`,
    `${quoteIdent('updated_at')} timestamptz NOT NULL DEFAULT now()`,
    ...table.columns
      .filter((c) => c.name !== 'id' && c.name !== 'created_at' && c.name !== 'updated_at')
      .map(columnDefSql),
  ];
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(table.table)} (${[...columnDefs, ...table.checks.map((c) => checkSql(table.table, c))].join(', ')})`;
}

export function createJunctionDdl(junction: JunctionModel): string {
  return (
    `CREATE TABLE IF NOT EXISTS ${quoteIdent(junction.table)} (` +
    `${quoteIdent(junction.leftCol)} text NOT NULL REFERENCES ${quoteIdent(junction.leftTable)}(${quoteIdent('id')}), ` +
    `${quoteIdent(junction.rightCol)} text NOT NULL REFERENCES ${quoteIdent(junction.rightTable)}(${quoteIdent('id')}), ` +
    `PRIMARY KEY (${quoteIdent(junction.leftCol)}, ${quoteIdent(junction.rightCol)}))`
  );
}

/** Generate idempotent CREATE TABLE statements for all entities (FKs, junction tables included). */
export function generateSchemaDdl(entities: Entity[]): string[] {
  const model = schemaModelFor(entities);
  return [
    ...model.tables.map(createTableDdl),
    ...model.junctions.map(createJunctionDdl),
  ];
}

/** Minimal structural type so tests and hosts can pass a pg Pool without casts. */
export interface SqlExecutor {
  query(sql: string, params?: (string | string[])[]): Promise<{ rows?: object[] }>;
}

/** Apply the DDL idempotently on boot. */
export async function ensureSchema(pool: SqlExecutor, entities: Entity[]): Promise<void> {
  for (const statement of generateSchemaDdl(entities)) {
    await pool.query(statement);
  }
}
