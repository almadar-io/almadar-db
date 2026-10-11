import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mock: 'src/mock/index.ts',
    rows: 'src/data/row-query.ts',
    firebase: 'src/firebase/index.ts',
    browser: 'src/browser/index.ts',
    backend: 'src/backend/index.ts',
    file: 'src/credentials/file-credential-persistence.ts',
    emulator: 'src/emulator/index.ts',
    sidecars: 'src/sidecars/index.ts',
    'sidecars-cli': 'src/sidecars/cli.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
});
