#!/usr/bin/env node
/**
 * Read a diagnostics bundle and print it as a terminal summary (ADR-0024).
 *
 *   npm run diagnostics                    the newest bundle this app exported
 *   npm run diagnostics -- <file.json>     a specific bundle, e.g. one from an issue
 *   npm run diagnostics -- --list          every bundle on this machine
 *   npm run diagnostics -- --raw <file>    the file itself, unformatted
 *
 * The point is the second form. When someone attaches a bundle to an issue, the
 * person reading it has no app, no camera and no debug panel — they have a JSON
 * file and a terminal. This turns one into the other.
 *
 * The formatting is `formatBundleSummary` from `@eye-tracker/core`, which is the
 * *same* function the app puts on the clipboard. That is deliberate: if the
 * terminal tool and the app could disagree about what a bundle says, a
 * conversation could run for several rounds with the two participants reading
 * different summaries of the same file.
 *
 * This script only reads local files. It opens no sockets.
 */
import { readdir, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';

// Built output rather than source, so this needs no TypeScript toolchain. Run
// `npm run build:core` first if the import below fails.
import { DIAGNOSTICS_SCHEMA, formatBundleSummary } from '../packages/core/dist/index.js';

// Mirrors Electron's `app.getPath('userData')` for the app name set in
// main/index.ts. Hard-coded rather than imported, because importing it would
// mean booting Electron and turning on a camera to read a text file.
const APP_NAME = 'Eye Tracker';

function userDataDir() {
  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', APP_NAME);
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_NAME);
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), APP_NAME);
  }
}

const ROOT = join(userDataDir(), 'diagnostics');

/** Bundles on this machine, newest first — the filenames sort chronologically. */
async function localBundles() {
  try {
    return (await readdir(ROOT))
      .filter((n) => n.startsWith('diagnostics-') && n.endsWith('.json'))
      .sort()
      .reverse()
      .map((n) => join(ROOT, n));
  } catch {
    return [];
  }
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const files = args.filter((a) => !a.startsWith('--'));

if (flags.has('--list')) {
  const found = await localBundles();
  console.log(`— exported diagnostics —\n\n${ROOT}\n`);
  if (found.length === 0) {
    console.log('Nothing exported yet. This directory does not exist until you use');
    console.log('"Copy diagnostics" in the debug panel.\n');
  } else {
    for (const f of found) console.log(f);
    console.log(`\n${found.length} bundle(s).\n`);
  }
  process.exit(0);
}

const target = files[0] ? resolve(files[0]) : (await localBundles())[0];

if (!target) {
  console.error(
    'No bundle given and none found on this machine.\n\n' +
      `  Looked in: ${ROOT}\n` +
      '  Export one with "Copy diagnostics" in the debug panel, or pass a path:\n' +
      '    npm run diagnostics -- ./downloaded-bundle.json\n',
  );
  process.exit(1);
}

let bundle;
try {
  bundle = JSON.parse(await readFile(target, 'utf8'));
} catch (err) {
  console.error(`Could not read ${target}: ${err.message}`);
  process.exit(1);
}

if (flags.has('--raw')) {
  console.log(JSON.stringify(bundle, null, 2));
  process.exit(0);
}

// Say so rather than guessing. A bundle from a future build may well format
// fine, but a field that changed *meaning* would be printed under its old label
// and read as a finding — which is the whole reason there is a version.
if (bundle.schemaVersion !== DIAGNOSTICS_SCHEMA) {
  console.warn(
    `! This bundle says "${bundle.schemaVersion ?? '(no version)'}" and this build ` +
      `understands "${DIAGNOSTICS_SCHEMA}".\n` +
      '  Anything below may be mislabelled; --raw prints the file itself.\n',
  );
}

console.log(formatBundleSummary(bundle, target));
console.log('');

// The clipboard summary stops at the headline numbers, because it is meant to be
// pasted. A terminal has room for the per-point table, and the per-point table is
// where the answer usually is — it is the arrow map, in text.
const v = bundle.validation;
if (v && Array.isArray(v.targets) && v.targets.length > 0) {
  console.log('Per-point detail (the arrow map, as numbers)');
  console.log('');
  console.log('     target        bias (px)     dir        acc px    acc °   prec px   n');
  const f = (n, w, d = 0) => (n === null || n === undefined ? '—' : n.toFixed(d)).padStart(w);
  v.targets.forEach((t, i) => {
    const mark = i === v.worstIndex ? '*' : ' ';
    console.log(
      `${mark} ${f(t.target?.x, 5)},${f(t.target?.y, 5)}  ` +
        `${f(t.bias?.x, 6)},${f(t.bias?.y, 6)}  ` +
        `${String(t.biasDirection ?? '—').padEnd(10)} ` +
        `${f(t.accuracyPx, 7)}  ${f(t.accuracyDeg, 7, 2)}  ${f(t.precisionPx, 7)}  ${f(t.samples, 3)}`,
    );
  });
  console.log('\n  * worst point.  bias is centroid − target, so +x is right and +y is down.');
  if (v.targets.some((t) => Array.isArray(t.cloud))) {
    const total = v.targets.reduce((s, t) => s + (t.cloud?.length ?? 0), 0);
    console.log(`  This bundle carries ${total} raw samples; --raw prints them.`);
  }
  console.log('');
}
