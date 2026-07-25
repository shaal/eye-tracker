# ADR-0015: Head-motion calibration phase and pose-drift reporting

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

First real session, reported symptom: *"I calibrated while staring straight into
the screen, so when turning my head it sometimes works and sometimes doesn't."*

That is not a bug — it is ADR-0006 working exactly as designed, and the design
being insufficient.

The model includes head-compensation terms (`yaw`, `pitch`, `hx`, `hy`, `hz`,
and gaze×head cross terms) precisely so that head movement can be tolerated. But
ridge regression can only fit a coefficient if the corresponding feature
*varies* across the training data. A user who holds still during calibration
produces head-pose columns with near-zero variance. Standardization gives those
columns a scale of ~1.0 and a centred value of ~0, and ridge drives their
coefficients to exactly zero.

So the fitted model contains **no head compensation at all**. It is a pure
gaze→screen map valid at one pose. ADR-0006 called this "graceful degradation",
and it is — the model does not explode, it simply ignores head pose. But
graceful degradation is not the same as working, and the user has no way to know
which they got.

The intermittency is explained too: small head movements stay within the region
where a pose-blind model is approximately right; larger ones do not.

## Decision

### Add an explicit head-motion phase to calibration

After the standard 9-point grid, four additional targets are shown where the
instruction changes from "keep your head still" to:

| Target | Prompt |
| ------ | ------ |
| centre | turn your head slowly left and right |
| left-mid | turn your head slowly left and right |
| right-mid | nod slowly up and down |
| upper-centre | lean slightly closer, then back |

These targets sample for **2.6 s** each rather than 700 ms, because the user is
sweeping through a range of poses rather than holding one.

They are spread across the screen rather than all at centre deliberately: the
cross terms model *gaze direction interacting with head pose*, so the fit needs
head movement observed at several different gaze directions. Four targets at the
same point would give head variance but no interaction variance.

This adds roughly 15 s to calibration. It is on by default, and can be turned
off.

### Record head-pose statistics in the model

The fit stores `pose_mean` and `pose_std` (yaw, pitch, roll, hx, hy, hz) over
the calibration set. These are cheap, and they answer two questions the system
previously could not:

**1. Does this model contain head compensation?** If the rotation spread is
below ~3°, it does not. The UI says so explicitly rather than leaving the user
to discover it by moving their head:

> *This calibration has no head compensation — your head barely moved while
> calibrating. Recalibrate with the head-motion phase enabled to fix that.*

**2. Is the user currently near the pose they calibrated at?** Per frame we
report

```
pose_drift = max over pose features of |current − mean| / max(std, floor)
```

in standard deviations. Above ~3 the model is extrapolating. The HUD shows this
continuously, which turns "it worked a moment ago" from a mystery into a
readable number.

The per-feature floors matter: a user who sat perfectly still has `std ≈ 0`, and
without a floor every small movement would divide by almost nothing and report
enormous drift.

## Consequences

### What this buys us

- Head tolerance becomes something the model actually contains, rather than a
  capability that exists in the feature set but is never fitted.
- The user is told when their calibration lacks head compensation, at the moment
  it matters, instead of inferring it from erratic behaviour.
- Pose drift is visible, so degradation has a cause the user can see and act on.

### What this costs us

- Calibration is ~15 s longer, and the head-motion phase is more demanding —
  holding gaze on a fixed point while moving your head is not natural, and some
  users will do it badly, which pollutes the fit rather than improving it.
- More parameters to fit means more data needed; the head-motion targets are
  what supply it, so skipping them while expecting head tolerance is now an
  explicitly reported condition rather than a silent one.
- `pose_mean`/`pose_std` extend the persisted profile format.

### What we would need to see to revisit this

- Held-out error *worse* with the head-motion phase than without, which would
  mean users are not fixating reliably during it and the extra samples are noise.
- Demand for pose tolerance well beyond what a single quadratic model can
  express, which points to a mixture of local models, one per head-pose cluster.
