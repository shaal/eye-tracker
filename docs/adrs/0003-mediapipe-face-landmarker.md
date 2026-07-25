# ADR-0003: MediaPipe Face Landmarker as the vision front end

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

We need, per frame, at ≥30 Hz on a laptop CPU/GPU budget shared with an Electron
UI:

1. iris centers with sub-pixel stability,
2. eye corner landmarks to normalize against,
3. head pose, because gaze direction is only meaningful relative to the head,
4. an eyelid-closure signal for blink detection.

MediaPipe's `FaceLandmarker` task returns all four from one inference pass:

- **478 landmarks.** The first 468 are the canonical face mesh; **468–472 are
  one iris (center + 4 rim points), 473–477 the other.** The iris refinement
  submodel operates on a cropped, upscaled eye region, which is why iris centers
  are far more stable than you would expect from a 468-point mesh alone.
- **52 ARKit-compatible blendshapes** when `outputFaceBlendshapes: true`,
  including `eyeBlinkLeft` / `eyeBlinkRight`.
- **A 4×4 facial transformation matrix** when
  `outputFacialTransformationMatrixes: true`, giving head rotation and
  translation in a metric space.

The alternatives are worse for our constraint set. A classical
Starburst/ELSE-style pupil detector needs an IR illuminator to be reliable in
visible light. A learned end-to-end appearance model (iTracker/GazeCapture
lineage) predicts screen coordinates directly, but its accuracy is bounded by
how well the user resembles the training population, and it gives us no
per-user calibration hook — which is exactly the lever that gets a webcam
tracker from ~4° to ~1°.

## Decision

Use `@mediapipe/tasks-vision`'s `FaceLandmarker` in the control renderer,
configured as:

```ts
{
  runningMode: 'VIDEO',
  numFaces: 1,
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: true,
  baseOptions: { delegate: 'GPU' },   // CPU fallback on init failure
}
```

We call `detectForVideo(video, timestampMs)` from a `requestVideoFrameCallback`
loop rather than `requestAnimationFrame`, so we run exactly once per *camera*
frame instead of once per *display* refresh. On a 30 fps camera and a 120 Hz
display, this is a 4× reduction in inference work with no loss of information.

**Blendshapes are the primary blink signal**, with a geometric eye-aspect-ratio
(EAR) computed from lid landmarks as a fallback and cross-check. The blendshape
head was trained on eyelid appearance and degrades far more gracefully under
head rotation than a 2D distance ratio does — EAR shrinks when you turn your
head, which reads as a blink.

Model assets (`face_landmarker.task`, ~3.7 MB, plus the WASM bundle) are
**vendored into the repo at setup time** by `scripts/fetch-models.mjs` and loaded
from disk. The app never fetches from the network at runtime, so the renderer's
CSP can forbid remote origins outright and the app works offline.

## Consequences

### What this buys us

- One inference pass yields iris, pose, and blink together — no second model,
  no cross-model temporal misalignment.
- Head pose comes free, which ADR-0006 uses to compensate for head movement.
- Per-user calibration stays available as the main accuracy lever.

### What this costs us

- A ~3.7 MB model plus ~9 MB of WASM in the app bundle.
- GPU delegate initialization is a real failure mode on some drivers; we must
  implement and test the CPU fallback path, which roughly triples inference cost.
- We inherit MediaPipe's landmark semantics, including its left/right naming,
  which is a known trap — see ADR-0005 for how we defuse it.

### What we would need to see to revisit this

- Sustained inference above ~12 ms/frame on target hardware.
- A published model with materially better iris localization under our
  lighting conditions.
