# ADR-0018: Diagnostics that separate signal quality from mapping error

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

Real-hardware sessions produce one recurring report: *"it's not very accurate
and it doesn't always follow where I'm looking."* The app had no way to answer
it. Everything it showed the user was either downstream of the problem (a
jittering cursor) or a single collapsed scalar (`quality`, `poseDrift`,
`meanErrorDeg`) that names a symptom without naming a cause.

The specific gap: **there was no way to tell an input-signal problem from a
mapping problem.** Those have completely different fixes, and the app was
implicitly recommending the wrong one. The calibration report ends with "Try
again: sit squarely, keep the room evenly lit" — advice that is useless if the
camera physically cannot resolve the user's iris well enough, and which the user
will nevertheless follow four or five times before giving up.

Two pieces of arithmetic frame the whole problem.

**1. The gaze signal is only a couple of pixels wide.** At 1280×720 and normal
seating distance the eye is ~115 px corner to corner. `gx` is the iris offset
divided by that width (ADR-0005), and across a full screen sweep the iris only
travels about ±25% of the eye width — roughly ±29 px. So one pixel of iris
localisation error is ~3.5% of the entire usable range, which on a 1920-wide
screen is about **70 px of cursor error per pixel of landmark wobble**. Whether
the pipeline can work at all is decided at the sensor, and nothing downstream
can recover what is not there.

**2. Calibration's own error figure cannot detect this.** `fit()` reports
leave-one-target-out cross-validation, which is honest as far as it goes, but it
scores only the nine locations it trained on, using the same fixation data the
fit already saw. It cannot distinguish "the model generalises poorly" from "the
input never separated the targets".

## Decision

Add a debug panel to the control window with six views, ordered so that each one
rules out a cause before the next is worth looking at. Two supporting principles
run through all of them.

### Principle 1: never report accuracy and precision as one number

Every error figure is split into two:

- **accuracy** — how far the *mean* estimate sits from the target. Systematic.
  Fixed by recalibrating or by a bias offset.
- **precision** — how much the estimate scatters around its own mean. Random.
  Recalibrating cannot touch it; only light, distance, sensor, or smoothing can.

A single blended "error" sends the user to the wrong remedy roughly half the
time. `summarizeValidation` therefore measures scatter about the **cloud
centroid**, not about the target, so a large bias cannot inflate the precision
figure. This is asserted directly in `stats.test.ts`.

### Principle 2: measure the noise floor from quiet periods only

A plain standard deviation of `gx` over a few seconds is dominated by whatever
saccades fell in the window, so it measures reading behaviour rather than the
sensor. `SignalStats` instead computes a short-window (~0.5 s) spread every
frame, keeps ~10 s of those, and reports the **20th percentile**: the calmest
fifth of the recent past is when the user actually held a fixation, and only
those moments say anything about the noise floor.

### The six views

| # | View | Rules out |
|---|------|-----------|
| 1 | **Eye zoom** — each eye magnified with the iris rim, eyelid contour and basis drawn on it, plus noise floor, signal travel and resolvable-step count | the sensor cannot resolve gaze at all |
| 2 | **Signal scope** — raw and filtered traces on one time axis, with clamp holds and low-quality frames shaded | sensor noise vs. smoothing lag vs. a stuck fixation clamp, which all *feel* identical |
| 3 | **Validation** — 13 fresh points the model was not fitted to, rendered as bias arrows and dispersion ellipses | that the reported calibration error was optimistic |
| 4 | **Live probe** — a parked dot with a live offset readout | "it worked ten minutes ago"; isolates which change broke it |
| 5 | **Calibration scatter** — every sample in (gx, gy) space, coloured by target | that the fit was ever possible: overlapping clusters mean no regression can help |
| 6 | **Pose drift per axis** — the engine's worst-axis σ broken out into six | which axis to correct; "sit up" and "stop turning" are different instructions |

### Instruction cards, and the keys that dismiss them

The head-motion prompts used to appear as small text at the bottom of the screen
*while the target was already collecting*. That is not merely awkward — a
head-motion target samples for 2.6 s, so a second spent reading is a third of
that target's samples taken with a stationary head, and ridge then correctly
shrinks the very cross-terms the phase exists to identify.

