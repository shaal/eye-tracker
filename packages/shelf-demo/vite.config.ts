import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Reuses the app package's vendored MediaPipe wasm + model rather than
// re-fetching or re-vendoring ~4 MB of assets for a demo package.
export default defineConfig({
  publicDir: resolve(__dirname, '../app/resources'),
  server: {
    fs: {
      allow: [resolve(__dirname, '..')],
    },
  },
});
