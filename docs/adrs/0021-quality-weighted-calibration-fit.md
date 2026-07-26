# ADR-0021: Tracking quality weights the calibration fit

- **Status:** Accepted
- **Date:** 2026-07-25
- **Amends:** [ADR-0006](0006-gaze-mapping-ridge-regression.md). The regressor,
  the feature tiers, the Gram-matrix formulation and the λ selection of
  [ADR-0019](0019-lambda-by-held-out-target.md) all stand unchanged; this ADR
  changes only what each collected sample is worth to the fit.

## Context

`estimateQuality()` produces a continuous 0..1 confidence per frame, from
interocular distance, |yaw|, |pitch| and lid openness. Everything downstream
then rounded it to one bit.

Three call sites, all thresholds: the guard refuses to drive the cursor below
`min_quality`, the calibration collector refuses to record a sample below
`min_quality`, and nothing else consults it at all. A grep for `weight` across
the Rust core returned nothing.

So a calibration sample collected at 0.95 and one scraped in at 0.41 had exactly
the same say in the fitted model. That is the wrong way round twice over. The
marginal sample — head turned, eye half-closed, user sitting far back — is
precisely the one whose association with the target on screen is least
trustworthy, because every one of those conditions degrades the *iris estimate*
while the *label* stays confidently attached. And it is the one most likely to
be a frame where the user was not really looking at the dot yet.

We were computing the information and discarding it.

## Decision

Fit **weighted** ridge regression, with tracking quality as the weight.

The Gram formulation makes this nearly free. The accumulation becomes

```
G = ΦᵀWΦ      c = ΦᵀWy      yy = yᵀWy
```

with `W` diagonal — one extra multiply per row. Everything downstream reads only
`G`, `c` and `yy`, so the standardizer, the 41-point λ grid, the effective-DoF
trace and the held-out-target λ search need no changes whatsoever.

### The weight is quality, floored, and nothing cleverer

`w = clamp(quality, floor, 1)`, `floor = 0.25`.

Deliberately the identity on quality rather than `quality²` or an inverse
variance: `quality` is a heuristic score, not a calibrated measurement of
prediction variance, and a monotone bounded map is as much as it can honestly
support. Anything steeper would be inventing precision the input does not have.

The floor exists because a weight of zero *deletes* a sample, and deletion is
not what we mean. Admission was already decided by `min_quality`; anything
reaching the fit has been judged usable, and the fit should not silently
overrule that. With the default gate at 0.4 the floor never binds and the widest
possible ratio between two admitted samples is 2.5:1 — this is a nudge, not a
re-selection. The floor starts to matter only for a user who has loosened the
gate, which is exactly the situation where an unbounded discount would be
dangerous: at a gate of 0.1, an unfloored weighting could let a whole target
evaporate and take the model's ability to reach that corner of the screen
with it.

### Standardization is weighted too

`mean = Σwx / Σw`, `var = Σw(x−mean)² / Σw`. Standardizing with unweighted
moments while fitting with weighted ones would centre each column on a point the
fit does not sit at, and since ridge penalizes coefficients *relative to that
centre*, the bias would not stay cosmetic.

Dividing by Σw rather than the unbiased `Σw − Σw²/Σw` is deliberate: it makes
each standardized column's weighted variance exactly 1, hence `diag(G) = Σw`,
which is the invariant the λ grid rides on.

### Which "n": three quantities that used to be one

This is the part that is easy to get silently wrong, so it is written down.

| Where `n` appeared | Now | Why |
|---|---|---|
| Standardizer moments, target centering | **Σw** | These are weighted averages; Σw is their normalizer by definition. |
| λ scale, `λ = ratio · n` | **Σw** | `ratio` exists to make λ commensurate with `diag(G)`, and `diag(G) = Σw`. |
| GCV denominator | **effective target count** | An evidence measure, and ADR-0019 already established the unit is fixations, not frames. |
| `MIN_SAMPLES`, reported sample count | **raw n** | Structural, not statistical: how many rows the design matrix has. |

The λ row is the one that most invites the wrong answer. Kish's effective count
`n_eff = (Σw)²/Σw²` is the textbook "effective sample size", and it is tempting
to substitute it everywhere `n` appeared. For λ that would be a category error.
`ratio` is a *scale* relating the penalty to the data term, not a count; and
because `n_eff ≤ Σw` with equality only under uniform weights, using it would
*reduce* shrinkage exactly when the weights spread out — that is, apply less
regularization to weaker data. Backwards.

