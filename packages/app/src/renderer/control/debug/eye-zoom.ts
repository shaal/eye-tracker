/**
 * Debug mode 1 — the eye zoom inspector.
 *
 * The most common cause of "it isn't accurate" is not the regression, the
 * filter, or the calibration protocol. It is that the gaze signal is a couple
 * of pixels wide to begin with.
 *
 * Work it through: at 1280×720 and a normal seating distance the eye is about
 * 115 px corner to corner, and across a full screen sweep the iris centre only
 * travels roughly ±25% of that — a full span of some 58 px, which is 0.5 in
 * `gx` since `gx` divides the offset by the eye width. So **one pixel of iris
 * localisation error is 1/115 ≈ 0.0087 in `gx`, about 1.7% of the entire usable
 * range.** On a 1920-wide screen that is ~33 px of cursor error per pixel of
 * wobble.
 *
 * You cannot see that in a normal-sized preview. This view magnifies each eye
 * until a single camera pixel is a visible block, draws exactly the landmarks
 * the feature extractor uses, and puts numbers on how much they are moving.
 */

import { EYE_A, EYE_B, type EyeLandmarks, type GazeFeatures, type Landmark } from '@eye-tracker/core';
import { noiseVerdict, resolvableSteps, type SignalSummary } from './signal-stats.js';

/** How much of the eye width to show around it. 1.0 would clip the lids. */
const CROP_MARGIN = 0.55;

export interface EyeZoomInputs {
  features: GazeFeatures;
  landmarks: readonly Landmark[] | null;
  summary: SignalSummary;
  /** Screen px per unit of gx/gy, or NaN before calibration. */
  pxPerGx: number;
  pxPerGy: number;
}

/**
 * Draw one eye, magnified, with the landmarks the pipeline actually consumes.
 *
 * `dx` is the horizontal offset of this eye's panel within the canvas.
 *
 * The image content is mirrored to match the camera preview above it, which is
 * flipped in CSS. Only the pixels are flipped — the labels are drawn after the
 * transform is restored, and every coordinate the pipeline consumes stays in
 * raw, unmirrored frame space (ADR-0005). A view that disagreed with the
 * preview about which way round you are would make it impossible to tell
 * whether an asymmetry you spotted was real or an artefact of the display.
 */
function drawEye(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  lm: readonly Landmark[],
  eye: EyeLandmarks,
  measure: GazeFeatures['eyeA'],
  dx: number,
  panelW: number,
  panelH: number,
  label: string,
): void {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || measure.width <= 0) return;

  // Crop box in source pixels, centred on the eye and sized from its own width
  // so the magnification stays constant as you move toward or away from the
  // camera — otherwise leaning in would look like the tracking improved.
  const cropW = measure.width * vw * (1 + 2 * CROP_MARGIN);
  const cropH = (cropW * panelH) / panelW;
  const cx = measure.centerX * vw;
  const cy = measure.centerY * vh;
  const sx = cx - cropW / 2;
  const sy = cy - cropH / 2;

  ctx.save();
  // Kept so the labels can be drawn unflipped without discarding the clip.
  const baseTransform = ctx.getTransform();
  ctx.beginPath();
  ctx.rect(dx, 0, panelW, panelH);
  ctx.clip();

  // Mirror about the panel's own right edge, so panel-local x runs right-to-
  // left. Everything drawn until the matching restore comes out flipped, and
  // `toX` can stay simple panel-local arithmetic.
  ctx.translate(dx + panelW, 0);
  ctx.scale(-1, 1);

  // Nearest-neighbour: at this magnification smoothing would invent detail that
  // is not in the sensor data, and the whole point is to judge the sensor.
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, panelW, panelH);

  const scale = panelW / cropW;
  const toX = (nx: number) => (nx * vw - sx) * scale;
  const toY = (ny: number) => (ny * vh - sy) * scale;

  // Eyelid contour — if this does not hug your lid, the whole landmark fit is
  // off and nothing downstream can be trusted.
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.75)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  eye.ear.forEach((i, k) => {
    const p = lm[i];
    if (!p) return;
    if (k === 0) ctx.moveTo(toX(p.x), toY(p.y));
    else ctx.lineTo(toX(p.x), toY(p.y));
  });
  ctx.closePath();
  ctx.stroke();

  // Iris rim. These four points come from the refinement submodel, and their
  // circularity is the quickest read on whether it is tracking or guessing: a
  // healthy fit is a near-circle, a failing one collapses or wobbles.
  ctx.strokeStyle = 'rgba(88, 214, 141, 0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  eye.irisRim.forEach((i, k) => {
    const p = lm[i];
    if (!p) return;
    if (k === 0) ctx.moveTo(toX(p.x), toY(p.y));
    else ctx.lineTo(toX(p.x), toY(p.y));
  });
  ctx.closePath();
  ctx.stroke();

  // Eye centre (the origin gx/gy are measured from) and iris centre (the thing
  // being measured). The gap between them IS the gaze signal.
  const ex = toX(measure.centerX);
  const ey = toY(measure.centerY);
  const ix = toX(measure.irisX);
  const iy = toY(measure.irisY);

  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ex - 8, ey);
  ctx.lineTo(ex + 8, ey);
  ctx.moveTo(ex, ey - 8);
  ctx.lineTo(ex, ey + 8);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(88, 214, 141, 0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ex, ey);
  ctx.lineTo(ix, iy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ix, iy, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(88, 214, 141, 0.9)';
  ctx.fill();

  // Drop the mirror before any text: flipped labels are unreadable, and the
  // clip region is still in force so they stay inside this panel.
  ctx.setTransform(baseTransform);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '11px ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(label, dx + 6, 14);
  ctx.fillText(`${(measure.width * vw).toFixed(0)}px wide`, dx + 6, panelH - 6);

  ctx.restore();
}