Each phase now opens with a full-screen card: short imperative headline, the
eyes-on-the-dot constraint underneath, a countdown bar, and **no dot** — showing
one would reintroduce the split attention being fixed.

A card is shown only when the instruction **changes**, so the nine fixation dots
share one card rather than getting nine identical ones. Repeated cards train
users to dismiss without reading, which would cost them the head-motion cards
that actually carry new information.

Three interactions dismiss or abort:

- **Space / Return** and **a click anywhere** skip the current card.
- **Escape** aborts the whole run, in any phase, including validation.

Skipping is restricted to the `instruct` phase. Allowing it to skip `settle` or
`collect` would let an impatient user produce a calibration that looks complete
and is quietly worse — precisely the failure this effort exists to eliminate.

Two mechanism notes, both consequences of the overlay being `focusable: false`
and click-through by design (ADR-0002):

- **The keys are global shortcuts**, because during a run the user is looking at
  the overlay while keyboard focus is wherever it happened to be. Escape is held
  for the whole run; Space and Return only while a card is up, since they are
  ordinary keys other apps want and there is no reason to hold them for the full
  forty seconds.
- **Click requires making the overlay non-click-through**, which is the single
  most dangerous flag in the app: the overlay spans the whole desktop, so while
  it is interactive *nothing on the machine is clickable*. It is therefore
  derived from the phase at exactly one call site — the calibration emit path —
  so finishing, cancelling, Escape, and a failed fit all restore it without any
  of them needing to remember to. A 12-second watchdog and a `will-quit` handler
  are the second and third nets.

### Validation is measurement only, never mutation

A validation run never touches the collector or the model — it only watches what
the engine already predicts. That is what makes it safe to re-run freely, and it
is why the runner lives in `EngineBridge` (TypeScript) rather than in the Rust
core: it needs no state the engine does not already emit per frame.

Its targets are deliberately offset from the calibration grid (0.10/0.50/0.90),
because testing at the points you trained on measures memorisation rather than
generalisation. The centre is the one shared location, kept on purpose: a large
error *there* means something no recalibration will fix. Target order is fixed
but scrambled so consecutive dots are never adjacent — a predictable sweep lets
the user anticipate and start the saccade early, and a spatially ordered one
would let slow drift over the run masquerade as a spatial error pattern.

## Consequences

### What this costs

- **Three new engine surfaces.** `calibration_scatter()` (the collector is
  consumed by `finish_calibration`, so the scatter is captured *before* the fit
  runs — a failed calibration is exactly when you want to see it),
  `predict_frame()` (stateless, so the panel can finite-difference the model's
  local gain without reimplementing `expand()` in TypeScript and letting the two
  drift), and `quality` on `FrameOutput` (the guard reports only its first
  blocking reason, so while control is disabled it says so and hides a quality
  problem entirely).
- **Landmarks now reach the renderer's debug code.** They stay renderer-local
  and never cross IPC — far too large for the per-frame path (ADR-0009).
- **A second `POSE_STD_FLOOR`,** hand-mirrored into `calibration/protocol.ts`
  for the per-axis breakdown. Duplicated constants drift; this one is
  display-only, and the alternative was widening the napi surface for six
  numbers.
- **A test runner for the TypeScript packages.** Node's built-in `node --test`
  over compiled `dist`, so no new dependency.

### What we deliberately did not do

- **No session recording or offline refitting.** It would answer more questions
  but is a much larger surface, and the six views above cover the diagnoses that
  actually come up.
- **No proper covariance ellipse** in the error map — axis-aligned ±1 SD is
  enough, because the extra rigour would not change any decision a user makes
  from that picture.
- **No automatic bias correction** from the probe or the validation run. The
  data is there and it is tempting, but a correction applied on top of a model
  the user cannot inspect is exactly the kind of confidently-wrong behaviour
  ADR-0011 exists to avoid.

### The debug panel is collapsed by default

It answers "why is this inaccurate", which is not a question you have every
session, and its draw work is skipped entirely while closed.
