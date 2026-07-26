/**
 * The disk and clipboard half of the diagnostics export (ADR-0024).
 *
 * Lives in main because the renderer has no filesystem and must not be given
 * one (ADR-0002), and because the clipboard is more reliable from here: the
 * renderer's `navigator.clipboard` needs the document to be focused, and the
 * user will often be clicking this button with the debug panel scrolled and the
 * window behind something.
 *
 * ## Why both a file and a clipboard
 *
 * They carry different things on purpose. The **file** is the whole bundle —
 * every per-target bias vector, every tuning key, optionally every raw sample —
 * which is 6–10 KB of JSON, or upwards of 80 KB with the clouds. That is a fine
 * thing to attach to an issue and a terrible thing to paste into a comment box:
 * nobody scrolls past forty lines of JSON to find the finding.
 *
 * The **clipboard** therefore gets `formatBundleSummary` — about thirty lines
 * that state the A/B switch positions, the noise floor, and accuracy and
 * precision separately, ending with the path to the full file. Someone can paste
 * that straight into a reply and be understood, and attach the file when the
 * conversation needs the detail.
 *
 * ## Numbers only
 *
 * `buildDiagnosticsBundle` copies every field by name, so nothing the renderer
 * sends can reach the file except through a field this repository declared. That
 * is why the merge below is written out longhand rather than as a spread — see
 * the header of `diagnostics/bundle.ts`, and note that the recorder (ADR-0022)
 * is the place for pixels, not this one.
 */

import { app, clipboard, shell } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  buildDiagnosticsBundle,
  diagnosticsFileName,
  formatBundleSummary,
  serializeBundle,
  type CalibrationReport,
  type DiagnosticsExportResult,
  type DiagnosticsRendererState,
  type ScreenBounds,
} from '@eye-tracker/core';

/** What main knows and the renderer does not. */
export interface DiagnosticsMainContext {
  displayFingerprint: string;
  displayBounds: ScreenBounds | null;
  /** Read back from the engine, not from the UI — the point of the exercise. */
  tuning: Record<string, unknown>;
  /** The loaded model's own report, so it survives restarts and window reloads. */
  calibration: CalibrationReport | null;
  engine: {
    fps: number;
    poseDrift: number;
    headCompensated: boolean;
    calibrated: boolean;
    guardReason: string;
  } | null;
}

/** `<userData>/diagnostics`. One place, so "where did it go?" has one answer. */
export function diagnosticsDir(): string {
  return join(app.getPath('userData'), 'diagnostics');
}

/**
 * Build the bundle, write it, and put the summary on the clipboard.
 *
 * Never throws for want of data. A user who cannot get through calibration is
 * reporting the most interesting failure there is, and an export that refused
 * without one would drop exactly that case (#49).
 */
export async function exportDiagnostics(
  renderer: DiagnosticsRendererState,
  context: DiagnosticsMainContext,
): Promise<DiagnosticsExportResult> {
  const now = new Date();

  const bundle = buildDiagnosticsBundle({
    capturedIso: now.toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    displayFingerprint: context.displayFingerprint,
    displayBounds: context.displayBounds,
    // Named individually rather than spread: the renderer's payload arrives
    // over IPC and is only as trustworthy as the camera-facing page that sent
    // it, so main decides field by field what may reach a shareable file.
    camera: renderer.camera,
    vision: renderer.vision,
    signal: renderer.signal,
    validation: renderer.validation,
    engine: context.engine,
    tuning: context.tuning,
    calibration: context.calibration,
    includeClouds: renderer.includeClouds === true,
  });

  const dir = diagnosticsDir();
  await mkdir(dir, { recursive: true });
  // The renderer never names the path — it supplies numbers, and main derives
  // the filename from its own clock. Same rule as the recorder's `seq`.
  const path = join(dir, diagnosticsFileName(now));
  const text = serializeBundle(bundle);
  await writeFile(path, text, 'utf8');

  const summary = formatBundleSummary(bundle, path);
  let copied = true;
  try {
    clipboard.writeText(summary);
  } catch (err) {
    // A failed clipboard is a degraded success, not a failure: the file is
    // already on disk and is the artefact that matters. Saying so beats
    // throwing away a bundle the user just waited for.
    copied = false;
    console.warn('[diagnostics] could not write the clipboard:', err);
  }

  console.info(`[diagnostics] wrote ${path} (${Buffer.byteLength(text)} bytes)`);
  return { path, bytes: Buffer.byteLength(text), summary, copied };
}

/** Open the diagnostics folder, so the file can be dragged onto an issue. */
export async function revealDiagnostics(): Promise<void> {
  const dir = diagnosticsDir();
  await mkdir(dir, { recursive: true });
  await shell.openPath(dir);
}
