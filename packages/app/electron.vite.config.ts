import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  main: {
    // The native addon must stay external — it is a .node binary, not something
    // Rollup can bundle.
    plugins: [externalizeDepsPlugin({ exclude: ['@eye-tracker/core'] })],
    build: {
      rollupOptions: { input: { index: r('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@eye-tracker/core'] })],
    build: {
      rollupOptions: { input: { index: r('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: r('src/renderer'),
    // Vendored MediaPipe assets (ADR-0003). Served at the web root in dev and
    // copied alongside the HTML in a build, so a relative './wasm' path works
    // in both.
    publicDir: r('resources'),
    build: {
      rollupOptions: {
        input: {
          // Flat output — both HTML files land beside the copied assets, so
          // relative asset paths resolve identically in dev and production.
          index: r('src/renderer/index.html'),
          overlay: r('src/renderer/overlay.html'),
        },
      },
    },
  },
});
