import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  BUILD_INPUTS_LOCK_FILE,
  SIDECAR_LOCK_FILE,
  SidecarLockSchema,
  readBehaviorPackage,
  readLockFile,
  ensureLockEntry,
  sidecarCacheDir,
  type SidecarFetch,
  type SidecarLock,
  type SidecarLockEntry,
} from '@almadar/core/behavior-package';

export type { SidecarLock, SidecarLockEntry };

export const SIDECAR_OBJECT_PREFIX = 'sidecars/';
export { SIDECAR_LOCK_FILE, BUILD_INPUTS_LOCK_FILE };

export interface SidecarUploadMeta {
  contentType: string;
  contentEncoding: string;
  downloadToken: string;
}

/** The slice of a storage bucket a push needs; faked in tests. */
export interface SidecarBucket {
  readonly name: string;
  /** The object's download token, `null` when the object does not exist, `undefined` when it has none. */
  head(objectName: string): Promise<string | null | undefined>;
  /** Streams `localPath` gzip-encoded into the object. */
  upload(objectName: string, localPath: string, meta: SidecarUploadMeta): Promise<void>;
  setDownloadToken(objectName: string, token: string): Promise<void>;
}

export interface PushSidecarOptions {
  bucket?: SidecarBucket;
  log?: (message: string) => void;
}

const defaultLog = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

export function storageBucket(name = process.env['FIREBASE_STORAGE_BUCKET']): SidecarBucket {
  if (!name) {
    throw new Error('FIREBASE_STORAGE_BUCKET is not set: the sidecar store bucket must be named explicitly');
  }
  // Loaded on first use: pulling a sidecar is a plain download and must run without Firebase.
  const storage = async () => (await import('../firebase/index.js')).getStorage().bucket(name);
  return {
    name,
    async head(objectName) {
      const file = (await storage()).file(objectName);
      const [exists] = await file.exists();
      if (!exists) return null;
      const [metadata] = await file.getMetadata();
      const token = metadata.metadata?.['firebaseStorageDownloadTokens'];
      return typeof token === 'string' && token.length > 0 ? token : undefined;
    },
    async upload(objectName, localPath, meta) {
      const file = (await storage()).file(objectName);
      await pipeline(
        createReadStream(localPath),
        createGzip(),
        file.createWriteStream({
          resumable: false,
          contentType: meta.contentType,
          metadata: {
            contentEncoding: meta.contentEncoding,
            metadata: { firebaseStorageDownloadTokens: meta.downloadToken },
          },
        }),
      );
    },
    async setDownloadToken(objectName, token) {
      await (await storage()).file(objectName).setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
    },
  };
}

