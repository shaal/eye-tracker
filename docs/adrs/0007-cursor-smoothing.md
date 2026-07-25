# ADR-0007: One Euro filter, saccade gate, and fixation clamp

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Raw gaze estimates are noisy at roughly 20–60 px RMS, and the noise is visually
intolerable — an unfiltered cursor vibrates constantly. But smoothing trades
directly against latency, and eye movement has a pathological property for
filter design: it is **not a smooth trajectory**. Gaze consists of *fixations*
(near-stationary, 200–600 ms, where all the noise lives) punctuated by
*saccades* (ballistic jumps up to 500°/s, essentially instantaneous).

This breaks the usual filters:

- **Fixed-α EMA.** Choose α for smooth fixations and saccades take 300 ms to
  land. Choose α for snappy saccades and fixations jitter. There is no setting
  that is good at both, because the signal has two regimes.
- **Kalman with a constant-velocity model.** Strictly worse here — its process
  model *assumes* velocity continuity, which is exactly what a saccade violates.
  It will smoothly ramp through a jump that should be instantaneous, and its
  gain has to be retuned per user anyway.

The requirement asks for "EMA or Kalman." What we want is the adaptive
generalization of the former.

## Decision

Three stages, in order, in `packages/native/src/filter/`.

### 1. One Euro filter (adaptive EMA)

The [One Euro filter](https://gery.casiez.net/1euro/) is an exponential moving
average whose cutoff frequency rises with the estimated speed of the signal:

```
dx̂   = lowpass(Δx · rate, α(d_cutoff))       // smoothed speed estimate
fc    = min_cutoff + β · |dx̂|                 // speed-adaptive cutoff
x̂     = lowpass(x, α(fc))                     // the output
```

When gaze is still, `fc → min_cutoff`, giving heavy smoothing and a dead-still
cursor. When gaze moves, `fc` rises and the filter gets out of the way. It is
two parameters (`min_cutoff`, `β`), both physically interpretable, and it costs
about a dozen floating-point operations.

Defaults: `min_cutoff = 1.0 Hz`, `β = 0.007`, `d_cutoff = 1.0 Hz`. It is applied
per axis, using **measured inter-frame time**, not a nominal rate — camera
frame intervals are not uniform and assuming 1/30 s introduces speed-estimate
error precisely during the dropped frames where it hurts most.

### 2. Saccade gate

Even an adaptive filter lags a true ballistic jump. So we detect the jump and
bypass the filter:

```
if |x_raw − x̂_prev| > saccade_px:      // default 120 px
    reset filter state to x_raw        // teleport, do not glide
```

This is what makes the cursor feel *responsive* rather than *smooth-but-laggy*.
Looking at a new target lands there immediately; the filter then re-engages and
settles out the noise at the new location.

### 3. Fixation clamp

Sub-pixel jitter around a fixation makes clicking hard even when it is visually
minor. Once the smoothed point has stayed inside a radius for a dwell time, we
**freeze the output exactly** until it leaves:

```
if within(clamp_radius = 14 px) for clamp_ms = 120 ms:
    hold output constant
release when displacement exceeds clamp_radius
```

The cursor becomes genuinely motionless during a fixation, which is what makes
blink-clicking land where the user is actually looking.

### Blink freeze (the non-obvious one)

**During a blink, the eyelid occludes the iris and the gaze estimate is
garbage** — typically sliding downward as the lid crosses the pupil. Without
handling, every blink drags the cursor down and then clicks there.

Two mitigations, both required:

1. **Freeze on closure.** Once the blink FSM reports closing, the filter stops
   accepting input and holds its last good output until the eyes reopen and
   quality recovers.
2. **Pre-blink anchoring.** The engine keeps a ring buffer of recent smoothed
   positions. A synthesized click uses the position from
   `blink_onset − 150 ms`, not the position at click time. See ADR-0008.

### Output stage

The final position is clamped to the union of display bounds, rounded to
integer device coordinates, and **only dispatched to the OS if it differs from
the last dispatched position**. Suppressing no-op moves keeps us from flooding
the window server during a fixation.

## Consequences

### What this buys us

- Still when still, immediate when moving — the two regimes are handled by
  different mechanisms rather than one compromised constant.
- Clicks land where the user was looking before the blink corrupted the signal.
- Two interpretable tuning knobs instead of a Kalman covariance matrix.

### What this costs us

- Three stages of state to reason about. A bug in the clamp presents as "the
  cursor is stuck," which is alarming; the clamp therefore has a hard timeout.
- The saccade threshold is in pixels and so is display-size dependent. It scales
  with the diagonal of the work area.
- Smooth pursuit (tracking a moving object) is the one regime this handles
  worst — it may trip the saccade gate repeatedly. Rare in desktop use.

### What we would need to see to revisit this

- Users reporting the cursor "sticking" — the clamp radius is the first suspect.
- A use case dominated by smooth pursuit rather than fixate-and-jump.
