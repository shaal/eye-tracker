# ADR-0013: Wink mode, and resolving which eye is which

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

ADR-0008 shipped blink-as-click and named its central weakness plainly:
involuntary blinks. The only discriminator available to that design is
*duration*, and the distributions of natural and deliberate blinks overlap. In
practice users must push `min_close_ms` up until deliberate blinks become
tiring, and some false clicks survive anyway.

There is a structurally better gesture. **An involuntary blink closes both
eyes.** A wink closes one. Requiring one eye shut *and the other open* rejects
involuntary blinks on a categorical property rather than a threshold — a far
stronger test than any duration window can be.

It also opens up a right-click, which blink mode has no way to express.

The obstacle is that ADR-0005 deliberately made the pipeline **symmetric under
an eye swap**, precisely so that MediaPipe's ambiguous left/right naming could
not cause a subtle bug. Wink mode requires the opposite: left and right must map
to specific mouse buttons, so the ambiguity has to be resolved rather than
sidestepped.

## Decision

### Two click modes, selectable at runtime

| Mode | Gesture | Result |
| ---- | ------- | ------ |
| `Blink` (default) | both eyes, one blink | left click |
| | both eyes, two blinks in the window | double click |
| `Wink` | left eye | left click |
| | left eye twice in the window | double click |
| | right eye | **right click** |

In wink mode a two-eye blink produces **nothing at all** — not a click that is
filtered out later, but a gesture the detector cannot even represent.

### Detection: derive a wink signal, then reuse the existing machine

Rather than a second state machine with its own thresholds, each eye gets a
derived signal that is zero unless a genuine wink is in progress:

```
wink_signal(closed, other) =
    0                     if other >= open_thresh          // both eyes shut
    0                     if closed - other < asymmetry    // too ambiguous
    closed                otherwise
```

That feeds the same hysteresis/duration FSM from ADR-0008, so wink detection
inherits its debouncing for free.

**The asymmetry margin is the part that makes this usable in practice.** Most
people cannot wink cleanly — the other eye squints. A literal "one shut, one
open" test rejects most real winks. Requiring the *gap* to exceed
`wink_asymmetry` (default 0.28) accepts a squinting companion eye while still
rejecting a sloppy two-eye blink.

Because the asymmetry test already excludes involuntary blinks, winks get their
own, more permissive duration window: `wink_min_close_ms` 120 ms (versus 150 ms
for blinks) and `wink_max_close_ms` 900 ms, since winks are commonly held
longer.

### Right-click does not wait

Only the left wink participates in double-click detection, so a right wink fires
immediately. Making right-click wait out a 500 ms window it can never use would
be pure latency.

### The cursor still freezes during a wink

A wink occludes one iris, and that eye contributes to the averaged gaze signal
(ADR-0005), so the estimate is corrupted just as it is during a blink. The
freeze channel therefore runs on `max(left, right)` — any eyelid down — while
the blink channel runs on `min`. Pre-blink anchoring (ADR-0008) applies
unchanged.

### Switching modes resets gesture state

A closure that began under one mode must not resolve into a click under the
other. Changing mode clears every channel.

### Resolving left from right

Two independent sources, used where each is trustworthy:

- **Blendshapes** (`eyeBlinkLeft` / `eyeBlinkRight`) follow ARKit's convention,
  which is defined in the *subject's* frame. Used directly.
- **Geometry**, for the EAR fallback which has no names: in an unmirrored frame
  the subject faces the camera, so their **left eye appears at the larger image
  x**. Resolved by comparing eye-centre x at runtime.

Neither is trustworthy if the camera mirrors its frames in hardware, which some
do. So there is a **`swapEyes` setting**, and a **wink test** in the UI: two
lamps that light using the same asymmetry test the detector uses. The user winks
and sees immediately whether the sides are right.

Crucially, **gaze remains symmetric**. Only the closure channels are
left/right-resolved, so a wrong `swapEyes` setting cannot degrade tracking — it
can only swap which button fires, which is visible and instantly correctable.

## Consequences

### What this buys us

- A gesture that rejects involuntary blinks structurally rather than
  statistically — the single biggest UX risk in the project (R1).
- Right-click, which blink mode cannot express.
- Right-click with no latency penalty.

### What this costs us

- Not everyone can wink, and fewer can wink both eyes independently. Blink mode
  remains the default and is not going away.
- The asymmetry threshold is a new tuning knob, and it is the one users will
  need when winks "don't register".
- Left/right resolution now matters, so a mirrored camera has a visible
  consequence. Mitigated by the wink test rather than by hoping.

### What we would need to see to revisit this

- Users failing the wink test on both settings, implying the closure signal
  itself is not separating the eyes.
- Demand for more gestures (middle click, drag), which would justify a general
  gesture-to-action binding table rather than two hard-coded modes.
