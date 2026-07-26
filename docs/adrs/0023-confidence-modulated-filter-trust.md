# ADR-0023: Tracking confidence modulates the filter continuously

- **Status:** Accepted
- **Date:** 2026-07-25
- **Amends:** [ADR-0007](0007-cursor-smoothing.md) and
  [ADR-0014](0014-adaptive-fixation-stability.md). The three-stage pipeline, the
  One Euro formulation, the saccade gate and the spread-adaptive clamp all stand
  unchanged; this ADR changes only how strongly each stage is applied to a given
  frame.
- **Sibling of:** [ADR-0021](0021-quality-weighted-calibration-fit.md), which did
  the same thing on the calibration side. Together they are the whole of "stop
  rounding a continuous confidence down to one bit".

## Context

`estimateQuality()` produces a continuous 0..1 confidence per frame. The filter
consulted it not at all.

The only thing standing between quality and the cursor was
`GuardConfig::min_quality`, a **cliff**. Above it a frame drove the cursor at
full strength; below it the guard fired and control stopped entirely. A frame at
0.41 was trusted exactly as much as one at 0.99, and a frame at 0.39 was
discarded completely.

That boundary is not somewhere quality sits still. It is somewhere quality
*drifts across*, repeatedly, as the user shifts posture or the light changes —
and drifting across a cliff produces the worst behaviour available: the cursor
driven hard by an increasingly unreliable estimate, then frozen, then resumed,
then driven hard again. Each of those transitions is discontinuous, and the user
experiences the whole sequence as the tracker breaking rather than as the
tracker being honest about a degrading signal.

Meanwhile the filter was making its decisions — how hard to smooth, how far to
let the cursor rest, what counts as a real saccade — from the *shape* of the
signal alone. The spread estimator (ADR-0014) can answer "how much is this
signal moving". It cannot answer "and is any of that real", which is exactly
what the number we were throwing away says.

## Decision

`FilterPipeline::update()` takes a **confidence scalar**, and one derived trust
value modulates all three adaptive stages.

The `min_quality` guard is untouched and remains the floor. This ADR is about
the region above it.

### One scalar, bounded, identity on confidence

```
trust = clamp(confidence, trust_floor, 1)      trust_floor = 0.35
```

Deliberately the identity on confidence rather than `c²` or `1/σ²` — the same
choice ADR-0021 made for calibration weights, for the same reason. Today's
confidence is a heuristic score, not a calibrated measurement of prediction
variance, and a bounded monotone map is as much as it can honestly support.
Anything steeper is inventing precision the input does not have.

One scalar rather than three, because "the cursor feels different today" needs
to have one answer, not three interacting ones. The floor bounds all three
modulations simultaneously: nothing can be smoothed, widened or gated by more
than `1 / trust_floor` relative to a fully-trusted frame.

The floor sits just below the default `min_quality` of 0.4, so at stock settings
it is inert — every frame the guard admits is modulated by its own quality, and
the widest possible spread between two admitted frames is **2.5:1**, the same
bound ADR-0021 places on calibration weights. The floor starts to bite only for a
user who has loosened the gate, which is exactly when an unbounded discount would
be dangerous. It is also structurally required rather than merely prudent: two of
the three modulations divide by trust, and a floor of zero would send the saccade
threshold and the clamp radius to infinity. A hard minimum of 0.1 is enforced in
the pipeline itself, so a live config patch (ADR-0004) cannot do that by accident.

### The three modulations

| Stage | Modulation | Direction |
|---|---|---|
| One Euro cutoff | `(min_cutoff + β·\|dx̂\|) · trust` | distrust → smoother, laggier |
| Fixation clamp radius | `radius / trust`, capped | distrust → rests more readily |
| Saccade gate | `saccade_px / trust` | distrust → needs a bigger jump |

**One Euro.** A lower cutoff is more lag and less jitter, which is the correct
trade when the measurement is unreliable: the estimate is worth less, so weight
it less against the filter's own history.

