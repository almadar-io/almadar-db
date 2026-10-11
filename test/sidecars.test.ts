import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SidecarLockSchema } from '@almadar/core/behavior-package';
import {
  materializeBuildInputs,
  pushBuildInputs,
  pullPackageSidecars,
  pushPackageSidecars,
  pushSidecar,
  seedSidecarCache,
  writeSidecarLock,
  type SidecarBucket,
  type SidecarUploadMeta,
} from '../src/sidecars/index';

interface Upload {
  objectName: string;
  localPath: string;
  meta: SidecarUploadMeta;
}

class FakeBucket implements SidecarBucket {
  readonly name = 'test-bucket';
  readonly uploads: Upload[] = [];
  readonly tokens = new Map<string, string | undefined>();
  async head(objectName: string): Promise<string | null | undefined> {
    return this.tokens.has(objectName) ? this.tokens.get(objectName) : null;
  }
  async upload(objectName: string, localPath: string, meta: SidecarUploadMeta): Promise<void> {
    this.uploads.push({ objectName, localPath, meta });
    this.tokens.set(objectName, meta.downloadToken);
  }
  async setDownloadToken(objectName: string, token: string): Promise<void> {
    this.tokens.set(objectName, token);
  }
}

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sidecars-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, text: string): string {
  const path = join(dir, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('pushSidecar', () => {
  it('uploads a new object gzip-encoded with a download token and returns a capability url', async () => {
    const bucket = new FakeBucket();
    const file = writeFile('a.json', '{"a":1}');
    const entry = await pushSidecar(file, { bucket, log: () => {} });
    expect(entry.sha256).toBe(sha('{"a":1}'));
    expect(entry.bytes).toBe(7);
    expect(bucket.uploads).toHaveLength(1);
    const [upload] = bucket.uploads;
    expect(upload.objectName).toBe(`sidecars/${entry.sha256}`);
    expect(upload.meta.contentEncoding).toBe('gzip');
    expect(upload.meta.contentType).toBe('application/json');
    expect(entry.url).toBe(
      `https://firebasestorage.googleapis.com/v0/b/test-bucket/o/${encodeURIComponent(`sidecars/${entry.sha256}`)}?alt=media&token=${upload.meta.downloadToken}`,
    );
  });

  it('is idempotent: an existing object is reused without an upload and keeps its token', async () => {
    const bucket = new FakeBucket();
    const file = writeFile('a.json', '{"a":1}');
    bucket.tokens.set(`sidecars/${sha('{"a":1}')}`, 'existing-token');
    const entry = await pushSidecar(file, { bucket, log: () => {} });
    expect(bucket.uploads).toHaveLength(0);
    expect(entry.url).toContain('token=existing-token');
  });

  it('mints a token for an existing object that has none', async () => {
    const bucket = new FakeBucket();
    const file = writeFile('a.json', '{"a":1}');
    bucket.tokens.set(`sidecars/${sha('{"a":1}')}`, undefined);
    const entry = await pushSidecar(file, { bucket, log: () => {} });
    expect(bucket.uploads).toHaveLength(0);
    expect(entry.url).toContain(`token=${bucket.tokens.get(`sidecars/${sha('{"a":1}')}`)}`);
  });

  it('never logs the download token or the url', async () => {
    const lines: string[] = [];
    const fresh = new FakeBucket();
    const existing = new FakeBucket();
    existing.tokens.set(`sidecars/${sha('{"a":1}')}`, 'secret-token');
    const file = writeFile('a.json', '{"a":1}');
    const entry = await pushSidecar(file, { bucket: fresh, log: (m) => lines.push(m) });
    await pushSidecar(file, { bucket: existing, log: (m) => lines.push(m) });
    const out = lines.join('\n');
    expect(out).toContain(entry.sha256);
    expect(out).not.toContain('token=');
    expect(out).not.toContain('secret-token');
    expect(out).not.toContain(fresh.uploads[0].meta.downloadToken);
    expect(out).not.toContain('firebasestorage.googleapis.com');
  });
});

describe('writeSidecarLock', () => {
  it('writes sorted keys, 2-space JSON with a trailing newline, schema-valid', () => {
    const e = (text: string) => ({ sha256: sha(text), bytes: text.length, url: `https://h.example/${text}` });
    writeSidecarLock(dir, { 'dist/z.json': e('z'), 'dist/a.json': e('a') });
    const raw = readFileSync(join(dir, 'sidecars.lock.json'), 'utf8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "version": 1');
    const parsed = SidecarLockSchema.parse(JSON.parse(raw));
    expect(Object.keys(parsed.files)).toEqual(['dist/a.json', 'dist/z.json']);
  });

  it('rejects an entry whose sha256 is malformed', () => {
    expect(() => writeSidecarLock(dir, { 'dist/a.json': { sha256: 'nope', bytes: 1, url: 'https://h.example/a' } })).toThrow();
    expect(existsSync(join(dir, 'sidecars.lock.json'))).toBe(false);
  });
});

describe('seedSidecarCache', () => {
  it('copies the file to <cache>/<sha256>', async () => {
    const file = writeFile('a.json', '{"a":1}');
    const cache = join(dir, 'cache');
    const target = await seedSidecarCache(file, sha('{"a":1}'), cache);
    expect(target).toBe(join(cache, sha('{"a":1}')));
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  it('refuses a sha256 that does not match the file', async () => {
    const file = writeFile('a.json', '{"a":1}');
    await expect(seedSidecarCache(file, sha('other'), join(dir, 'cache'))).rejects.toThrow(/expected/);
  });
});

function writePackage(lockFiles: Record<string, { sha256: string; bytes: number; url: string }>): string {
  const root = join(dir, 'pkg');
  mkdirSync(root, { recursive: true });
  const orb = {
    prefix: 'p', registry: 'dist/registry', index: 'dist/index.json', factorySignatures: 'dist/f.json',
    loloContracts: 'dist/c.json', signatures: 'dist/s.json', embeddings: [], compiler: '>=1',
  };
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0', orb }));
  writeSidecarLock(root, lockFiles);
  return root;
}

describe('pushPackageSidecars + pullPackageSidecars', () => {
  it('push writes the lock and seeds the cache so pull resolves with no fetch', async () => {
    const root = writePackage({});
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'k.json'), '{"k":1}');
    const cacheDir = join(dir, 'cache');
    const lock = await pushPackageSidecars(root, [{ lockPath: 'dist/k.json', sourcePath: 'dist/k.json' }], { bucket: new FakeBucket(), cacheDir, log: () => {} });
    expect(Object.keys(lock.files)).toEqual(['dist/k.json']);
    const resolved = await pullPackageSidecars(root, {
      cacheDir,
      fetch: async () => {
        throw new Error('must not fetch');
      },
    });
    expect(resolved).toEqual([join(cacheDir, sha('{"k":1}'))]);
  });

  it('push records the generated source file under its declared lock path (the dist copy need not exist)', async () => {
    const root = writePackage({});
    mkdirSync(join(root, 'behaviors'));
    writeFileSync(join(root, 'behaviors', 'k.json'), '{"k":3}');
    const cacheDir = join(dir, 'cache');
    const lock = await pushPackageSidecars(root, [{ lockPath: 'dist/k.json', sourcePath: 'behaviors/k.json' }], { bucket: new FakeBucket(), cacheDir, log: () => {} });
    expect(lock.files['dist/k.json']?.sha256).toBe(sha('{"k":3}'));
    expect(lock.files['behaviors/k.json']).toBeUndefined();
  });

  it('pull downloads a missing entry into the cache (control)', async () => {
    const body = '{"k":2}';
    const root = writePackage({ 'dist/k.json': { sha256: sha(body), bytes: body.length, url: 'https://h.example/k' } });
    const cacheDir = join(dir, 'cache');
    const resolved = await pullPackageSidecars(root, { cacheDir, fetch: async () => new TextEncoder().encode(body) });
    expect(readFileSync(resolved[0], 'utf8')).toBe(body);
  });

  it('pull fails loudly naming the entry when the fetch fails', async () => {
    const root = writePackage({ 'dist/k.json': { sha256: sha('x'), bytes: 1, url: 'https://h.example/k?token=secret' } });
    const error = await pullPackageSidecars(root, {
      cacheDir: join(dir, 'cache'),
      fetch: async () => {
        throw new Error('HTTP 403');
      },
    }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('ORB_SIDECAR_FETCH_FAILED');
    expect(message).toContain('dist/k.json');
    expect(message).toContain('h.example');
    expect(message).not.toContain('secret');
  });
});

describe('build inputs', () => {
  const entryFor = (body: string, name: string) => ({ sha256: sha(body), bytes: Buffer.byteLength(body), url: `https://h.example/${name}` });

  it('materialize writes each entry to its package path with the lock bytes', async () => {
    const a = '{"a":1}';
    const b = '{"b":22}';
    const root = writePackage({});
    writeSidecarLock(root, { 'behaviors/reg/a.json': entryFor(a, 'a'), 'x.json': entryFor(b, 'b') }, 'build-inputs.lock.json');
    const bodies: Record<string, string> = { 'https://h.example/a': a, 'https://h.example/b': b };
    const written = await materializeBuildInputs(root, { cacheDir: join(dir, 'cache'), fetch: async (url) => new TextEncoder().encode(bodies[url]) });
    expect(written.sort()).toEqual(['behaviors/reg/a.json', 'x.json']);
    expect(readFileSync(join(root, 'behaviors/reg/a.json'), 'utf8')).toBe(a);
    expect(readFileSync(join(root, 'x.json'), 'utf8')).toBe(b);
  });

  it('leaves an existing file with the right hash untouched, replaces a stale one', async () => {
    const body = '{"a":1}';
    const root = writePackage({});
    writeSidecarLock(root, { 'ok.json': entryFor(body, 'a'), 'stale.json': entryFor(body, 'a') }, 'build-inputs.lock.json');
    writeFileSync(join(root, 'ok.json'), body);
    writeFileSync(join(root, 'stale.json'), 'old');
    const written = await materializeBuildInputs(root, { cacheDir: join(dir, 'cache'), fetch: async () => new TextEncoder().encode(body) });
    expect(written).toEqual(['stale.json']);
    expect(readFileSync(join(root, 'stale.json'), 'utf8')).toBe(body);
  });

  it('a hash mismatch fails and writes nothing, not even the good entries', async () => {
    const good = '{"a":1}';
    const root = writePackage({});
    writeSidecarLock(root, { 'good.json': entryFor(good, 'good'), 'bad.json': entryFor('{"b":2}', 'bad') }, 'build-inputs.lock.json');
    const bodies: Record<string, string> = { 'https://h.example/good': good, 'https://h.example/bad': '{"b":3}' };
    const error = await materializeBuildInputs(root, { cacheDir: join(dir, 'cache'), fetch: async (url) => new TextEncoder().encode(bodies[url]) }).catch((e: Error) => e);
    expect((error as Error).message).toContain('ORB_SIDECAR_HASH_MISMATCH');
    expect(existsSync(join(root, 'good.json'))).toBe(false);
    expect(existsSync(join(root, 'bad.json'))).toBe(false);
  });

  it('refuses an entry that points outside the package', async () => {
    const root = writePackage({});
    writeSidecarLock(root, { '../escape.json': entryFor('{}', 'e') }, 'build-inputs.lock.json');
    await expect(materializeBuildInputs(root, { cacheDir: join(dir, 'cache'), fetch: async () => new TextEncoder().encode('{}') })).rejects.toThrow(/outside the package/);
    expect(existsSync(join(dir, 'escape.json'))).toBe(false);
  });

  it('the two lock files never mix: pushing build inputs leaves sidecars.lock.json alone, and pulls read only their own lock', async () => {
    const sidecar = '{"s":1}';
    const root = writePackage({ 'dist/s.json': entryFor(sidecar, 's') });
    const before = readFileSync(join(root, 'sidecars.lock.json'), 'utf8');
    writeFileSync(join(root, 'in.json'), '{"i":1}');
    const cacheDir = join(dir, 'cache');
    const lock = await pushBuildInputs(root, ['in.json'], { bucket: new FakeBucket(), cacheDir, log: () => {} });
    expect(Object.keys(lock.files)).toEqual(['in.json']);
    expect(readFileSync(join(root, 'sidecars.lock.json'), 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(join(root, 'build-inputs.lock.json'), 'utf8')).files['dist/s.json']).toBeUndefined();

    const fetched: string[] = [];
    const fetch = async (url: string) => {
      fetched.push(url);
      return new TextEncoder().encode(sidecar);
    };
    await pullPackageSidecars(root, { cacheDir: join(dir, 'c2'), fetch });
    expect(fetched).toEqual(['https://h.example/s']);
    expect(existsSync(join(root, 'dist/s.json'))).toBe(false);
    await materializeBuildInputs(root, { cacheDir, fetch });
    expect(fetched).toEqual(['https://h.example/s']);
  });

  it('materialize with no build-inputs lock is a no-op (control)', async () => {
    const root = writePackage({});
    expect(await materializeBuildInputs(root, { cacheDir: join(dir, 'cache') })).toEqual([]);
  });
});
