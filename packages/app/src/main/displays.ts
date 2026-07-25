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
 * viewing distance and derives px/mm from the reported DPI scale. It is a
 * presentation detail only — nothing in the estimator depends on it.
 */
export function estimatePxPerDegree(assumedViewingDistanceMm = 600): number {
  const d = screen.getPrimaryDisplay();
  // Assume ~110 physical PPI for a typical laptop panel, expressed in DIP.
  const assumedPpi = 110 / (d.scaleFactor || 1);
  const pxPerMm = assumedPpi / 25.4;
  const mmPerDegree = assumedViewingDistanceMm * Math.tan((1 * Math.PI) / 180);
  return Math.max(1, pxPerMm * mmPerDegree);
}
