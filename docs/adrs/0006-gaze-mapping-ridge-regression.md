# ADR-0006: Gaze→screen mapping by regularized polynomial regression

- **Status:** Accepted (λ selection superseded in part by [ADR-0019](0019-lambda-by-held-out-target.md))
- **Date:** 2026-07-24

## Context

Given the feature vector from ADR-0005, we need a function to screen
coordinates. Two families of approach:

**Geometric (model-based).** Reconstruct the optical axis of the eye in 3D,
correct for the kappa angle between optical and visual axes, and intersect with
the screen plane. This is what commercial IR trackers do. It requires knowing
the camera intrinsics, the camera's pose relative to the screen, and the user's
corneal geometry. On an arbitrary laptop with an unknown webcam, every one of
those is unknown, and errors in them compound.

**Regression (appearance-based).** Learn a direct map from features to screen
coordinates from a handful of calibration points. It absorbs camera intrinsics,
camera-to-screen geometry, seating distance, and the user's personal kappa angle
*simultaneously and implicitly*, because all of them are constant during a
session and therefore fold into the fitted coefficients.

For an uncalibrated consumer webcam the regression approach wins decisively.
The remaining question is which regression.

A pure linear map is not enough: the relationship between iris offset and screen
position is close to a tangent, noticeably nonlinear past ~15° eccentricity. A
full quadratic in all features has too many terms for 5–9 calibration points.
And there is a specific statistical trap: **with a stationary head during
calibration, the head-pose features have near-zero variance**, so their
coefficients are fit almost entirely to noise and then multiplied by large
values the moment the user moves. An unregularized fit produces a tracker that
is accurate until you shift in your seat, then flies off screen.

## Decision

Fit **two independent ridge regressions** — one for screen *x*, one for screen
*y* — over a hand-designed feature expansion, directly to **screen coordinates
in logical (DIP) pixels**.

### Design matrix

```
φ = [ gx, gy,                            // linear gaze
      gx², gy², gx·gy,                   // quadratic — the tangent-like curvature
      yaw, pitch, roll,                  // head rotation
      hx, hy, hz,                        // head translation
      gx·yaw, gy·pitch,                  // gaze/rotation coupling
      gx·hx,  gy·hy,                     // gaze/translation coupling
      gx·hz,  gy·hz,                     // gaze/distance coupling
      dgx ]                              // vergence
```

18 explicit terms. There is deliberately **no constant column**: the intercept
is handled by centering the targets during the fit, so the model has 19 degrees
of freedom in total. Doing it this way avoids the awkward special case of an
unpenalized column inside an otherwise penalized ridge solve.

The cross terms are the ones that buy head tolerance: the screen position
corresponding to a given iris offset genuinely *does* depend on where the head
is, and it does so multiplicatively, not additively.

### Regularization is not optional

Solve the normal equations with Tikhonov regularization:

```
β = (ΦᵀΦ + λI)⁻¹ Φᵀ y
```

with features **standardized to zero mean and unit variance first**, so a single
λ is meaningful across features with wildly different scales. The intercept is
not penalized.

λ is selected per fit by **generalized cross-validation** over a log-spaced grid,
rather than hard-coded — the right λ depends on how much the user's head moved
during calibration, which we cannot know in advance.

This directly solves the near-zero-variance problem: a feature that barely moved
during calibration has a tiny standardized variance, so ridge shrinks its
coefficient toward zero, and the model degrades gracefully to "ignore head pose"
rather than "extrapolate wildly from noise."

### Adaptive feature tiers

The design matrix is selected from the data actually collected:

| Tier    | Terms | Selected when                                        |
| ------- | ----- | ---------------------------------------------------- |
| `BASIC` | 5     | fewer than 9 targets, or fewer than 150 samples      |
| `FULL`  | 18    | 9-point calibration with at least 150 samples        |

Tier selection is by *data volume*, not by measured head variance — because
degenerate head-pose columns are already handled automatically upstream. A
feature whose standard deviation falls below `1e-9` is assigned a scale of 1.0,
which after centering leaves the column at ~0, and ridge then drives its
coefficient to exactly zero. So "the user sat perfectly still" needs no special
case: it falls out of standardization plus regularization. The tier system only
has to handle the genuinely different problem of too few distinct fixation
locations to identify 18 parameters.

### Solver

Hand-rolled **Cholesky decomposition** in `src/math/linalg.rs`. The matrix is
p×p where p is the explicit feature count — **18×18** at the `FULL` tier, 5×5 at
`BASIC` — and symmetric positive-definite by construction (ΦᵀΦ is PSD, +λI with
λ>0 makes it PD), so Cholesky is both the fastest and the numerically right
choice. (The intercept adds a 19th degree of freedom but no column, since it is
handled by centering.) At this size it is ~40 lines and a few microseconds, which is not worth
a linear algebra dependency in a module we want to compile fast and audit fully.

### Calibration protocol

Per target: 600 ms of animated shrink to draw fixation, then 700 ms of sample
collection with the first 200 ms discarded as saccade/settle time. Samples are
rejected if a blink is in progress or tracking quality is low, and surviving
samples are outlier-filtered by median-absolute-deviation on `gx`/`gy`.

Targets sit at 10 %/50 %/90 % of the work area (9-point) or 15 %/50 %/85 %
(5-point) — inset from the edge, because gaze near the physical screen border is
both unreliable and unnecessary.

### Reporting accuracy honestly

After fitting we run **leave-one-target-out cross-validation**: refit the model
9 times, each time holding out one target, and report the mean held-out error in
pixels and in approximate degrees of visual angle. This is the number shown to
the user, because training error on a ridge fit is meaningless as an accuracy
estimate.

### Calibration is bound to a display configuration

Because we regress directly to screen pixels, the fit encodes the display
geometry. We fingerprint the display layout (ids, bounds, scale factors) into
the saved profile, and invalidate the calibration when `screen` reports a
change. Recalibration after plugging in a monitor is correct behavior, not a bug.

## Consequences

### What this buys us

- Camera intrinsics, screen geometry, seating distance, and personal eye
  anatomy are absorbed by a 1–2 minute procedure instead of a measurement rig.
- Ridge + standardization makes head-movement robustness degrade smoothly
  instead of catastrophically.
- The user gets a trustworthy accuracy number instead of an optimistic one.

### What this costs us

- Calibration is mandatory. There is no useful uncalibrated mode; before
  calibration we can show a raw gaze indicator but cannot drive the cursor.
- The model is only valid near the head pose region it was calibrated in.
  Large posture changes need a recalibration, or a future multi-pose model.
- Regressing to screen pixels ties a profile to a display layout.

### What we would need to see to revisit this

- Held-out error consistently above ~2° after a good 9-point calibration, which
  would suggest the feature set, not the regressor, is the limit.
- A need for cross-session persistence robust to posture change, which points
  toward a small MLP or a per-pose mixture of local models.
