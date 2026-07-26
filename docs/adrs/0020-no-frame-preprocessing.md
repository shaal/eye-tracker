# ADR-0020: No super-resolution or denoising before landmark detection

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

The gaze signal really is only a few pixels wide, and this is not a rhetorical
complaint — it is arithmetic that `debug/eye-zoom.ts` works through in its own
docstring. At 1280×720 and a normal seating distance the eye is about **115 px
corner to corner**, and across a full screen sweep the iris centre travels
roughly ±25% of that. Since `gx` divides the iris offset by the eye width, one
pixel of iris localisation error is `1/115 ≈ 0.0087` in `gx` — **about 1.7% of
the entire usable range, or ~33 px of cursor error on a 1920-wide screen.**

So the instinct is well-founded: pixel-level error is a first-order term here,
not a rounding detail. Which makes "the image is noisy and small, so denoise or
upscale it before detection" the obvious next move. It has been proposed, and it
will be proposed again — by us, by a contributor, or by an assistant reading the
repo and noticing how thin the signal is.

It is a bad move for five separate reasons, and they do not all fail at once,
which is why this is worth a record rather than a code comment.

## Decision

**Frames reach `FaceLandmarker.detectForVideo()` exactly as the camera
delivered them.** No super-resolution, no learned denoiser, no sharpening, no
unsharp mask, no temporal accumulation between `getUserMedia` and inference.

The only transform applied to the video anywhere is the CSS mirror on the
preview, which is a presentation concern and never reaches the model or the
feature extractor (ADR-0005).

### 1. The bottleneck is downstream, not in the pixels

`extractFeatures()` reduces the eye region to **two numbers**, `gx` and `gy`,
and both are derived from a single estimated point: MediaPipe's iris centroid
(landmark 468 or 473, per ADR-0003). The eye corners set the basis and the
scale; the lid landmarks produce an openness ratio for blink fallback. For
*gaze* — the thing accuracy is actually about — everything else in the image is
discarded. The whole frame leaves the renderer as a `Float64Array(16)`
(ADR-0009).

Improving the input to a stage that then throws away nearly all of it does not
help. This is an information-bottleneck problem, and the fix is to widen the
bottleneck, not to polish what feeds it. That is issue #33's job (a learned
appearance model over the eye crop), and it is a different decision with a
different cost structure.

### 2. Hallucination is strictly worse than blur

A generative upsampler asked for a sharper iris returns a *plausible* iris
boundary, not the true one. That is not a smaller error than blur — it is a
worse kind of error.

A soft or under-sampled image gives the landmarker less to work with, and the
error that results decomposes into two parts the pipeline already handles. The
frame-to-frame part is largely zero-mean jitter, which is exactly what the
downstream stack is built to average down: the median pre-filter and self-tuning
clamp (ADR-0014), the One Euro filter (ADR-0007), and the quiet-period
noise-floor estimator that characterises it (ADR-0018). Whatever part is roughly
static for a given user, camera and seating position is absorbed by the per-user
ridge calibration, which exists precisely to soak up offsets we cannot measure
directly (ADR-0006).

A hallucinated boundary is a different animal: a confident,
**condition-dependent bias**. It is a function of the model's prior and of the
scene, so it is correlated across frames — averaging does not touch it — and it
moves when the lighting, the expression or the screen content moves.

The second property is the damaging one, and it is worth being precise about
why. By ADR-0018's taxonomy this error is *systematic*: it displaces the mean,
so it lands in the **accuracy** bucket, and the precision figure — scatter
measured about the cloud centroid rather than the target — will not show it
within a run held at roughly constant conditions. That much is a correct
classification. The problem is what ADR-0018's accuracy bucket promises:
systematic error is *"fixed by recalibrating or by a bias offset"*. A bias that
varies with conditions breaks that promise. The diagnostic would file the error
in the right drawer and still send the user to a remedy that cannot work —
recalibrate, then recalibrate again, against an error that shifts every time the
room does. A diagnostic that misroutes confidently is worse than one that says
nothing.

### 3. Distribution shift, and un-attributable regressions

FaceLandmarker was trained on natural camera images. Its iris refinement
submodel **already crops and upscales the eye region itself** — that is why iris
centres are more stable than a 468-point mesh would suggest (ADR-0003).
Upsampling in front of it means upscaling twice, the second time on synthetic
content the submodel has never seen.

The effect on landmark accuracy is unpredictable and quite possibly negative.
The deeper problem is that it would be **unattributable**: our instrumentation
measures the noise floor of the signal that arrives (`signal-stats.ts`), and it
cannot distinguish "the landmarker got worse" from "the preprocessor changed
what the landmarker is looking at". We would be debugging two models with
instrumentation built for one.

### 4. Latency, spent in exactly the wrong place

The budget is one camera frame. We drive inference from
`requestVideoFrameCallback` specifically so it runs once per *camera* frame
rather than once per display refresh (ADR-0003), so at the requested 30 fps the
frame **period** is ~33 ms.

