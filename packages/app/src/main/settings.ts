import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CalibrationProfile, TuningPatch } from '@eye-tracker/core';

export interface Settings {
  tuning: TuningPatch;
  shortcut: string;
  showRawGaze: boolean;
  overlayVisible: boolean;
  calibrationPoints: 5 | 9;
  /** Include the head-motion calibration phase (ADR-0015). */
  calibrationHeadMotion: boolean;
  /** Flip which physical eye counts as the subject's left (ADR-0013). */
  swapEyes: boolean;
  /** Preferred camera `deviceId`, or empty for the system default. */
  cameraDeviceId: string;
  /**
   * Ceiling on the total size of all recorded sessions, in bytes (ADR-0022).
   *
   * The *cap* is remembered; whether recording is on is not, and deliberately
   * has no field here. A remembered enablement would mean a user who recorded
   * once is recorded every time they launch the app, which is precisely the
   * failure the opt-in design exists to prevent.
   */
  recordingCapBytes: number;
}

/**
 * The kill switch must be reachable without a pointer, so it has to be a
 * *global* accelerator that nothing else is likely to claim.
 *
 * It cannot be one string across platforms. Electron's `Command` modifier only
 * exists on macOS; on Windows and Linux `globalShortcut.register` rejects it.
 * That is not a cosmetic failure — registration failing makes the app refuse to
 * enable cursor control at all (ADR-0011), so a mac-only default means a
 * Windows user can never enable control and has no in-app way to fix it.
 *
 * `CommandOrControl` would be the terse spelling, but it is written out per
 * platform so the string stored in `settings.json` is the one the user sees in
 * the UI and in the "could not register" error.
 */
export const DEFAULT_SHORTCUT = process.platform === 'darwin' ? 'Alt+Command+E' : 'Alt+Control+E';

const DEFAULTS: Settings = {
  tuning: {},
  shortcut: DEFAULT_SHORTCUT,
  showRawGaze: false,
  overlayVisible: true,
  calibrationPoints: 9,
  calibrationHeadMotion: true,
  swapEyes: false,
  cameraDeviceId: '',
  // 2 GB. Two 256×192 PNGs per recorded frame is ~70 KB, and the free-viewing
  // rate is 10 Hz, so this is roughly 48 minutes of continuous recording —
  // more than any single data-collection sitting, and small enough to be an
  // amount of disk someone can agree to without thinking hard about it.
  recordingCapBytes: 2_000_000_000,
};

function userDir(): string {
  const dir = app.getPath('userData');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function settingsPath(): string {
  return join(userDir(), 'settings.json');
}

function profilesDir(): string {
  const dir = join(userDir(), 'profiles');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadSettings(): Settings {
  try {
    const raw = readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    // Missing or corrupt settings must not prevent startup.
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    writeFileSync(settingsPath(), JSON.stringify(s, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] could not save:', err);
  }
}

/**
 * Profiles are keyed by display-layout fingerprint. Because the calibration
 * model regresses directly to screen pixels, a profile is only meaningful for
 * the layout it was made on (ADR-0006).
 */
function profilePath(fingerprint: string): string {
  const safe = Buffer.from(fingerprint).toString('base64url').slice(0, 100);
  return join(profilesDir(), `${safe}.json`);
}

export function saveProfile(fingerprint: string, profile: CalibrationProfile): void {
  try {
    writeFileSync(profilePath(fingerprint), JSON.stringify(profile, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] could not save profile:', err);
  }
}

export function loadProfile(fingerprint: string): CalibrationProfile | null {
  const p = profilePath(fingerprint);
  if (!existsSync(p)) return null;
  try {
    const profile = JSON.parse(readFileSync(p, 'utf8')) as CalibrationProfile;
    // A profile from a different layout is not merely stale — it maps gaze to
    // coordinates that do not exist. Refuse it.
    if (profile.displayFingerprint !== fingerprint) return null;
    return profile;
  } catch {
    return null;
  }
}
