import { screen } from 'electron';
import { displayFingerprint, type ScreenBounds } from '@eye-tracker/core';

/**
 * Union of all display work areas, in logical (DIP) pixels.
 *
 * This is the coordinate space the engine works in end to end (ADR-0010): the
 * calibration model regresses into it, the filter clamps to it, and the macOS
 * mouse backend consumes it without conversion.
 */
export function unionBounds(): ScreenBounds {
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return { x: 0, y: 0, width: 1920, height: 1080 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const d of displays) {
    const b = d.bounds;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Primary display bounds — where calibration targets are placed. */
export function primaryBounds(): ScreenBounds {
  const d = screen.getPrimaryDisplay();
  return { ...d.bounds };
}

export function currentFingerprint(): string {
  return displayFingerprint(
    screen.getAllDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    })),
  );
}

/**
 * Pixels per degree of visual angle, for reporting calibration accuracy in
 * familiar units.
 *
 * Electron does not expose physical display size, so this assumes a typical
 * viewing distance and a typical pixel density. It is a presentation detail
 * only — the sole consumer is `mean_error_deg` in `fit.rs`, and nothing in the
 * estimator depends on it.
 *
 * ## The units, because getting them wrong halved every reported figure
 *
 * Every coordinate this app handles — display bounds, cursor positions,
 * calibration targets — is a **device-independent pixel**, not a physical one.
 * So the density that matters is DIP per inch, and on a Retina Mac that is
 * roughly 110–150: the panel is ~220–254 physical PPI and `scaleFactor` is 2.
 *
 * The previous version took 110 as the *physical* density and then divided by
 * `scaleFactor` to convert, which double-counted the scaling and produced ~55
 * DIP/inch — a density no shipping display has. A first real measurement
 * reported 22.7 px/° where ~45–60 was right, so a genuinely mediocre 5–6° of
 * error was displayed as a catastrophic 15°. The number was wrong in the
 * direction that makes the tracker look broken, which is the worst direction
 * for a figure whose whole job is to tell the user whether to keep going.
 *
 * 110 is deliberately the low end of the Retina range: it errs toward
 * *over*-reporting error, so the app is pessimistic about itself rather than
 * flattering. Rust's own fallback is 45.0 (`config.rs`), which this now agrees
 * with to within a few percent instead of being half of it.
 *
 * A non-Retina external monitor (~81 PPI at `scaleFactor` 1) is over-estimated
 * by this constant. That is accepted: macOS is the supported target (ADR-0010),
 * Retina is the case that matters, and the honest fix is to measure the display
 * rather than to pick a second constant.
 */
export function estimatePxPerDegree(assumedViewingDistanceMm = 600): number {
  // Already device-independent: DIP per inch, NOT physical PPI. Do not divide
  // by `scaleFactor` — the coordinates this converts are themselves in DIP.
  const assumedDipPerInch = 110;
  const pxPerMm = assumedDipPerInch / 25.4;
  const mmPerDegree = assumedViewingDistanceMm * Math.tan((1 * Math.PI) / 180);
  return Math.max(1, pxPerMm * mmPerDegree);
}
