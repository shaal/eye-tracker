#!/usr/bin/env node
/**
 * Boot smoke test: launch the built app, capture its output, and kill it after
 * a fixed timeout so it can never linger.
 *
 *   node scripts/smoke-app.mjs [seconds]
 *
 * This verifies that the main process boots, the native engine constructs, the
 * preload resolves and both windows are created. It does NOT verify tracking —
 * that needs a human looking at the screen.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'packages', 'app');
const SECONDS = Number(process.argv[2] ?? 12);

const electron = require('electron');
const binary = typeof electron === 'string' ? electron : String(electron);

console.log(`Launching the app for ${SECONDS}s (it will be killed automatically)…\n`);

const child = spawn(binary, ['.'], {
  cwd: APP,
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const lines = [];
const capture = (stream, tag) => {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) {
      if (line.trim()) {
        lines.push(`[${tag}] ${line}`);
        console.log(`[${tag}] ${line}`);
      }
    }
  });
};
capture(child.stdout, 'out');
capture(child.stderr, 'err');

const startedAt = process.hrtime.bigint();
let exited = false;
child.on('exit', (code, signal) => {
  exited = true;
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  console.log(`\nApp exited (code=${code} signal=${signal}) after ${(elapsedMs / 1000).toFixed(1)}s.`);

  // The test is "the app stays up and healthy for N seconds". Any exit before
  // we terminate it is a failure — otherwise a crash two seconds in reports a
  // confident pass simply because none of the known error patterns matched.
  if (!terminating) {
    if (lines.length === 0) {
      console.log(
        '\nINCONCLUSIVE: the app exited immediately with no output.\n' +
          'Another instance is probably already running (single-instance lock).\n' +
          'Quit it and re-run — this was not a real test.',
      );
      process.exit(2);
    }
    console.log('\nFAILURE: the app exited on its own before the timeout.');
    summarize(1);
    return;
  }
  summarize();
});

let terminating = false;
const timer = setTimeout(() => {
  if (!exited) {
    terminating = true;
    console.log(`\n${SECONDS}s elapsed — terminating.`);
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  }
}, SECONDS * 1000);
timer.unref();

function summarize(forcedExitCode = 0) {
  const text = lines.join('\n');
  const fatal = [
    ['preload missing', /no preload script found/i],
    ['engine init failed', /engine failed to initialize/i],
    ['frame layout mismatch', /Frame layout mismatch/i],
    ['module not found', /Cannot find module|ERR_MODULE_NOT_FOUND/i],
    ['renderer crash', /Uncaught|is not a function|undefined is not an object/i],
  ];
  const hits = fatal.filter(([, re]) => re.test(text));

  console.log('\n— summary —');
  if (hits.length === 0) {
    console.log(
      forcedExitCode === 0
        ? 'No fatal startup errors detected.'
        : 'No known error pattern matched, but the app did not survive the run.',
    );
  } else {
    for (const [name] of hits) console.log(`FAILURE: ${name}`);
  }
  process.exit(hits.length === 0 ? forcedExitCode : 1);
}
