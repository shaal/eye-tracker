# ADR-0005: Roll-invariant, scale-free iris feature vector

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

The naive gaze feature is the iris center's raw position in the frame. It is
useless on its own: move your head 2 cm to the left without moving your eyes and
it changes more than a 20° gaze shift does.

The standard fix is to express the iris position *relative to the eye corners*.
But the obvious implementation — dividing by the eye's axis-aligned bounding box
— has two residual couplings that quietly cost accuracy:

- **Head roll.** Tilt your head 15° and the eye's bounding box changes shape,
  so a purely horizontal eye movement produces a vertical feature change.
- **Distance to camera.** Lean in and every pixel distance scales.

There is also a subtler trap. MediaPipe's landmark groups are conventionally
named "left" and "right", but sources disagree on whether that means the
subject's left or the viewer's left, and the answer flips again depending on
whether the video element is CSS-mirrored. Getting this backwards does not
crash — it produces a tracker that works but is subtly worse, because the two
eyes' features are swapped relative to the blendshape scores. That is an
expensive bug to find.

## Decision

### Normalize in the eye's own frame

For each eye, build an orthonormal basis from its own corner landmarks:

```
p_in, p_out          inner and outer corner landmarks
u  = normalize(p_out - p_in)        // along the eye's long axis
v  = perp(u)                        // rotate u by 90°
c  = (p_in + p_out) / 2             // eye center
w  = |p_out - p_in|                 // eye width, in frame units

gx = dot(iris - c, u) / w           // horizontal gaze, dimensionless
gy = dot(iris - c, v) / w           // vertical gaze, dimensionless
```

Projecting onto the eye's own axis makes `gx`/`gy` **invariant to head roll**,
because the basis rotates with the head. Dividing by `w` makes them **invariant
to camera distance and frame resolution**. The result is a pure, dimensionless
measure of where the iris sits within its socket — which is what gaze direction
actually is.

### Defuse the left/right trap by construction

We do not rely on the naming being right. The pipeline is built so that swapping
the two eyes is harmless:

- **Gaze** uses the mean of the two eyes, `gx = (gxA + gxB) / 2`. Symmetric.
- **Vergence** uses `|gxA − gxB|`. Symmetric under swap because of the absolute
  value.
- **Blink** uses `min(blinkA, blinkB)` to require both eyes (ADR-0008).
  Symmetric.

The only asymmetric consumer is the per-eye debug HUD, where an inversion is
visible and harmless. Landmark index constants are additionally named
`EYE_A`/`EYE_B` rather than left/right, so no one can be misled into assuming a
semantics we do not guarantee.

### The frame is never mirrored for the model

The video element is CSS-mirrored for display (users expect a mirror), but
landmarks are always consumed in raw, unmirrored frame coordinates. Mirroring is
a presentation concern and does not cross into the estimator. The calibration
regression (ADR-0006) learns the sign of the screen mapping from data, so we
never hand-code a flip.

### Full feature vector

Per frame, the extractor emits:

| Symbol       | Meaning                                             |
| ------------ | --------------------------------------------------- |
| `gx`, `gy`   | mean normalized iris offset — the primary gaze signal |
| `dgx`        | abs(gxA − gxB), vergence proxy for fixation depth   |
| `yaw,pitch,roll` | head rotation, from the 4×4 transformation matrix |
| `hx`, `hy`   | head position in frame (nose tip, centered)         |
| `hz`         | inverse interocular distance — distance proxy       |
| `oA`, `oB`   | per-eye openness (height/width), for blink fallback  |
| `blinkA/B`   | blendshape closure scores                            |
| `quality`    | 0–1 tracking confidence                              |

`hz` is the *inverse* interocular distance rather than the distance itself
because it is closer to linear in physical distance, which matters for a model
that is only quadratic (ADR-0006).

## Consequences

### What this buys us

- Head roll and camera distance stop leaking into the gaze signal, so the
  regression in ADR-0006 has less nuisance variance to absorb.
- A whole class of left/right bugs is made structurally impossible rather than
  merely tested against.

### What this costs us

- We discard per-eye asymmetry in the primary gaze signal. A user with a
  divergent eye would be better served by a dominant-eye mode, which we do not
  yet have.
- `w` is a 2D projected width, so it still shrinks at extreme head yaw. The yaw
  term in the regression is what absorbs the remainder.

### What we would need to see to revisit this

- Measured accuracy loss for users with strabismus or a strong dominant eye,
  which would justify a per-eye model with a dominance weight.
