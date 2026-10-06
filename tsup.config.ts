import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    mock: 'src/mock/index.ts',
    firebase: 'src/firebase/index.ts',
    browser: 'src/browser/index.ts',
    backend: 'src/backend/index.ts',
    file: 'src/credentials/file-credential-persistence.ts',
    emulator: 'src/emulator/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  treeshake: true,
});
