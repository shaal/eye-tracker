# Eye Tracker

A webcam eye tracker that drives the **real macOS cursor**. Gaze moves the
pointer; a deliberate blink or wink clicks.

| Gesture mode | Left click | Double click | Right click |
| ------------ | ---------- | ------------ | ----------- |
| **Blink** (default) | one blink | two blinks | — |
| **Wink** | left eye | left eye twice | right eye |

Wink mode is structurally more reliable: an involuntary blink closes *both*
eyes, so it is rejected categorically rather than by a duration threshold.

Touch your trackpad and gaze steps aside instantly — no shortcut needed.

TypeScript + MediaPipe for vision, Rust (via napi-rs) for the estimator and
native mouse control, Electron for the shell.

> **Status:** all subsystems are built and the app boots with the vision graph
> running on the GPU. Tracking quality on a real face has **not** been measured —
> see [docs/plan/03-status.md](docs/plan/03-status.md) for exactly what is and
> is not verified.

---

## Quick start

```bash
npm install          # also vendors the MediaPipe model + WASM
npm run build        # native addon → shared TS → Electron bundle
npm run dev          # launch
```

macOS will ask for **Camera** access, and you must grant **Accessibility**
(System Settings → Privacy & Security → Accessibility) before the cursor can be
moved. Without it, macOS silently ignores synthetic input and reports no error —
the app detects this and shows a blocking banner rather than appearing to work.

## Try it without a camera

```bash
npm run test:native              # 89 Rust unit tests: solver, filter, blink FSM, engine
npm run smoke:mouse              # report backend + permission + cursor position
npm run smoke:mouse -- --move    # move the cursor in a square and put it back
npm run smoke:mouse -- --click   # double-click where the cursor already is
npm run smoke:app                # boot the app for ~12s and check for fatal errors
```

`smoke:mouse -- --click` is the check that matters most before trusting
anything: park the cursor over a word in a text editor. A **real** double-click
selects the word. Two singles only move the caret.

## Kill switch

**⌥⌘E** toggles cursor control from anywhere, whether or not the app has focus,
and needs no pointer. Test it before you rely on gaze control. If the shortcut
cannot be registered, the app refuses to enable control at all.

## Your camera, your disk

Camera frames are processed and forgotten. Landmarks never leave the renderer,
sixteen numbers per frame cross to the main process, and nothing is written to
disk. There is no network code in the runtime at all — the MediaPipe model and
WASM are vendored at install time precisely so the app never needs one.

The single exception is opt-in. **Record a training session** writes cropped
images of your eyes to a folder on this machine, so a future gaze model can be
trained on your face and your lighting
([ADR-0022](docs/adrs/0022-local-session-recording.md)). It is off every time the
app starts, there is no setting that turns it back on by itself, and while it
runs there is a red banner in the window *and* a pulsing badge on the overlay
that follows you across every display. Nothing is uploaded; there is no upload
path in the codebase.

```bash
npm run recordings               # what is on disk: sessions, sizes, camera settings
npm run recordings -- --json     # the same, for a training script
npm run recordings -- --delete   # delete all of it, after confirming
```

## How it works

```
camera frame
   ↓  requestVideoFrameCallback          (once per CAMERA frame, not per repaint)
FaceLandmarker.detectForVideo()          renderer, GPU
   ↓  478 landmarks + 52 blendshapes + 4×4 head pose
extractFeatures()                        renderer, pure TS      ADR-0005
   ↓  Float64Array(16), one IPC hop      ADR-0009
Engine::push_frame()                     main process, Rust     ADR-0004
   ├─ CalibrationModel::predict()        ridge regression       ADR-0006
   ├─ FilterPipeline::update()           One Euro + clamps      ADR-0007
   ├─ BlinkFsm → ClickArbiter            blink → click          ADR-0008
   └─ MouseBackend                       CGEvent                ADR-0010
```

Three decisions carry most of the weight:

- **Per-user calibration, not a geometric eye model.** A ridge regression from
  iris offset to screen pixels absorbs camera intrinsics, screen geometry,
  seating distance and personal eye anatomy all at once — none of which we can
  measure on an arbitrary laptop. ([ADR-0006](docs/adrs/0006-gaze-mapping-ridge-regression.md))
- **Gaze is two regimes, not one signal.** Fixations (noisy, stationary) and
  saccades (ballistic) need different treatment, so smoothing is an adaptive
  filter plus a jump detector plus a fixation freeze, not one constant.
  ([ADR-0007](docs/adrs/0007-cursor-smoothing.md))
- **Blinks are mostly involuntary.** A literal "blink = click" clicks every few
  seconds unprompted. Deliberate blinks are separated by *duration*, and clicks
  are anchored to the gaze position from before the eyelid corrupted it.
  ([ADR-0008](docs/adrs/0008-blink-detection-and-click-synthesis.md))

## Layout

```
docs/adrs/        20 architecture decision records — the "why"
docs/plan/        milestones, risk register, tuning playbook, status
packages/native/  Rust: eye-tracker-core (pure, tested) + napi bindings
packages/core/    Shared TS: landmark constants, feature extraction, frame layout
packages/app/     Electron: main / preload / control renderer / overlay renderer
```

The Rust side is deliberately two crates. `eye-tracker-core` has no Node
dependency, so the parts most likely to be subtly wrong — the ridge solver, the
filter, the blink state machine — run under plain `cargo test` with no JS
runtime, camera, or display.

## Tuning

Everything is adjustable at runtime from the Tuning panel; no rebuild needed.
[docs/plan/02-risks-and-tuning.md](docs/plan/02-risks-and-tuning.md) is a
symptom→knob playbook. The short version:

| Symptom | First move |
| ------- | ---------- |
| Cursor jitters when still | check **Gaze spread** in the HUD — large means it's tracking, not filtering |
| Cursor lags behind gaze | raise `beta`, lower `saccadePx` |
| It clicks when I don't mean to | **switch to Wink mode** — that's the real fix |
| My winks don't register | lower `winkAsymmetry` |
| Wink clicks the wrong button | tick "My camera mirrors" |
| Head turning is unreliable | recalibrate **with the head-motion phase** |
| Gaze randomly stops | check the guard — probably "yielded to mouse/trackpad" |
| Single clicks feel slow | lower `doubleWindowMs` (0 disables double-click) |
| Good in the centre, bad at edges | use 9-point, not 5-point |

## Expectations

Roughly **1.5° of visual angle** is the honest ceiling for a webcam without
infrared illumination — about 45 px at a typical viewing distance. That is
enough to hit a button, not a menu item. The app reports its own held-out
calibration error in degrees, cross-validated, so you can see what you actually
got rather than a training-error number that always looks good.

## License

MIT
