/**
 * Live tuning controls (ADR-0004: tuning must not require a Rust rebuild).
 *
 * The order here is deliberate — `minCloseMs` is first because it is the single
 * knob that decides whether involuntary blinks fire clicks (ADR-0008, risk R1).
 */

import type { TuningPatch } from '@eye-tracker/core';

export interface SliderSpec {
  group: 'filter' | 'blink' | 'guard';
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  /** Only show this slider in the given gesture mode. */
  onlyMode?: 'blink' | 'wink';
}

export const SLIDERS: SliderSpec[] = [
  {
    group: 'blink',
    key: 'minCloseMs',
    label: 'Deliberate blink threshold',
    hint: 'Closures shorter than this are ignored. Raise it if natural blinks are clicking.',
    min: 80,
    max: 400,
    step: 10,
    value: 150,
    unit: 'ms',
    onlyMode: 'blink',
  },
  {
    group: 'blink',
    key: 'winkAsymmetry',
    label: 'Wink asymmetry required',
    hint: 'How much more closed the winking eye must be. Lower it if your winks are not registering; raise it if blinks are being read as winks.',
    min: 0.05,
    max: 0.6,
    step: 0.01,
    value: 0.28,
    onlyMode: 'wink',
  },
  {
    group: 'blink',
    key: 'winkMinCloseMs',
    label: 'Minimum wink hold',
    hint: 'Winks shorter than this are ignored. Can be lower than the blink threshold, because a wink already rules out involuntary blinks.',
    min: 60,
    max: 400,
    step: 10,
    value: 120,
    unit: 'ms',
    onlyMode: 'wink',
  },
  {
    group: 'blink',
    key: 'doubleWindowMs',
    label: 'Double-blink window',
    hint: 'Single clicks are delayed by this long. Set to 0 for instant single clicks and no double-click.',
    min: 0,
    max: 800,
    step: 25,
    value: 500,
    unit: 'ms',
  },
  {
    group: 'blink',
    key: 'closeThresh',
    label: 'Closure threshold',
    hint: 'How shut the eyes must be to register. Raise if partial closures trigger.',
    min: 0.3,
    max: 0.9,
    step: 0.05,
    value: 0.55,
  },
  {
    group: 'filter',
    key: 'minCutoff',
    label: 'Smoothing at rest',
    hint: 'Lower = steadier cursor when you hold still.',
    min: 0.2,
    max: 4,
    step: 0.1,
    value: 1.0,
    unit: 'Hz',
  },
  {
    group: 'filter',
    key: 'beta',
    label: 'Responsiveness',
    hint: 'Higher = less lag when your gaze moves.',
    min: 0,
    max: 0.05,
    step: 0.001,
    value: 0.007,
  },
  {
    group: 'filter',
    key: 'saccadePx',
    label: 'Saccade threshold',
    hint: 'Jumps larger than this bypass smoothing entirely and land immediately.',
    min: 40,
    max: 400,
    step: 10,
    value: 120,
    unit: 'px',
  },
  {
    group: 'filter',
    key: 'clampRadius',
    label: 'Fixation clamp radius (floor)',
    hint: 'The cursor freezes inside this radius. It grows automatically to match your measured gaze noise — this is only the minimum.',
    min: 0,
    max: 60,
    step: 1,
    value: 22,
    unit: 'px',
  },
  {
    group: 'filter',
    key: 'clampNoiseScale',
    label: 'Clamp adaptivity',
    hint: 'How aggressively the clamp radius grows with measured noise. Raise it if the cursor still will not settle.',
    min: 1,
    max: 6,
    step: 0.1,
    value: 2.5,
  },
  {
    group: 'filter',
    key: 'trustFloor',
    label: 'Confidence floor',
    hint: 'How far a badly-tracked frame may be discounted. Lower = poor frames are smoothed harder, settle sooner, and must jump further to clear the saccade threshold. Raise it if the cursor feels sluggish or slow to jump whenever tracking quality dips; 1.0 turns the effect off.',
    min: 0.1,
    max: 1,
    step: 0.05,
    value: 0.35,
  },
  {
    group: 'filter',
    key: 'medianWindow',
    label: 'Spike rejection',
    hint: '1 disables it. 3 removes isolated bad frames at one frame of latency; 5 is stronger but laggier.',
    min: 1,
    max: 5,
    step: 2,
    value: 3,
    unit: 'frames',
  },
  {
    group: 'guard',
    key: 'minQuality',
    label: 'Minimum tracking quality',
    hint: 'Below this the cursor stops rather than moving somewhere wrong.',
    min: 0,
    max: 0.9,
    step: 0.05,
    value: 0.4,
  },
];

/**
 * @param current live engine config, keyed by the same names as `SliderSpec.key`.
 *   Without it the sliders show hardcoded defaults while the engine is running
 *   persisted values — the UI would then be lying about the current state, and
 *   nudging any slider would silently snap that parameter back to its default.
 */
export function buildSliders(
  root: HTMLElement,
  specs: SliderSpec[],
  onChange: (patch: TuningPatch) => void,
  current: Record<string, number | boolean | string> = {},
): (mode: 'blink' | 'wink') => void {
  root.replaceChildren();
  const modeScoped: Array<{ el: HTMLElement; mode: 'blink' | 'wink' }> = [];

  for (const base of specs) {
    const live = current[base.key];
    const spec: SliderSpec =
      typeof live === 'number' && Number.isFinite(live) ? { ...base, value: live } : base;

    const wrap = document.createElement('div');
    wrap.className = 'slider';
    if (spec.onlyMode) modeScoped.push({ el: wrap, mode: spec.onlyMode });

    const label = document.createElement('label');
    label.textContent = spec.label;

    const value = document.createElement('span');
    value.className = 'slider-value';
    const fmt = (v: number) =>
      `${spec.step < 0.01 ? v.toFixed(3) : spec.step < 1 ? v.toFixed(2) : v.toFixed(0)}${
        spec.unit ? ` ${spec.unit}` : ''
      }`;
    value.textContent = fmt(spec.value);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.value);

    input.addEventListener('input', () => {
      const v = Number(input.value);
      value.textContent = fmt(v);
      onChange({ [spec.group]: { [spec.key]: v } } as TuningPatch);
    });

    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = spec.hint;

    const head = document.createElement('div');
    head.className = 'slider-head';
    head.append(label, value);

    wrap.append(head, input, hint);
    root.append(wrap);
  }

  // Showing wink knobs in blink mode (and vice versa) is just noise — the
  // controls would have no effect.
  return (mode: 'blink' | 'wink') => {
    for (const { el, mode: only } of modeScoped) el.hidden = only !== mode;
  };
}
