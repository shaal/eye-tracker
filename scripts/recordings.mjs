#!/usr/bin/env node
/**
 * Inspect and delete locally recorded training sessions (ADR-0022).
 *
 *   npm run recordings              list every session with its size and settings
 *   npm run recordings -- --json    the same, as JSON, for a training script
 *   npm run recordings -- --delete  delete ALL recordings, after confirmation
 *
 * The app has a delete button too. This exists so that deleting does not
 * require launching an app that turns on your camera, and so that "what exactly
 * is on my disk?" is answerable from a terminal without trusting the UI that
 * wrote it.
 *
 * This script only ever reads and unlinks local files. It opens no sockets.
 */
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

// Mirrors Electron's `app.getPath('userData')` for the app name set in
// main/index.ts. Hard-coded rather than imported because importing it would
// mean booting Electron, and the whole point of this script is that it does
// not.
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

const ROOT = join(userDataDir(), 'recordings');

async function directoryBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path);
    else total += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/** Count lines without reading the file into memory twice over. */
async function countRecords(path) {
  try {
    const text = await readFile(path, 'utf8');
    return text.length === 0 ? 0 : text.trimEnd().split('\n').length;
  } catch {
    return 0;
  }
}

async function collect() {
  let names;
  try {
    names = (await readdir(ROOT, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const sessions = [];
  for (const name of names) {
    const dir = join(ROOT, name);
    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8'));
    } catch {
      // A session killed before its manifest landed, or a directory that was
      // never one of ours. Report it rather than hiding it — an unexplained
      // folder of face images is exactly what someone auditing this wants to
      // see named.
    }
    sessions.push({
      sessionId: name,
      directory: dir,
      bytes: await directoryBytes(dir),
      records: await countRecords(join(dir, 'frames.jsonl')),
      manifest,
    });
  }
  return sessions;
}

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

function describe(session) {
  const m = session.manifest;
  const head = `${session.sessionId}  ${mb(session.bytes).padStart(10)}  ${String(
    session.records,
  ).padStart(7)} frames`;
  if (!m) return `${head}\n    (no manifest — incomplete or not written by this app)`;

  const camera = m.camera
    ? `${m.camera.label} · ${m.camera.width}×${m.camera.height} @ ${Math.round(
        m.camera.frameRate,
      )} fps · exposure ${m.camera.exposureMode ?? 'unreported'}` +
      (m.camera.exposureTimeMs === null ? '' : ` (${m.camera.exposureTimeMs.toFixed(1)} ms)`)
    : 'camera not reported';

  return (
    `${head}\n` +
    `    app ${m.appVersion} · schema ${m.schema}\n` +
    `    started ${m.startedIso}${m.stoppedIso ? ` · stopped ${m.stoppedIso}` : ' · NOT CLOSED'}\n` +
    `    ${camera}\n` +
    `    crops ${m.crop.width}×${m.crop.height} ${m.crop.format}, margin ${m.crop.margin}\n` +
    `    displays ${m.displayFingerprint || '(unknown)'}` +
    (m.stopReason ? `\n    ended because: ${m.stopReason}` : '') +
    (m.dropped ? `\n    ${m.dropped} frame(s) dropped at the disk` : '')
  );
}

const args = new Set(process.argv.slice(2));
const sessions = await collect();
const total = sessions.reduce((sum, s) => sum + s.bytes, 0);

if (args.has('--json')) {
  console.log(JSON.stringify({ root: ROOT, total, sessions }, null, 2));
  process.exit(0);
}

console.log(`— recorded sessions —\n\n${ROOT}\n`);

if (sessions.length === 0) {
  console.log('Nothing recorded. This directory does not exist until you record something.\n');
  process.exit(0);
}

for (const session of sessions) console.log(`${describe(session)}\n`);
console.log(`${sessions.length} session(s), ${mb(total)} total.\n`);

if (!args.has('--delete')) {
  console.log('Delete all of them with:  npm run recordings -- --delete\n');
  process.exit(0);
}

// Confirmed rather than flagged. `--delete` is easy to leave in a shell history
// and these files cannot be recovered.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  `Delete all ${sessions.length} session(s) and ${mb(total)}? This cannot be undone. [y/N] `,
);
rl.close();

if (answer.trim().toLowerCase() !== 'y') {
  console.log('Nothing deleted.');
  process.exit(0);
}

await rm(ROOT, { recursive: true, force: true });
console.log(`Deleted ${sessions.length} session(s), freeing ${mb(total)}.`);