export function downloadUrl(bucketName: string, objectName: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectName)}?alt=media&token=${token}`;
}

export async function hashFile(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    bytes += buffer.byteLength;
  }
  return { sha256: hash.digest('hex'), bytes };
}

export async function pushSidecar(filePath: string, options: PushSidecarOptions = {}): Promise<SidecarLockEntry> {
  const log = options.log ?? defaultLog;
  const bucket = options.bucket ?? storageBucket();
  const { sha256, bytes } = await hashFile(filePath);
  const objectName = `${SIDECAR_OBJECT_PREFIX}${sha256}`;
  let token = await bucket.head(objectName);
  if (token === null) {
    token = randomUUID();
    await bucket.upload(objectName, filePath, { contentType: 'application/json', contentEncoding: 'gzip', downloadToken: token });
    log(`[sidecars] uploaded ${sha256} (${bytes} bytes) to ${bucket.name}`);
  } else {
    if (token === undefined) {
      token = randomUUID();
      await bucket.setDownloadToken(objectName, token);
    }
    log(`[sidecars] reused ${sha256} (${bytes} bytes) in ${bucket.name}`);
  }
  return { sha256, bytes, url: downloadUrl(bucket.name, objectName, token) };
}

export function writeSidecarLock(
  pkgRoot: string,
  entries: Readonly<Record<string, SidecarLockEntry>>,
  lockFile: string = SIDECAR_LOCK_FILE,
): SidecarLock {
  const files: SidecarLock['files'] = {};
  for (const relPath of Object.keys(entries).sort()) {
    const { sha256, bytes, url } = entries[relPath];
    files[relPath] = { sha256, bytes, url };
  }
  const lock = SidecarLockSchema.parse({ version: 1, files });
  writeFileSync(join(pkgRoot, lockFile), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

export function readSidecarLockFile(pkgRoot: string, lockFile: string = SIDECAR_LOCK_FILE): SidecarLock | null {
  return readLockFile(pkgRoot, lockFile);
}

export async function seedSidecarCache(filePath: string, sha256: string, cacheDir = sidecarCacheDir()): Promise<string> {
  const actual = await hashFile(filePath);
  if (actual.sha256 !== sha256) {
    throw new Error(`seedSidecarCache: ${filePath} has sha256 ${actual.sha256}, expected ${sha256}`);
  }
  mkdirSync(cacheDir, { recursive: true });
  const target = join(cacheDir, sha256);
  if (existsSync(target) && statSync(target).size === actual.bytes) return target;
  const temp = `${target}.${process.pid}.tmp`;
  copyFileSync(filePath, temp);
  renameSync(temp, target);
  return target;
}

export interface PullOptions {
  cacheDir?: string;
  fetch?: SidecarFetch;
  /** Which lock to resolve; default `sidecars.lock.json`. */
  lockFile?: string;
}

/** Resolves every lock entry of the package into the cache; throws naming each failure. */
export async function pullPackageSidecars(pkgRoot: string, options: PullOptions = {}): Promise<string[]> {
  const pkg = readBehaviorPackage(resolve(pkgRoot));
  const files = readLockFile(pkg.root, options.lockFile ?? SIDECAR_LOCK_FILE)?.files ?? {};
  const paths = Object.keys(files).sort();
  const failures: string[] = [];
  const resolved: string[] = [];
  for (const relPath of paths) {
    try {
      resolved.push(await ensureLockEntry(pkg, relPath, files[relPath], options));
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`sidecars pull failed for ${failures.length} of ${paths.length} entr${paths.length === 1 ? 'y' : 'ies'}:\n${failures.join('\n')}`);
  }
  return resolved;
}

export interface PushPackageOptions extends PushSidecarOptions {
  cacheDir?: string;
  /** Which lock to record into; default `sidecars.lock.json`. */
  lockFile?: string;
}

/** A store-resident sidecar: its declared (lock) path and the generated file whose bytes it carries, both package-relative. */
export interface SidecarPushItem {
  lockPath: string;
  sourcePath: string;
}

/** Pushes each source file, seeds the cache, and records it under its lock path in the package lock. */
export async function pushPackageSidecars(
  pkgRoot: string,
  items: readonly SidecarPushItem[],
  options: PushPackageOptions = {},
): Promise<SidecarLock> {
  const root = resolve(pkgRoot);
  const lockFile = options.lockFile ?? SIDECAR_LOCK_FILE;
  const entries: Record<string, SidecarLockEntry> = { ...(readSidecarLockFile(root, lockFile)?.files ?? {}) };
  for (const { lockPath, sourcePath } of items) {
    const filePath = join(root, sourcePath);
    const entry = await pushSidecar(filePath, options);
    await seedSidecarCache(filePath, entry.sha256, options.cacheDir);
    entries[lockPath] = entry;
  }
  return writeSidecarLock(root, entries, lockFile);
}

/** Pushes build-input files into `build-inputs.lock.json` (lock path == source path, package-relative). */
export function pushBuildInputs(pkgRoot: string, paths: readonly string[], options: PushPackageOptions = {}): Promise<SidecarLock> {
  return pushPackageSidecars(
    pkgRoot,
    paths.map((path) => ({ lockPath: path, sourcePath: path })),
    { ...options, lockFile: BUILD_INPUTS_LOCK_FILE },
  );
}

function packageTarget(root: string, relPath: string): string {
  const target = resolve(root, relPath);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`build input "${relPath}" points outside the package`);
  }
  return target;
}

/**
 * Restores every `build-inputs.lock.json` entry into its package path: resolves all entries into the cache
 * first (any failure aborts before a file is written), then copies each atomically, skipping files that
 * already carry the right sha256. Returns the package paths it wrote.
 */
export async function materializeBuildInputs(pkgRoot: string, options: Omit<PullOptions, 'lockFile'> = {}): Promise<string[]> {
  const pkg = readBehaviorPackage(resolve(pkgRoot));
  const files = readLockFile(pkg.root, BUILD_INPUTS_LOCK_FILE)?.files ?? {};
  const paths = Object.keys(files).sort();
  const cached = new Map<string, string>();
  const failures: string[] = [];
  for (const relPath of paths) {
    try {
      packageTarget(pkg.root, relPath);
      const cacheFile = await ensureLockEntry(pkg, relPath, files[relPath], options);
      const actual = await hashFile(cacheFile);
      if (actual.sha256 !== files[relPath].sha256) {
        throw new Error(`ORB_SIDECAR_HASH_MISMATCH: ${pkg.name}@${pkg.version} ${relPath} — cache file has sha256 ${actual.sha256}, expected ${files[relPath].sha256}`);
      }
      cached.set(relPath, cacheFile);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`build-inputs pull failed for ${failures.length} of ${paths.length} entr${paths.length === 1 ? 'y' : 'ies'}:\n${failures.join('\n')}`);
  }
  const written: string[] = [];
  for (const [relPath, cacheFile] of cached) {
    const target = packageTarget(pkg.root, relPath);
    if (existsSync(target) && (await hashFile(target)).sha256 === files[relPath].sha256) continue;
    mkdirSync(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    copyFileSync(cacheFile, temp);
    renameSync(temp, target);
    written.push(relPath);
  }
  return written;
}
