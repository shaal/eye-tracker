# ADR-0008: Blink FSM, click arbiter, and pre-blink anchoring

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

The requirement is: single blink → left click, double blink within 400–600 ms →
double click.

There is a problem with this that has to be stated plainly, because it shapes
the design: **humans blink involuntarily 15–20 times per minute.** A literal
implementation clicks roughly every three seconds, unprompted. This is not a
tuning detail — it is the central design constraint of blink-as-click, and every
working system in this space solves it the same way, by requiring a blink that
is *distinguishable from a natural one*.

The distinguishing signal is duration. Natural blinks are 100–150 ms of full
closure. A deliberate blink is comfortably 200–400 ms. The distributions overlap
at the edges but are separable enough to be usable.

A second problem: the eyelid crossing the pupil corrupts the gaze estimate for
the entire closure. Naively clicking at blink-end means clicking wherever the
corrupted estimate drifted to — typically below the intended target.

A third: any single-blink click must wait out the double-blink window before it
can be confident it is not the first half of a double. That latency is inherent
to the gesture, not to the implementation.

## Decision

### Signal

Per frame, `closure = min(blinkA, blinkB)` from MediaPipe blendshapes
(ADR-0003). Taking the **minimum requires both eyes to be closed**, which
rejects winks, one-sided landmark noise, and partial occlusions. When
blendshapes are unavailable we fall back to a normalized eye-aspect ratio, with
thresholds calibrated at rest during the first second of tracking.

### State machine

```
        closure > close_thresh (0.55)
  OPEN ─────────────────────────────────► CLOSED
    ▲                                        │
    │  closure < open_thresh (0.35)          │  held > max_close_ms
    │  and dwell ∈ [min_close_ms,            │
    │               max_close_ms]            ▼
    │       → emit Blink{onset}          LONG_CLOSE
    └────────────────────────────────────────┘
              closure < open_thresh (no event)
```

- **Asymmetric thresholds (0.55 to close, 0.35 to open) are hysteresis.** A
  single threshold produces a burst of events when the signal sits on it.
- **`min_close_ms` (default 150 ms)** is the involuntary-blink rejector. Raising
  it to ~200 ms nearly eliminates accidental clicks at the cost of requiring a
  more deliberate gesture; it is the single most important user-facing tuning
  knob and is surfaced prominently in settings, not buried.
- **`max_close_ms` (default 500 ms)** routes longer closures to `LONG_CLOSE`,
  which emits no click. Resting your eyes does not click. `LONG_CLOSE` is also
  surfaced as an event so it can later be bound to a gesture such as
  suspend-tracking.

### Click arbiter

Blink events feed a separate arbiter that resolves single vs. double:

- Blink arrives with no pending blink → record it as pending, start a
  `double_window_ms` (default 500 ms, range 400–600) deadline.
- Blink arrives while one is pending, within the window → emit **double click**,
  clear pending.
- Pending deadline expires with no second blink → emit **single left click**.
- After any emitted click, a **250 ms refractory period** during which blinks
  are discarded, so a trailing natural blink cannot cascade.

The consequence is explicit: **single clicks are delayed by up to
`double_window_ms`.** This is intrinsic — you cannot know a blink was solitary
until the window for a second one has passed. Users who do not need
double-click can set `double_window_ms = 0`, which makes single clicks fire
immediately and disables double-click entirely. That trade is exposed in the UI.

### Pre-blink anchoring

The engine keeps a ring buffer of `(timestamp, x, y)` for the last ~1 s of
smoothed cursor positions. When a click is emitted, the click coordinate is the
buffered position at **`blink_onset − 150 ms`**, not the current position.

This is the difference between a tracker that clicks where you looked and one
that clicks slightly below it. Combined with the blink freeze in ADR-0007, the
cursor also does not visibly lurch during the blink.

### Gating

A click is only synthesized when all hold: control enabled; a calibration is
loaded; the face has been tracked continuously for ≥ 300 ms; quality above
threshold; and at least 300 ms have elapsed since control was enabled, so
toggling on cannot itself produce a click.

## Consequences

### What this buys us

- Involuntary blinks are rejected by a mechanism that matches the physiology,
  with one knob the user can tighten.
- Clicks land at the pre-blink gaze position.
- Long closures are usable rather than dangerous.

### What this costs us

- Single-click latency of up to `double_window_ms`. Unavoidable for this gesture.
- Users with unusually long natural blinks will get false clicks until they
  raise `min_close_ms`. First-run should measure the user's natural blink
  duration and suggest a threshold; until it does, the default is a compromise.
- Requiring both eyes means a user who cannot close both symmetrically is not
  served. A wink mode is a straightforward future addition.

### What we would need to see to revisit this

- False-click rates that stay high even at `min_close_ms = 250 ms`, which would
  push us toward dwell-to-click (fixate N ms on a target) as the primary gesture
  with blink as a secondary.