Both terms of the cutoff are scaled, not just `min_cutoff`. This is the one place
the obvious implementation is measurably wrong. Scaling only the resting term
barely does anything at exactly the noise levels this exists for — with ±14 px of
jitter at 60 Hz the β term alone contributes several Hz, swamping a 0.6 Hz resting
cutoff, and the measured effect on residual cursor travel was 14%. Scaling the
whole cutoff gives 46% on the same signal. The principled statement is the same
as the empirical one: that speed estimate is computed from the position we have
just declared unreliable, so widening the filter on the strength of it is the
pathology ADR-0014 identified for spikes ("a spike also inflates its speed
estimate and temporarily raises the cutoff, reducing smoothing exactly when it is
most needed") arriving by a slower route. Distrust in a measurement is distrust
in its derivative.

**Fixation clamp.** ADR-0014 sizes the radius to measured spread. Confidence adds
the orthogonal question the spread estimator cannot answer, so an uncertain
signal is treated as resting more readily rather than chased around. The widening
is bounded below by the unmodulated radius (it can only ever widen) and above by
`clamp_radius_max` — that ceiling exists precisely so a patch of bad tracking
cannot freeze the cursor across a large region, and bad tracking is when this
modulation is active, so it would be perverse to let distrust escape it.

**Saccade gate.** A distrusted frame must jump further to be believed. A briefly
mislocalized iris produces exactly the signature of a saccade, and the gate is
the one stage with no recovery: it discards the filter state that would otherwise
have absorbed the error, then teleports the cursor to the wrong place. Raising
its bar under distrust is the difference between a wrong answer and a late one.

This is **the parameter most likely to want retuning against real hardware**, and
it is called out here so that is a known open question rather than a surprise. At
the default gate the threshold reaches 300 px, and a genuine 250 px saccade at
quality 0.4 will therefore glide at reduced bandwidth instead of teleporting. We
judge that the honest failure mode — at 0.4 the tracker is at the guard's edge,
and a late cursor beats a confident jump to a position we have just declared
unreliable — but it is a judgement made against synthetic signals, and #2 has yet
to produce a real-hardware baseline to check it against.

It is retunable from the Tuning panel without a rebuild (ADR-0004), from both
ends: `saccade_px` sets the fully-trusted threshold, and `trust_floor` bounds how
far distrust may raise it (at 0.7 the widening cannot exceed 1.43×; at 1.0 it is
disabled entirely). The slider hint names the saccade threshold explicitly so the
connection is discoverable from the UI rather than only from this ADR.

Note that the three compose in a consistent direction. A distrusted frame is
smoothed harder, is more likely to be held still, and is less able to teleport —
all three say "this frame moves the cursor less", which is what makes the
combined behaviour predictable rather than merely tuned.

### `β` is scaled, `d_cutoff` and the median are not

`d_cutoff` governs how the *speed estimate itself* is smoothed. Modulating it
would change what "speed" means from frame to frame, which is a second-order
effect with no clear sign. The median window is an integer count of frames and
has nothing continuous to modulate; it is also already the stage that handles the
isolated-spike case best.

### Confidence is source-agnostic, by construction

`update()` takes an `f64` and nothing else. It does not take a `GazeFrame`, a
quality struct, or anything that names where the number came from, and the module
is documented as not being allowed to grow such a dependency.

This is not tidiness. Issue #34 replaces `estimateQuality()`'s four hardcoded
constants with a learned per-frame predicted variance, and that swap has to be a
one-line change at the call site in `engine.rs` rather than a rewrite of the
filter. The same constraint is what makes the IMM/Kalman estimator of #35
reachable later: a per-frame variance *is* the measurement noise covariance `R`,
and the plumbing that carries it now already exists.

The corollary is that the pipeline must treat the scalar as untrusted input. It
is clamped, and a NaN lands on the floor rather than propagating into a cursor
position — hence `max`/`min` rather than `clamp`, which panics on a NaN bound and
propagates a NaN input.

### Switchable, and default on

`FilterConfig::confidence_trust` (default `true`) turns the whole thing off,
restoring the pre-ADR-0023 pipeline *exactly* — not approximately. `trust_floor`
is a slider, and setting it to 1.0 is a continuous way to reach the same place.

Defaulting it on rests on the same three arguments ADR-0021 made: the change is
bounded (2.5:1 at the default gate), it is in the direction of the evidence in
every case where it does anything, and off-by-default means nobody would ever run
it — a flag nobody runs is not an A/B, it is dead code.

## Consequences

### What this buys us

The cliff becomes a ramp. Quality drifting from 0.9 to 0.45 now produces a
progressively steadier, progressively laggier cursor instead of an unchanged one
followed by a freeze. Degradation that the user can feel coming is degradation
they can respond to — by sitting up, or moving the lamp.

It also puts the plumbing in place for #34 and #35, which is most of why the
signature is what it is.

### What it costs us

Lag, exactly when the signal is worst. That is the trade being made deliberately,
but it is worth stating plainly: a user whose tracking sits at 0.5 all session
now has a noticeably slower cursor than before this change, and "it feels
sluggish" is a legitimate report that this ADR is the cause of. The HUD already
shows tracking quality, which is the first thing to read when that happens; the
tuning playbook routes it to `trustFloor`.

More honestly still: it adds a *third* thing `quality` controls, after the guard
and (since ADR-0021) the calibration fit. A badly-calibrated `estimateQuality()`
now degrades the experience in three ways rather than one. The bounded map, the
floor, and the switch are what keep that from being alarming — and #34 is the
real answer.

### What we deliberately did not do

- **Remove or soften the `min_quality` guard.** Continuous trust handles the
  region above the floor. Below it the honest answer is still "we do not know
  where you are looking", and a filter cannot manufacture that knowledge.
- **Feed confidence into the median.** See above.
- **Make trust asymmetric or hysteretic.** Tempting, since quality drifting
  across a boundary is the motivating problem — but the whole point of a
  continuous map is that there is no longer a boundary to hysterese around.

### The regression guard

`full_confidence_reproduces_the_unmodulated_pipeline_bit_for_bit` runs 600 frames
of jitter, spikes, gate-tripping target changes and non-uniform frame intervals
through both configurations and compares output positions, clamp radius, clamp
state and gate verdict **by bit pattern** at every frame.

`x · 1.0 == x` and `x / 1.0 == x` are exact in IEEE 754, so equality is a
property of the code rather than luck — and a tolerance would pass just as
happily if the modulated path had introduced a real-but-small bias, which is the
defect that would otherwise surface months later as "the cursor feels slightly
different" with nothing to point at. The disabled pipeline is handed a *low*
confidence in that same run, so it also proves the A/B switch ignores confidence
entirely rather than merely damping it.

The rest of the filter suite is the other half of the guard: every pre-existing
test now runs through the modulated path at confidence 1.0, and none of their
assertions moved.

### What we would need to see to revisit this

- Reports of sluggishness that track tracking quality, which would say the
  modulation is too steep rather than that the idea is wrong — `trust_floor` is
  the first knob, and a sub-linear map the next step.
- A real-hardware baseline (#2) showing the widened saccade gate holding back
  genuine mid-range saccades at moderate quality. That would argue for a gentler
  form on the gate alone — `saccade_px · (2 − trust)` rather than
  `saccade_px / trust` — at the cost of the single-scalar property this design is
  built on, which is why it is not the starting point.
- A learned per-frame variance good enough to justify a real `1/σ²`
  Kalman-style gain (#34, #35), at which point this bounded heuristic map becomes
  the wrong shape and the whole filter stack is up for replacement anyway.
