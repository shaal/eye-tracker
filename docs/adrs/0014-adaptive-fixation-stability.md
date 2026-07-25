# ADR-0014: Median pre-filter and a self-tuning fixation clamp

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

First real-hardware session on a MacBook Pro webcam: tracking worked, but the
cursor was **constantly moving even while the user fixated a single point**. The
fixation clamp from ADR-0007 was supposed to prevent exactly that.

It was not engaging. The clamp requires the smoothed point to stay inside a
**14 px** radius for 120 ms. Measured gaze noise on that hardware is larger than
that, so the condition was essentially never satisfied — the mechanism designed
to stop the cursor never ran at all.

Two separate problems were hiding behind one symptom:

1. **The clamp radius was a fixed constant.** There is no single value that
   works: too small and it never engages (this case), too large and precision is
   thrown away for users with a good camera. The right radius depends on the
   user's actual noise level, which we can measure but were not.

2. **Iris landmark noise is not Gaussian.** It contains isolated spikes where
   the refinement model briefly mislocalizes the pupil by tens of pixels. An
   exponential filter cannot reject a spike — it *averages it in*, so one bad
   frame smears across the next several. One Euro made this worse rather than
   better, because a spike also inflates its speed estimate and temporarily
   raises the cutoff, reducing smoothing exactly when it is most needed.

## Decision

### Add a median stage before the exponential filter

The pipeline becomes **median → One Euro → saccade gate → clamp**.

A 3-tap median discards an isolated bad frame outright, at a cost of one frame
of latency (~33 ms at 30 fps). Width is configurable (1 disables, 5 is stronger
and laggier). The median runs *before* One Euro specifically so spikes never
reach the speed estimator.

### Make the clamp radius adapt to measured noise

We maintain a rolling estimate of gaze spread over the last ~15 frames and size
the clamp to it:

```
radius = clamp( noise_scale × spread, floor, ceiling )
        with noise_scale = 2.5, floor = 22 px, ceiling = 70 px
```

The ceiling matters: without it, a patch of bad tracking would inflate the
radius until the cursor froze across a large region.

The spread is measured on the **pre-smoothing** signal, because the smoothed
signal has already had the noise removed and would understate it.

### Spread is a trimmed percentile range, not a MAD

The obvious robust estimator is median absolute deviation. It has a degenerate
case that matters here: for a signal oscillating between two values, most
samples sit *exactly* at the median, so MAD reports **zero** — "no noise" for a
signal that is entirely noise.

We use half the 15th-to-85th percentile range instead. It keeps the outlier
resistance that motivated MAD (a single catastrophic frame is trimmed away) with
no degenerate case. This is covered by a test that a MAD implementation fails.

### Retuned defaults

| Parameter | Was | Now | Why |
| --------- | --- | --- | --- |
| `clamp_radius` | 14 px | 22 px | now a floor, not the operating value |
| `min_cutoff` | 1.0 Hz | 0.6 Hz | more smoothing at rest |
| `median_window` | — | 3 | spike rejection |

### Surface the measurement

The HUD shows **measured gaze spread** and the **clamp radius in use**. This
turns "it's shaky" from a guess into a diagnosis: a large spread is a *tracking*
problem (lighting, camera, distance) that no filter setting will fix, while a
small spread with a jittery cursor is a *filter* problem.

## Consequences

### What this buys us

- The clamp engages for users whose noise made it unreachable — the reported bug.
- Precision is preserved for users with clean signals, because the radius stays
  at its floor.
- Isolated tracking failures no longer propagate through the filter.
- The HUD distinguishes tracking noise from filter tuning.

### What this costs us

- One frame of latency from the median, on top of the filter's own lag.
- More filter state, and a radius that changes over time — "why did it feel
  different just now" becomes a legitimate question. The HUD readout is the
  answer.
- The adaptation could in principle chase its own tail (a large radius holds the
  cursor still, which lowers measured spread). It does not in practice, because
  spread is measured pre-smoothing and pre-clamp.

### What we would need to see to revisit this

- Users reporting the cursor freezing over too large an area, implying the
  ceiling or `noise_scale` is wrong.
- Spread measurements so large that the honest answer is "this camera cannot do
  this", which would justify a hard quality gate rather than more filtering.
