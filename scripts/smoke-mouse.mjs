#!/usr/bin/env node
/**
 * Milestone M2 smoke test: prove the native mouse path works on this machine
 * before any gaze code is involved.
 *
 * Modes (report-only by default, so running it can never surprise you):
 *
 *   npm run smoke:mouse            report backend, permission, cursor position
 *   npm run smoke:mouse -- --move  move the cursor in a square, then put it back
 *   npm run smoke:mouse -- --click 5 s countdown, then double-click WHERE THE
 *                                  CURSOR ALREADY IS — park it over a word in a
 *                                  text editor and watch the word get selected.
 *
 * The --click check is the one that matters for ADR-0010: word-selection only
 * happens for a real double-click carrying clickState=2. Two separate single
 * clicks will not select the word.
 */
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let native;
try {
  native = require(join(ROOT, 'packages', 'native', 'index.js'));
} catch (err) {
  console.error('Could not load the native addon. Build it first:\n  npm run build:native\n');
  console.error(err.message);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = new Set(process.argv.slice(2));

console.log('— eye-tracker native mouse smoke test —\n');
console.log(`core version   : ${native.coreVersion()}`);
console.log(`mouse backend  : ${native.mouseBackendName()}`);
console.log(`frame width    : ${native.frameWidth()} slots`);

// Checked, never inferred: without this permission CGEventPost silently
// succeeds and does nothing (ADR-0011).
const trusted = native.checkAccessibilityPermission(false);
console.log(`accessibility  : ${trusted ? 'GRANTED' : 'NOT GRANTED'}`);

if (!trusted) {
  console.log(`
  Without Accessibility permission the cursor will not move and macOS will
  report no error at all. Grant it to your terminal (or the packaged app) in:

    System Settings → Privacy & Security → Accessibility

  Re-run with --prompt to have macOS show the request dialog.`);
  if (args.has('--prompt')) native.checkAccessibilityPermission(true);
  process.exit(1);
}

const start = native.cursorPosition();
console.log(`cursor at      : (${start.x.toFixed(0)}, ${start.y.toFixed(0)})`);

if (args.has('--move')) {
  console.log('\nMoving the cursor in a square (relative to where it is now)…');
  const d = 120;
  const square = [
    { x: start.x - d, y: start.y - d },
    { x: start.x + d, y: start.y - d },
    { x: start.x + d, y: start.y + d },
    { x: start.x - d, y: start.y + d },
  ];
  for (const p of square) {
    // Step rather than jump, so it is visible and exercises repeated posting
    // at roughly the rate the engine will use.
    for (let i = 1; i <= 20; i++) {
      const cur = native.cursorPosition();
      native.moveCursor(cur.x + (p.x - cur.x) * (i / 20), cur.y + (p.y - cur.y) * (i / 20));
      await sleep(8);
    }
  }
  native.moveCursor(start.x, start.y);
  console.log('Cursor returned to its starting position.');
  console.log('If it did not visibly move, Accessibility permission is the first suspect.');
}

if (args.has('--click')) {
  console.log(`
Double-click test. Park the cursor over a WORD in a text editor.
The script will NOT move it — it double-clicks wherever you leave it.`);
  for (let s = 5; s > 0; s--) {
    process.stdout.write(`\r  clicking in ${s}s… `);
    await sleep(1000);
  }
  const at = native.cursorPosition();
  native.clickCursor(2);
  console.log(`\r  double-clicked at (${at.x.toFixed(0)}, ${at.y.toFixed(0)})   `);
  console.log(`
  PASS if the word under the cursor is now selected.
  FAIL if the caret just moved — that means two singles were delivered rather
  than a real double-click, and the clickState field is not being set.`);
}

if (!args.has('--move') && !args.has('--click')) {
  console.log('\nReport-only. Add --move or --click to exercise the cursor.');
}