export function drawEyeZoom(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  input: EyeZoomInputs,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 480;
  const cssH = canvas.clientHeight || 180;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#0b0e13';
  ctx.fillRect(0, 0, cssW, cssH);

  const { features, landmarks } = input;
  if (!features.ok || !landmarks) {
    ctx.fillStyle = 'rgba(255, 107, 107, 0.9)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('No face — nothing to inspect', 12, 24);
    return;
  }

  const gap = 6;
  const panelW = (cssW - gap) / 2;

  // Order the panels the way the mirror puts them: the eye at the LARGER source
  // x appears on the LEFT once flipped. Mirroring the pixels without also
  // reordering the panels would leave the zoom still contradicting the preview,
  // just less obviously.
  const [left, right] =
    features.eyeA.centerX >= features.eyeB.centerX
      ? ([
          { eye: EYE_A, measure: features.eyeA, label: 'eye A' },
          { eye: EYE_B, measure: features.eyeB, label: 'eye B' },
        ] as const)
      : ([
          { eye: EYE_B, measure: features.eyeB, label: 'eye B' },
          { eye: EYE_A, measure: features.eyeA, label: 'eye A' },
        ] as const);

  drawEye(ctx, video, landmarks, left.eye, left.measure, 0, panelW, cssH, left.label);
  drawEye(ctx, video, landmarks, right.eye, right.measure, panelW + gap, panelW, cssH, right.label);

  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(panelW + gap / 2, 0);
  ctx.lineTo(panelW + gap / 2, cssH);
  ctx.stroke();
}

/** The numeric half of mode 1 — rendered as text, because that is what you act on. */
export function eyeZoomReadout(input: EyeZoomInputs): {
  rows: Array<[string, string, 'good' | 'warn' | 'bad' | 'plain']>;
  verdict: string;
} {
  const { summary, pxPerGx, pxPerGy, features } = input;
  const rows: Array<[string, string, 'good' | 'warn' | 'bad' | 'plain']> = [];

  const settling = summary.samples < 60;
  const noisePxX = summary.noiseGx * pxPerGx;
  const noisePxY = summary.noiseGy * pxPerGy;
  // Isotropic combination: the cursor's distance from where you meant it to be
  // is what matters, not either axis alone.
  const noisePx = Math.hypot(noisePxX, noisePxY);
  const verdict = noiseVerdict(noisePx);

  rows.push([
    'Noise floor',
    Number.isFinite(noisePx)
      ? `±${noisePx.toFixed(0)} px  (gx ${summary.noiseGx.toFixed(4)})`
      : `gx ${summary.noiseGx.toFixed(4)} — calibrate to see this in px`,
    Number.isFinite(noisePx) ? verdict.level : 'plain',
  ]);

  const stepsX = resolvableSteps(summary.travelGx, summary.noiseGx);
  const stepsY = resolvableSteps(summary.travelGy, summary.noiseGy);
  rows.push([
    'Signal travel',
    `gx ${summary.travelGx.toFixed(3)}  gy ${summary.travelGy.toFixed(3)}`,
    summary.travelGx < 0.08 ? 'warn' : 'plain',
  ]);
  rows.push([
    'Resolvable steps',
    Number.isFinite(stepsX) ? `${stepsX.toFixed(0)} × ${stepsY.toFixed(0)}` : '—',
    // NaN fails both comparisons and would land in the final arm, painting an
    // *unmeasured* signal green. Unknown must look unknown.
    !Number.isFinite(stepsX) ? 'plain' : stepsX < 8 ? 'bad' : stepsX < 15 ? 'warn' : 'good',
  ]);

  // A large disagreement between the eyes means one iris is being mis-fit —
  // and since gaze is their mean, a bad eye drags the good one with it.
  rows.push([
    'Eye disagreement',
    summary.meanDgx.toFixed(4),
    summary.meanDgx > 0.03 ? 'bad' : summary.meanDgx > 0.015 ? 'warn' : 'good',
  ]);

  rows.push([
    'Eye width',
    `${(features.eyeA.width * 100).toFixed(1)} / ${(features.eyeB.width * 100).toFixed(1)} (% of frame)`,
    features.interocular < 0.09 ? 'warn' : 'plain',
  ]);

  const advice = settling
    ? 'Measuring… hold a fixation for a few seconds.'
    : summary.travelGx < 0.08
      ? 'Barely any signal range yet. Look at the far left of the screen, then the far right — if travel stays under ~0.10 the camera is not resolving your gaze, and sitting closer or adding light is the only fix.'
      : Number.isFinite(noisePx)
        ? verdict.label
        : 'Calibrate to convert this noise into cursor pixels.';

  return { rows, verdict: advice };
}