Scaling λ by Σw also buys a property worth having on its own: multiplying every
weight by a constant scales `G`, `c` and `yy` together, so it cancels out of β
completely — but only if λ scales with it too. A user whose tracking sat at 0.5
all session is therefore fitted identically to one at 1.0, rather than being
handed twice the regularization for a reason unconnected to their data.

Where an effective count genuinely belongs — the GCV fallback denominator — it
is applied at the level ADR-0019 established as the unit of independent
observation. A fixation is one observation however many frames it contributed,
so the count is Kish's formula over each target's *mean* weight: a target
collected entirely at poor quality is worth less than a whole observation, while
a target that merely contributed more frames is still worth exactly one. Uniform
weights give back the integer target count exactly.

### Switchable, and default on

`CalibrationConfig::quality_weighting` (default `true`) turns the whole thing
off, restoring the unweighted fit *exactly* — not approximately. Defaulting it
on is a judgement call, and rests on three things:

1. The change is bounded. At the default gate no sample can outweigh another by
   more than 2.5:1, and a uniformly-good session — the common case — is fitted
   identically to before.
2. It is in the direction of the evidence in every case where it does anything.
3. Off-by-default means nobody would ever run it, and a flag nobody runs is not
   an A/B, it is dead code.

The switch is there so a real regression can be attributed and reverted in one
config patch rather than a rebuild, per ADR-0004.

### The report says what the weights did

`CalibrationReport` gains `mean_weight`, `min_weight`, `effective_samples`
(Kish's `n_eff` over the sample weights) and the `quality_weighted` flag, and the
calibration card shows them: *"Sample quality: mean 0.86, worst 0.45 — worth 231
of 260 frames"*.

This is not decoration. ADR-0019 closes on the observation that the
under-regularization bug survived because held-out error was the only visible
signal, and "478 px" reads as "bad calibration, try again". `n_eff` versus the
frame count separates "your fit is poor" from "your *session* was poor", which
are different problems with different fixes — the second one is solved by moving
the lamp, not by recalibrating.

## Consequences

### What this buys us

The cheapest accuracy improvement available, using information the pipeline
already computes. A user who drifted out of position for part of the calibration
now gets a model that leans on the part where they were sitting properly.

It is also the plumbing a learned per-frame uncertainty would feed into later:
the fit now has a place to put a number that says "trust this frame less", and
whatever produces that number can be replaced without touching the fitter.

### What it costs us

One multiply per (sample, feature) pair in the Gram accumulation — unmeasurable
against the several-second collection it follows.

More honestly: it adds a second thing `quality` controls, so a badly-calibrated
`estimateQuality()` now degrades accuracy in two ways rather than one. The floor
and the bounded weight range are what keep that from being alarming.

### What we deliberately did not weight

- **Pose statistics.** `pose_mean`/`pose_std` stay unweighted. They answer "how
  much did your head actually move while you calibrated", which is a fact about
  the session rather than about how much the fit trusted each frame, and
  `pose_drift` compares live pose against them to decide whether the user has
  left the region the model ever saw.
- **The reported error.** The held-out error shown to the user counts every
  frame equally. It answers "how far off will this be in practice", and a
  weighted accuracy figure would flatter the model by scoring it mostly on the
  frames it liked.
- **But the λ criterion is weighted**, because λ is a parameter of the weighted
  estimator and should be tuned against the risk that estimator minimizes.
  Scoring it unweighted would let the frames the fit deliberately discounts come
  back and choose its shrinkage.

### The regression guard

`uniform_weights_reproduce_the_unweighted_fit_bit_for_bit` compares every
coefficient, both intercepts, both λ, the standardizer and the whole error
report between weighting-on and weighting-off, by bit pattern rather than by
tolerance. `1.0 · x == x` exactly in IEEE 754 and a sum of n ones is exactly n,
so equality is a property of the code rather than luck — and a tolerance would
pass just as happily if the weighted path had introduced a real-but-small bias,
which is the defect that would otherwise surface months later as "calibration
feels slightly off" with nothing to point at.

The rest of the fit's test suite is the other half of the guard: every existing
test runs frames at quality 1.0 through the now-weighted path with weighting on
by default, and none of their assertions moved.

### What we would need to see to revisit this

- Held-out error consistently *worse* with weighting on across several real
  sessions, which would say `estimateQuality()` is not measuring what we think.
- A per-frame uncertainty good enough to justify `w = 1/σ²` rather than a
  bounded heuristic map, at which point the floor becomes the wrong shape.
