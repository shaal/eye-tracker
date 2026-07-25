# Overview

## What we are building

A desktop application that estimates where the user is looking on screen from a
consumer webcam, and drives the **real OS mouse cursor** from that estimate.
Blinks synthesize clicks. A short calibration adapts the model to the user, the
camera, and the display.

## Goals

| Goal                     | Target                                                     |
| ------------------------ | ---------------------------------------------------------- |
| Accuracy                 | ≤ 1.5° visual angle held-out error after 9-point calibration |
| End-to-end latency       | ≤ 60 ms from photon to cursor move (p95)                    |
| Throughput               | Sustained at camera rate (30 fps typical) without drops     |
| Head tolerance           | Usable within ±10 cm translation, ±15° rotation of calibration pose |
| Stability                | Cursor visually motionless during a fixation                |
| Safety                   | Control always revocable without using the pointer          |

At a typical 60 cm viewing distance, 1.5° is roughly 45 px on a 110 PPI display
— large enough to hit a button, not a menu item. That is the honest ceiling for
a webcam without IR illumination, and the product should be designed around it
rather than pretending otherwise.

## Non-goals

- **Reading-level precision.** Word-level tracking needs IR hardware.
- **Multi-user simultaneous tracking.** One face, `numFaces: 1`.
- **Replacing the mouse entirely.** This is an assistive/experimental pointer,
  and the kill switch is a first-class feature, not an escape hatch.
- **Windows/Linux support.** The code paths exist (ADR-0010) but are unverified.

## Module map

```
packages/
├── native/                     Rust + napi-rs  →  @eye-tracker/native
│   ├── src/math/               vec2, Cholesky ridge solver
│   ├── src/calibration/        sample collection, design matrix, GCV, LOO report
│   ├── src/filter/             One Euro, saccade gate, fixation clamp, history ring
│   ├── src/blink/              closure FSM, single/double click arbiter
│   ├── src/mouse/              CGEvent (macOS) / enigo (other) / null (tests)
│   ├── src/frame.rs            packed Float64Array decoding  (ADR-0009)
│   └── src/engine.rs           the facade: push_frame → map → filter → blink → mouse
│
├── core/                       Shared TypeScript  →  @eye-tracker/core
│   ├── src/vision/landmarks.ts MediaPipe index constants (EYE_A / EYE_B)
│   ├── src/vision/features.ts  landmarks → roll-invariant features  (ADR-0005)
│   ├── src/ipc/frame-layout.ts the packed layout, mirrored in Rust
│   └── src/types.ts            shared contracts
│
└── app/                        Electron  →  @eye-tracker/app
    ├── src/main/               engine bridge, windows, shortcuts, settings, watchdog
    ├── src/preload/            contextBridge surface
    └── src/renderer/
        ├── control/            camera + FaceLandmarker + HUD + calibration driver
        └── overlay/            transparent click-through crosshair canvas
```

## Data flow, one frame

```
camera frame
   │  requestVideoFrameCallback
   ▼
FaceLandmarker.detectForVideo()          renderer, GPU
   │  478 landmarks + 52 blendshapes + 4×4 pose matrix
   ▼
extractFeatures()                        renderer, pure TS      ADR-0005
   │  Float64Array(16)
   ▼
ipc 'gaze:frame'                                                ADR-0009
   ▼
Engine::push_frame()                     main, Rust             ADR-0004
   ├─ CalibrationModel::predict()        → raw screen point     ADR-0006
   ├─ FilterPipeline::update()           → smoothed point       ADR-0007
   ├─ BlinkFsm::update() → ClickArbiter  → click event          ADR-0008
   └─ MouseBackend::move_to() / click()  → OS cursor            ADR-0010
   │  FrameOutput
   ▼
ipc 'overlay:state' → crosshair          overlay, canvas
ipc 'hud:state'     → status readouts    control, DOM @20 Hz
```

## Accuracy budget

Where the error comes from, roughly, and what addresses it:

| Source                                | Magnitude | Mitigation                       |
| ------------------------------------- | --------- | -------------------------------- |
| Iris landmark noise                   | ~0.5°     | One Euro + fixation clamp (0007) |
| Head pose drift from calibration pose | ~1.0°     | Head cross-terms in model (0006) |
| Model bias (quadratic vs. true map)   | ~0.4°     | 9-point over 5-point (0006)      |
| Kappa angle (optical vs. visual axis) | absorbed  | folded into calibration (0006)   |
| Blink corruption                      | large     | freeze + pre-blink anchor (0007/0008) |
