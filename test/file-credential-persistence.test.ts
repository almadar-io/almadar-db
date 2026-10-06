import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialPersistence, CREDENTIALS_FILE_ENV } from '../src/credentials/file-credential-persistence.js';

describe('FileCredentialPersistence', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'almadar-db-cred-'));
    path = join(dir, 'dev-credentials.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rows survive a reload and writes leave no tmp file behind', async () => {
    const first = new FileCredentialPersistence(path);
    const { id } = await first.create('Cred', { service: 'stripe', ciphertext: 'abc' });
    const reloaded = new FileCredentialPersistence(path);
    expect(await reloaded.list('Cred')).toEqual([{ service: 'stripe', ciphertext: 'abc', id }]);
    expect(readdirSync(dir)).toEqual(['dev-credentials.json']);
  });

  it('update merges into the stored row and keeps its id; control: an unknown id is a no-op', async () => {
    const store = new FileCredentialPersistence(path);
    const { id } = await store.create('Cred', { service: 'stripe', ciphertext: 'abc' });
    await store.update('Cred', id, { ciphertext: 'def' });
    await store.update('Cred', 'missing', { ciphertext: 'zzz' });
    expect(await store.list('Cred')).toEqual([{ service: 'stripe', ciphertext: 'def', id }]);
  });

  it('delete removes the row; control: deleting an unknown id leaves the file as it was', async () => {
    const store = new FileCredentialPersistence(path);
    const { id } = await store.create('Cred', { service: 'stripe' });
    await store.delete('Cred', 'missing');
    expect(await store.list('Cred')).toHaveLength(1);
    await store.delete('Cred', id);
    expect(await store.list('Cred')).toEqual([]);
  });

  it('a corrupt file degrades to empty and the next write recovers it', async () => {
    writeFileSync(path, 'not-json', 'utf-8');
    const store = new FileCredentialPersistence(path);
    expect(await store.list('Cred')).toEqual([]);
    await store.create('Cred', { service: 'stripe' });
    expect(await store.list('Cred')).toHaveLength(1);
  });

  it('takes its path from ALMADAR_CREDENTIALS_FILE when none is passed', () => {
    const saved = process.env[CREDENTIALS_FILE_ENV];
    process.env[CREDENTIALS_FILE_ENV] = path;
    try {
      expect(new FileCredentialPersistence().filePath).toBe(path);
    } finally {
      if (saved === undefined) delete process.env[CREDENTIALS_FILE_ENV];
      else process.env[CREDENTIALS_FILE_ENV] = saved;
    }
  });
});
