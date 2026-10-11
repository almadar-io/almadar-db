#!/usr/bin/env node
import { materializeBuildInputs, pullPackageSidecars, pushBuildInputs, pushPackageSidecars } from './index.js';

const USAGE = `usage:
  almadar-sidecars pull [--build-inputs] [--package <dir>]...
  almadar-sidecars push <pkgDir> <lockPath>[=<sourcePath>]...
  almadar-sidecars push --build-inputs <pkgDir> <path>...`;

const plural = (n: number): string => `${n} entr${n === 1 ? 'y' : 'ies'}`;

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === 'pull') {
    const dirs: string[] = [];
    let buildInputs = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--build-inputs') {
        buildInputs = true;
        continue;
      }
      if (rest[i] !== '--package' || rest[i + 1] === undefined) throw new Error(USAGE);
      dirs.push(rest[i + 1]);
      i++;
    }
    if (dirs.length === 0) dirs.push('.');
    for (const dir of dirs) {
      if (buildInputs) {
        const written = await materializeBuildInputs(dir);
        process.stdout.write(`[sidecars] ${dir}: ${written.length} build input(s) restored\n`);
      } else {
        const resolved = await pullPackageSidecars(dir);
        process.stdout.write(`[sidecars] ${dir}: ${plural(resolved.length)} resolved\n`);
      }
    }
    return;
  }
  if (command === 'push') {
    const buildInputs = rest[0] === '--build-inputs';
    const [pkgDir, ...specs] = buildInputs ? rest.slice(1) : rest;
    if (!pkgDir || specs.length === 0) throw new Error(USAGE);
    if (buildInputs) {
      const lock = await pushBuildInputs(pkgDir, specs);
      process.stdout.write(`[sidecars] ${pkgDir}: build-inputs lock holds ${plural(Object.keys(lock.files).length)}\n`);
      return;
    }
    // `<lockPath>=<sourcePath>`, or a bare path when both are the same file.
    const items = specs.map((spec) => {
      const [lockPath, sourcePath = lockPath] = spec.split('=');
      return { lockPath, sourcePath };
    });
    const lock = await pushPackageSidecars(pkgDir, items);
    process.stdout.write(`[sidecars] ${pkgDir}: lock holds ${plural(Object.keys(lock.files).length)}\n`);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
