import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EntityRow, PersistenceAdapter } from '@almadar/core';

/** Env var overriding where the dev credential file lives. */
export const CREDENTIALS_FILE_ENV = 'ALMADAR_CREDENTIALS_FILE';

const DEFAULT_RELATIVE_PATH = join('.almadar', 'dev-credentials.json');

/**
 * File-backed credential persistence for dev store-first mode (I-31): rows
 * survive playground restarts so the encrypt-at-rest path is exercised on
 * every dev run, exactly like a deployed app's Firestore-backed store. Rows
 * arrive already encrypted (ciphertext/iv/authTag) — this adapter never sees
 * plaintext. Writes are atomic (tmp file + rename). Never use in production.
 */
export class FileCredentialPersistence implements Pick<PersistenceAdapter, 'create' | 'update' | 'delete' | 'list'> {
  private readonly path: string;
  private counter = 0;

  constructor(path?: string) {
    this.path =
      path ?? process.env[CREDENTIALS_FILE_ENV] ?? join(process.cwd(), DEFAULT_RELATIVE_PATH);
  }

  get filePath(): string {
    return this.path;
  }

  private load(): Map<string, EntityRow> {
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const rows = JSON.parse(raw) as EntityRow[];
      const map = new Map<string, EntityRow>();
      for (const row of rows) {
        if (typeof row.id === 'string') map.set(row.id, row);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private save(rows: Map<string, EntityRow>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify([...rows.values()], null, 2), 'utf-8');
    renameSync(tmp, this.path);
  }

  async create(entityType: string, data: EntityRow): Promise<{ id: string }> {
    const rows = this.load();
    const id = `${entityType}-${Date.now()}-${++this.counter}`;
    rows.set(id, { ...data, id });
    this.save(rows);
    return { id };
  }

  async update(_entityType: string, id: string, data: EntityRow): Promise<void> {
    const rows = this.load();
    const existing = rows.get(id);
    if (existing) {
      rows.set(id, { ...existing, ...data, id });
      this.save(rows);
    }
  }

  async delete(_entityType: string, id: string): Promise<void> {
    const rows = this.load();
    if (rows.delete(id)) this.save(rows);
  }

  async list(_entityType: string): Promise<EntityRow[]> {
    return [...this.load().values()];
  }
}
