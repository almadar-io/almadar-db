import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const block = join(pkg, 'test', 'fixtures', 'block-firestore.cjs');

function run(script: string, extra: string[] = []): string {
  return execFileSync(process.execPath, ['--import', 'tsx', ...extra, '--input-type=module', '-e', script], {
    cwd: pkg,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// behaviors CI 2026-10-12: `almadar-sidecars pull` crashed on a runner without Firestore — the pull
// path only downloads, so it must not load the Firebase bootstrap.
describe('the sidecar module loads without Firestore', () => {
  it('imports and exposes the pull path when @google-cloud/firestore cannot be resolved', () => {
    const out = run("const m = await import('./src/sidecars/index.ts'); console.log(typeof m.pullPackageSidecars);", ['--require', block]);
    expect(out.trim()).toBe('function');
  });

  it('control: the block really makes Firestore unloadable', () => {
    expect(() => run("await import('firebase-admin/firestore');", ['--require', block])).toThrow(/@google-cloud\/firestore/);
  });
});
