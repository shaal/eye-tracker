# ADR-0025: Vertical gaze is measured against the lid aperture, not the eye-corner box

- **Status:** Superseded in part — **the aperture basis now defaults off** (#62).
  The mechanism, the switches, the capacity argument, the profile guard and the
  `verticalRangeFraction` metric all stand. Only the default changed. See
  [Measured outcome](#measured-outcome) below.
- **Date:** 2026-07-25
- **Amends:** [ADR-0005](0005-roll-invariant-iris-features.md). The eye-local
  basis, the eye-width normalizer, and the A/B symmetry construction all stand
  unchanged. This ADR changes the **origin of the vertical component only**, and
  adds two optional feature columns to the expansion of
  [ADR-0006](0006-gaze-mapping-ridge-regression.md).

## Context

ADR-0005 defines both gaze components against the same origin:

```text
c  = (p_in + p_out) / 2              // eye-corner midpoint
gx = dot(iris − c, u) / w
gy = dot(iris − c, v) / w
```

That origin is right for `gx` and wrong for `gy`, and the asymmetry is
geometric rather than a matter of taste.

**The horizontal case.** The eye corners are the ends of the palpebral fissure.
Horizontal eye rotation moves the iris between them and moves nothing else, so
the corner midpoint is a fixed landmark on the axis of motion. ADR-0005's
roll-invariance argument — that the basis rotates with the head because it is
built from the head — is sound and unaffected by anything below. Horizontal
works: #57 measured ~64% of screen range recovered.

**The vertical case.** The corner midpoint is anchored to the eye socket and
**does not move when the eyelid moves**. But with a camera above the screen,
looking down the screen is looking down relative to the camera, and the upper
lid comes down across the iris as it goes. Three things then happen at once:

1. the iris centre descends;
2. the upper lid margin descends with it, until it comes to rest on the cornea
   and stops;
3. in strong downgaze the lower lid margin is pushed *up* by the globe, so the
   fissure narrows to a slit.

The landmark model does not report the true iris centre — it reports a fit to
the iris it can *see*. Once the lids are clipping the disc, that estimate tracks
the visible crescent, and the visible crescent tracks the aperture. Past the
point where the upper lid stalls, the aperture centre moves back *up* while true
gaze keeps going down.

The result is not a loss of gain. It is a **fold**: `gy` rises with downgaze,
turns over, and comes back. Two different screen rows produce the same `gy`, so
no function of `gy` can distinguish them. Ridge regression responds correctly —
the best available model of a folded predictor is its mean — which is exactly
what #57 measured:

| target y | predicted y |
| -------: | ----------: |
|      239 |         369 |
|      664 |         380 |
|     1090 |         393 |

**851 px of target range, 24 px of predicted range: 3% of the screen.** `λ_y =
675` against `λ_x = 12` is cross-validation saying the same thing a second way.
`gy` travel of 1.252 — more than twice the ~0.5 a full screen sweep can
physically produce — says the variance is there and is not about screen y.

The simulation in `features.test.ts` reproduces this from the geometry above
with no free parameters beyond ordinary anatomy: over a sweep from the top of
the screen to the bottom, corner-relative `gy` reverses a third of the way
through and gives back 23% of its range, while aperture-relative `gy` stays
strictly monotone over a 1.44× wider span.

## Decision

### Stage 2 — the vertical origin becomes the lid aperture

```text
upper   = midpoint of the two upper-lid landmarks
lower   = midpoint of the two lower-lid landmarks
a       = (upper + lower) / 2               // aperture centre
gyAp    = dot(iris − a, v) / w
```

Same basis vector `v`, same normalizer `w`, different origin. All three
ADR-0005 invariants survive by construction and are asserted in
`features.test.ts`: the projection onto `v` keeps roll invariance, dividing by
`w` keeps scale invariance, and the per-eye mean keeps A/B swap symmetry.

`gx` stays on the corner basis. Nothing above applies to it.

This is a **geometric un-fold, not a statistical patch**. When the lid drops,
both the visible iris blob and the aperture centre move; the corner midpoint
does not. Referencing the aperture makes the two motions cancel.

The six lid landmarks already existed — `EyeLandmarks.ear` used them to compute
openness and then discarded their positions, so only their *ratio* survived and
upper-lid position, the thing that actually occludes, was inseparable from
lower.

### Stage 1 — openness, and its interaction with `gy`

Two columns, appended to the `Full` expansion:

```text
o  = clamp(min(open_left, open_right) / open_ref, 0, 2)
φ += [ o, gy·o ]
```

- **`min`, not the mean**, because occlusion risk is set by the more occluded
  eye: `gy` is already an average of two eyes, so one covered iris corrupts half
  the signal however open the other eye is.
- **Normalized by a calibration-time 90th percentile**, not by raw EAR and not
  by a single maximum. Raw EAR varies by roughly a factor of two across people
  and with camera distance, so a coefficient on it would be partly a
  coefficient on face shape. The maximum is one frame out of ~180 and the EAR is
  built from landmark positions, so it picks up isolated spikes; the 90th
  percentile leaves eighteen frames above it to absorb them. The reference is
  stored on the model, because a coefficient on `o` is uninterpretable without
  the scale `o` was divided by.
- **The interaction is the point.** An additive `o` alone only says "a more
  closed eye shifts the cursor by a constant", which cannot undo a
  non-monotonic mapping. `gy·o` says openness changes what `gy` *means*.
- **Not `eyeBlink*`.** Those are the blendshapes the click FSM runs on; using
  them here would couple every micro-blink into the cursor position.

Only the `Full` tier takes these. `Basic` exists precisely because a 5-point run
has too few distinct fixations to identify the terms it already omits, and
spending two more of them on openness would be the same mistake in a new place.

### The axis-specific expansion

Four columns can be dropped from the **vertical** fit: `gx`, `roll`, `gx·yaw`
and `dgx`. All four carry horizontal information with little to say about screen
y — `gx` and `gx·yaw` are odd in horizontal gaze, `dgx` is a vergence proxy, and
`roll` is already compensated by construction in ADR-0005's eye-local basis.

`gx²` and `gx·gy` are deliberately kept: they are even and mixed in horizontal
gaze respectively, and both encode real geometric coupling between where you
look horizontally and where the screen point is vertically.

Implemented by gathering the axis' submatrix of the shared Gram matrix once and
scanning λ over it, so the two axes still share one design matrix and one
standardizer. Coefficients for dropped columns come back as exact zeros, which
is what lets `predict` stay oblivious to any of this.

### Capacity is a constraint, not a footnote

The effective sample size is **≈ 9 targets, not ~180 frames** — ADR-0019 already
establishes that a fixation is one observation however many frames it
contributed. The design matrix was already 18 columns wide. `λ_y = 675` is
cross-validation saying the vertical signal is not there *in the current
coordinates*, not that it needs more terms.

So stage 1 adds **at most two** columns and stage 2 adds **none at all** — it
changes what an existing column is measured from. That asymmetry is why the two
default differently.

### Defaults, and why they differ

| Switch                   | Default | Why                                                                                                                                                 |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apertureVertical`       | **on**  | A geometric correction that costs no capacity. It is the fix.                                                                                          |
| `opennessTerms`          | off     | Two columns out of a nine-target budget. This is the hypothesis test of #59 stage 1, and it should be paid for only if stage 2 is not enough.           |
| `axisSpecificVertical`   | off     | A capacity bet rather than a geometric correction, and unmeasured on hardware. The switch exists so #2's recorded sessions can answer it without a change. |

Each is independently switchable at runtime through the existing calibration
tuning group, following the pattern of [ADR-0021](0021-quality-weighted-calibration-fit.md)
and [ADR-0023](0023-confidence-modulated-filter-trust.md), and each has a
bit-for-bit regression test proving that "off" leaves the previous arithmetic
untouched rather than merely close to it.

### Both bases cross the IPC boundary

`GY_APERTURE` is a new frame slot next to `GY`, not a replacement for it. The
renderer computes both every frame — two dot products — and the Rust side picks.
That buys three things: the switch is a refit rather than a rebuild; the switch
lives in one place instead of being mirrored between a renderer setting and an
engine config; and a session recorded today can answer the question offline for
either basis.

The frame width moves 16 → 17 in `frame-layout.ts` and, by hand, in `frame.rs`,
which asserts it on every frame (ADR-0009).

### Stored profiles are self-describing, and refuse to be reinterpreted

The vertical basis changes the *meaning* of a column without changing the length
of any vector. A profile fitted on corner-relative `gy` would therefore load
happily against aperture-relative frames and simply predict the wrong place —
no error anywhere, and indistinguishable from ordinary drift.

So a saved profile carries `featureVersion`, `verticalBasis` and `openRef`, and
`predict` uses the semantics recorded on the model rather than whatever the
session is configured for now. A profile without those fields **is** version 1 —
that is what their absence means, not a default we picked — and version 1 is
exactly corner-relative `gy` with no openness terms, so profiles saved before
this ADR keep working unchanged. A version this build does not understand is
refused with a message rather than loaded optimistically.

### The metric

`CalibrationReport` gains `verticalRangeFraction`: the predicted vertical spread
over the calibration targets, as a fraction of the targets' own spread, computed
per target from each target's mean prediction.

This is the number #57 asked to have reported, and it is more diagnostic than
mean error. Collapse and bias produce similar mean errors and completely
different signatures: `ŷ = y + c` still spans the screen, `ŷ ≈ c` spans nothing.
It leads the calibration section of the diagnostics bundle, above the fit's own
error line.

Two states have to be legible there, not one. The calibration section describes
the **stored profile** — what it was fitted with. The A/B switch block describes
**what the engine is set to now**, and a switch takes effect only on the next
calibration. Those routinely disagree, because flipping a switch and then reading
the existing numbers is the obvious thing to do and does not work. When they
disagree the summary says so in as many words, next to the numbers it
invalidates, and names recalibration as the fix. A reader who assumed they agreed
would attribute the numbers to the wrong mode, which would make the very A/B this
ADR exists to enable produce a confident wrong answer.

Every key in `AB_SWITCH_KEYS` now prints in the text summary, asserted by test.
A switch that is declared A/B-able and never reaches the summary is one the
reader cannot attribute the numbers to — the same failure as #48, one step
further downstream.

## Consequences

### What this buys us

- The vertical channel stops being folded by the eyelid, which is the difference
  between a signal a polynomial can invert and one it cannot.
- Two more feature columns are *available* without being spent by default.
- The failure mode that motivated this has a number attached to it, so the next
  session can say whether it moved rather than whether it felt better.

### What this costs us

- **The aperture reference is not free when the lid is nowhere near the iris.**
  With the eye wide open there is no lid-driven displacement to cancel, and the
  aperture centre is then lid noise added to a signal that did not need it. A
  test in `features.test.ts` pins the regime where it pays — a squint deep
  enough to occlude the iris moves the aperture reference less than half as far
  as the corner one — and its doc comment names the regime where it does not.
  This is the main reason the reference is a switch rather than a replacement,
  and the main thing to watch for on hardware: a user who never squints and sits
  square to a well-placed camera may measure slightly *worse*.
- One more `f64` per frame across the IPC boundary, and one more hand-mirrored
  constant between `frame-layout.ts` and `frame.rs`.
- Two more knobs that a support conversation may have to ask about. The
  diagnostics bundle hoists all three into `abSwitches` for exactly that reason.
- The MAD outlier filter and the debug scatter now both need to know which basis
  is in play, since filtering on a feature the fit does not use would be a
  quieter version of the same class of bug. One helper (`basis_of`) is the single
  place that decides.

## Measured outcome

The first hardware session met the first revisit criterion below on the first
try, and by a wide margin.

| | corner basis (9 targets) | aperture basis (13 targets) |
| --- | --- | --- |
| `verticalRangeFraction` | 0.03 | **0.007** |
| λ_y | 675 | **20106** |
| fitted `gy` sensitivity | 416 px/unit | **0 px/unit** |

Predicted y by target row on the aperture basis: 607.7, 609.2, 608.3, 608.8,
608.0, 608.1, 608.3. **851 px of target span produced 1 px of predicted span.**
The vertical model is exactly an intercept.

### Why: the lid does not lag, it tracks

This ADR's premise was that the upper lid *lags* the globe and then stalls on
the cornea, so referencing the aperture removes the lid's contribution and
leaves a residual proportional to gaze.

Healthy lid–globe gain is close to **1**. Upper-lid kinematics during vertical
gaze essentially replicate the eye's — Becker & Fuchs (*J Neurophysiol*, 1988)
find eye and lid take essentially the same average position during fixation,
with downward lid saccades matching eye amplitude and velocity closely. Lag and
attenuation are what appear as *pathology*, not as the healthy default. So:

```
measured_iris_v  ≈  g + occlusion_bias(lid)
aperture_v       ≈  k·g + lid_noise            (k ≈ 1)
gy_aperture      ≈  (1−k)·g + noise            ≈  lid_noise
```

The aperture reference does not un-fold the signal. It **cancels** it. The
measurement agrees: `gy` travel came out at 1.459 against `gx` travel of 0.496
— three times the horizontal excursion, on a screen that is wider than it is
tall. That is what an excellent blink sensor looks like.

### What the simulation got wrong, and the lesson

The synthetic test was not sloppy. It used the *area* centroid of a clipped
disc rather than the visible band's midpoint — specifically so the aperture
feature could not come out identically zero and make the comparison vacuous —
and its constants were derived anatomy (0.24 eye-widths of iris excursion for
the ~35° a laptop screen subtends on a 12 mm globe).

It still misled, because it encoded the **pathological lid regime** the fix was
designed for rather than the healthy one. Every assertion about the arithmetic
held; the premise underneath was never tested.

**A well-built simulation of the wrong regime is more convincing than a sloppy
one, and therefore more dangerous.** Validating a model's arithmetic is not
validating its premise, and the test suite has no way to tell the difference.
This is the argument for measuring on hardware before promoting a default, not
after.

### What was kept

The default flipped; nothing else did. The mechanism is still correct where the
premise holds — a camera mounted *below* the screen reverses the occlusion
geometry, and a user who genuinely squints has a residual to recover. Both
bases are still packed into every frame, so this remains a refit rather than a
rebuild, and the switch is now an option with a known failure mode instead of a
default with an untested premise.

The synthetic test is retained as a guard on that option, with both bases named
explicitly rather than taken from the default, so flipping the default can
never again silently change what it asserts.

### What this did not break

The same session improved on every other axis, though it also used 13
calibration targets rather than 9, so the causes should not be conflated:
horizontal range 64% → 78%, precision ±26 px (0.57°) → ±8 px (0.17°), noise
floor ±12 px → ±4 px, and `gx` travel 1.204 → 0.496 — finally matching the ~0.5
physical prior in `debug/eye-zoom.ts`.

### What we would need to see to revisit this

- ~~A hardware session where `apertureVertical` **off** produces a larger
  `verticalRangeFraction` than **on**.~~ **Met — see above. Default is now off.**
- `verticalRangeFraction` still low with the aperture basis on. The remaining
  candidates from #57 are then the collection regime rather than the features:
  the user pitching their head instead of elevating their eyes (make pose the
  primary vertical channel and `gy` the residual), or the head-motion phase of
  ADR-0015 swamping the elevation coefficient.
- A measured win from `opennessTerms` large enough to justify two of nine
  observations. If it is marginal, it should stay off — the capacity is worth
  more elsewhere.

Explicitly **not** revisited by this ADR, and rejected in #59 with reasons:
fitting a circle to the visible iris arc (ill-conditioned at a 12–25 px iris on
1080p, and worst exactly in the occluded region this exists to fix),
`eyeLookUp*`/`eyeLookDown*` blendshapes (ARKit *animation* coefficients, with
large per-person baselines, saturation and expression coupling), landmark `z`,
and the translation column of the 4×4 transform (collinear with `hx`/`hy`/`hz`).