That is the budget, not the consumption. FaceLandmarker's share of it is
whatever `detectForVideo` actually costs, which the renderer already tracks as a
rolling average and shows in the status HUD — but **no figure has been recorded
on real hardware.** Tracking quality on a real face has never been measured
(README; issue #2), and this ADR is not going to invent a number for it.

The argument does not need one, because its load-bearing terms do not depend on
the measurement:

- ADR-0003 sets the revisit trigger for the whole vision front end at sustained
  inference above **~12 ms/frame**. That is the project's own statement of where
  this budget starts to hurt, and a second network is not a marginal addition
  to it.
- GPU delegate initialization fails on some drivers, and ADR-0003 records that
  the CPU fallback roughly **triples** inference cost. A preprocessing stage
  contending for the same delegate would push hardest on exactly the machines
  with the least headroom.
- Frame budget is not fungible with quality elsewhere. ADR-0007's entire design
  is about buying smoothness without buying latency; spending the budget
  upstream spends it against that.

If a measurement later shows generous headroom, the *weight* of this objection
changes. Arguments 1 through 3 do not move at all.

### 5. The noise that actually matters has a cheaper fix

The dominant source of frame-to-frame pixel variation here is not sensor read
noise. It is **auto-exposure hunting**. The largest light source on the
subject's face is the screen, whose content changes constantly, so the camera
re-meters continuously; each adjustment shifts the apparent brightness of the
iris/sclera boundary and moves the centroid. At ~33 px of cursor error per pixel
of iris movement, that is a first-order contributor — and because it is
correlated with screen content rather than white, no filter can remove it.

Issue #27 addresses it directly, by pinning `exposureMode`, `whiteBalanceMode`
and `focusMode` through track constraints after a warm-up. Zero inference cost,
no model, no training data, and it degrades gracefully on cameras that refuse.
The cheap fix targets the real cause; the expensive fix targets an imagined one.

### What this does not cover

This ADR is about **synthesising pixel detail that the sensor did not record**.
Geometric operations that only re-sample existing pixels — cropping the eye
region, rectifying it against head pose, feeding a normalised crop to a learned
estimator — invent nothing and are not covered here.

The distinction is already load-bearing in the codebase: the eye-zoom debug view
magnifies with `imageSmoothingEnabled = false`, because "at this magnification
smoothing would invent detail that is not in the sensor data, and the whole
point is to judge the sensor." The same principle, applied to the estimator
rather than the inspector, is this ADR.

## Consequences

### What this buys us

- The frame budget stays with the landmarker, which is the model that actually
  produces the measurement.
- The noise floor reported by the diagnostics is the camera's, so the advice
  derived from it ("sit closer", "add light", "lock exposure") is honest. If we
  filtered the input, the number would describe our preprocessor.
- One model to debug rather than two, with no interaction term between them.

### What this costs us

- We accept the sensor as a hard floor. Under genuinely bad conditions — a dim
  room, a user sitting far back, a 720p webcam — there is no image-side lever
  available at all, and the app's only honest response is to say so.
- We forgo whatever real gain multi-frame fusion might offer. That is a genuine
  loss, not a rhetorical concession; see below.

### What we would need to see to revisit this

Two things would change this decision, and only two.

**Genuine multi-frame super-resolution.** Classical multi-frame fusion recovers
resolution from *real sub-pixel motion* between consecutive frames rather than
from a learned prior: it solves for the high-resolution image consistent with
several observed low-resolution ones. It adds information instead of inventing
it, so argument 2 does not apply to it, and argument 3 applies far more weakly.

Two things would have to be shown before adopting it, and neither is obvious in
advance. First, that enough sub-pixel motion exists at the moments we care
about — the measurement that matters happens during *fixations*, when the user
is deliberately holding still, which is exactly when the inter-frame motion the
method depends on is smallest. Second, that fusing frames does not blur the one
thing that is moving, which is the iris. The evidence we would want is a
measured drop in the quiet-period noise floor (`signal-stats.ts`) on recorded
footage, with no rise in held-out calibration error (ADR-0019), inside the frame
budget.

**An end-to-end appearance-based estimator (issue #33).** If gaze becomes a
learned function of the eye crop rather than a formula over one landmark, this
ADR stops applying. Argument 1 disappears because the bottleneck moves, and
preprocessing stops being a separate stage: it becomes the network's early
layers, optimised jointly against the gaze objective rather than against
perceptual plausibility.

That is a narrower claim than it may look, and the narrowness is the point.
Joint training removes the *specific* failure mode argument 2 describes — there
is no longer a component whose objective is to make the iris **look** right, and
therefore no error injected in service of looking right. It does **not**
guarantee the network forms a correct internal representation. It will learn a
wrong one wherever the wrong one lowers gaze loss on the training distribution,
which is the ordinary way learned estimators fail on users and conditions they
were not trained for. The defence against that is not the architecture, it is
measurement: held-out evaluation on real footage — ADR-0018's validation run,
ADR-0019's held-out targets, and the offline comparison harness issue #33
already requires before the model may ship.

So the distinction this ADR draws survives, stated honestly: it rejects a
preprocessing stage bolted in front of a fixed detector and optimised for
looking right. It does not reject learned feature extraction, and it does not
claim learned feature extraction is safe by construction.
