#!/usr/bin/env node
/**
 * Vendors the MediaPipe assets the app needs at runtime (ADR-0003).
 *
 * The app never fetches from the network while running, so the renderer's CSP
 * can forbid remote origins outright and the tracker works offline.
 *
 *   - WASM runtime: copied out of node_modules, so it is guaranteed to match
 *     the version of the JS API we import.
 *   - Model weights: downloaded once from Google's model garden and cached.
 *
 * Safe to re-run. Non-fatal on network failure — install should not break, and
 * the app surfaces a clear "model missing" state instead.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, access, stat, readdir, copyFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCES = join(ROOT, 'packages', 'app', 'resources');
const WASM_DEST = join(RESOURCES, 'wasm');
const MODEL_DEST = join(RESOURCES, 'models');

const MODEL = {
  name: 'face_landmarker.task',
  // float16 build: 478 landmarks incl. iris, 52 blendshapes, transformation matrix.
  url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  minBytes: 1_000_000,
};

const exists = (p) => access(p).then(() => true, () => false);

async function findWasmSource() {
  // npm workspaces may hoist to the root or keep it package-local.
  const candidates = [
    join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
    join(ROOT, 'packages', 'app', 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'),
  ];
  for (const c of candidates) if (await exists(c)) return c;
  return null;
}

async function copyWasm() {
  const src = await findWasmSource();
  if (!src) {
    console.warn('[fetch-models] @mediapipe/tasks-vision not installed yet — skipping WASM copy.');
    return false;
  }
  await mkdir(WASM_DEST, { recursive: true });
  const files = await readdir(src);
  for (const f of files) await copyFile(join(src, f), join(WASM_DEST, f));
  console.log(`[fetch-models] WASM runtime -> resources/wasm (${files.length} files)`);
  return true;
}

async function downloadModel() {
  const dest = join(MODEL_DEST, MODEL.name);
  if (await exists(dest)) {
    const { size } = await stat(dest);
    if (size >= MODEL.minBytes) {
      console.log(`[fetch-models] ${MODEL.name} already present (${(size / 1e6).toFixed(1)} MB)`);
      return true;
    }
    // A truncated file from an interrupted download is worse than none: it
    // fails at model-load time with an opaque error.
    await rm(dest, { force: true });
  }

  await mkdir(MODEL_DEST, { recursive: true });
  const tmp = `${dest}.partial`;
  console.log(`[fetch-models] downloading ${MODEL.name} ...`);
  try {
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    const { size } = await stat(tmp);
    if (size < MODEL.minBytes) throw new Error(`suspiciously small (${size} bytes)`);
    // Rename only after the size check, so `dest` existing always means valid.
    const { rename } = await import('node:fs/promises');
    await rename(tmp, dest);
    console.log(`[fetch-models] ${MODEL.name} -> resources/models (${(size / 1e6).toFixed(1)} MB)`);
    return true;
  } catch (err) {
    await rm(tmp, { force: true });
    console.warn(`[fetch-models] could not download model: ${err.message}`);
    console.warn(`[fetch-models] run 'npm run fetch-models' when online, or place the file at:`);
    console.warn(`[fetch-models]   ${dest}`);
    console.warn(`[fetch-models]   from ${MODEL.url}`);
    return false;
  }
}

const wasmOk = await copyWasm();
const modelOk = await downloadModel();
if (!wasmOk || !modelOk) {
  console.warn('[fetch-models] assets incomplete — the app will report this at startup.');
}
process.exit(0);
