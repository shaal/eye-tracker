# ADR-0019: Select the ridge λ by held-out target, not by GCV

- **Status:** Accepted
- **Date:** 2026-07-25
- **Supersedes:** the λ-selection decision in [ADR-0006](0006-gaze-mapping-ridge-regression.md). The rest of that ADR — ridge regression, the feature tiers, the standardization, the Gram-matrix formulation — stands unchanged.

## Context

ADR-0006 chose generalized cross-validation to pick the ridge parameter, on the
grounds that GCV is cheap: with precomputed Gram statistics a 41-point λ grid
costs 41 small matrix inversions rather than 41 passes over the data.

That reasoning was sound. The criterion was not.

A calibration profile captured from real hardware showed the failure plainly:

| | |
|---|---|
| samples / targets | 253 / 13 |
| tier | full (18 features) |
| λ/n chosen | **5.6 × 10⁻⁶** — near the floor of a grid spanning 10⁻⁸ … 10² |
| worst coefficient | **3180 px per SD**, on a 1329 px-tall screen |
| held-out error | 478 px (21.1°) |
| centre-target error | 89 px |

The coefficient table is the tell:

| feature | βx (px/SD) | βy |
|---|---|---|
| `gy·pitch` | **+2390** | −3180 |
| `pitch` | **+2144** | −2839 |
| `hy` | **−1988** | +2933 |
| `gx` — the actual horizontal signal | +2036 | +249 |

Head-pose terms were driving the *horizontal* prediction as strongly as
horizontal gaze itself, with single-standard-deviation swings larger than the
display. The model had learned "where the user is sitting" rather than "where
the user is looking". The centre target — the best-conditioned one — was fine at
89 px while the periphery ran to 702 px, which is the classic signature.

**Why GCV could not see it.** GCV assumes independent observations. A
calibration set is emphatically not that: roughly twenty consecutive frames of
one fixation are near-identical measurements of a single event. Handing GCV
`n = 253` when the data contains **13** independent observations overstates the
sample size by about twenty-fold, and GCV spends that phantom evidence on
flexibility — choosing far too little shrinkage. No criterion scored on the
training set can detect this, because the correlated samples make the training
fit look genuinely excellent.

This is not a tuning problem. It is a category error about what an observation
is.

## Decision

**Select λ by leave-one-target-out cross-validation.** For each candidate λ,
refit with each target held out in turn and score the prediction on the held-out
fixation; pick the λ with the lowest held-out error, then refit on everything.

The held-out fixation shares no frames with its training set, so a λ that only
looks good by memorizing fixations scores badly — which is exactly the failure
mode GCV was blind to.

### Kept: the Gram-matrix formulation

The cost argument from ADR-0006 still applies, one level down. Each fold's
normal equations are built **once** and the λ grid is scanned over them, so the
O(n·p²) accumulation happens once per fold rather than once per (fold, λ) pair.
For 13 folds and 41 λ values that is 13 accumulations and 533 small solves of an
18×18 system — microseconds, on an operation the user waits for once.

### λ is scored per axis

Vertical iris travel is routinely about half of horizontal, because the eyelids
crop the iris exactly as the eye rotates up and down. The weaker axis genuinely
needs more shrinkage, so the two axes keep independent λ rather than sharing one
that splits the difference.

### GCV survives as a fallback, corrected

Runs with too few targets to hold one out still use GCV — but scored against the
**target count** rather than the sample count. That does not make it a good
criterion; it makes it a wrong criterion that at least errs toward more
shrinkage instead of less.

### The reported error uses the chosen λ

The leave-one-target-out folds that produce the accuracy figure now refit with
the same λ the shipped model uses, rather than re-selecting per fold. Otherwise
the report describes a model the user never receives.

## Consequences

### What this fixes

Weak signals now degrade into a conservative, heavily-shrunk model instead of an
explosive one. That matters most for exactly the users who need it: someone
sitting too far from the camera gets a sluggish cursor that is roughly right,
rather than one that flings across the screen when they shift in their chair.

### What it does not fix

**Regularization cannot un-confound the data.** If head pose correlates with
target position across the fixation grid — and it does, because people lean
toward whatever they are looking at — then head pose really is a valid predictor
*within that data*, and no fitter should be expected to reject it.

Writing the tests made this concrete. An early version of
`head_terms_do_not_dominate_when_the_head_motion_phase_runs` omitted the
head-motion targets and failed, correctly: with a gaze SNR of ~3 and head pose
perfectly correlated to target, head pose *is* the better predictor. Preferring
it is the right answer to the wrong question. Breaking that correlation is the
job of the head-motion phase (ADR-0015), not of λ. The test now includes those
targets, and in doing so verifies the protocol and the fit together.

### Cost

A calibration fit goes from ~82 small solves to ~533 plus 13 Gram
accumulations. Unmeasurable against the several-second collection it follows.

### The under-regularization was invisible without a diagnostic

Worth recording: this bug survived because the reported held-out error was the
only signal, and "478 px" reads as "bad calibration, try again". It took the
per-axis scatter and the saved model's coefficient table (ADR-0018) to show that
the *fit* was broken rather than the *data*. The diagnostics paid for themselves
on their first real use.
