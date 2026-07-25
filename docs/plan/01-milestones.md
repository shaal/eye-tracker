# Milestones

Each milestone ends in something a human can run and judge. Where a milestone
cannot be verified without a camera or a display, that is stated explicitly
rather than hidden behind a passing build.

---

## M0 — Scaffold

Monorepo with npm workspaces, TypeScript project references, Rust crate wired
through `@napi-rs/cli`, Electron shell with the three surfaces from ADR-0002.

**Done when**

- `npm run build` produces a `.node` addon, type-checks all packages, and
  bundles main/preload/renderer.
- `npm start` opens a control window and a transparent overlay window; the
  overlay is verifiably click-through (you can click a window behind it).
- `npm run test:native` runs `cargo test` green.

---

## M1 — Vision loop

Camera capture, `FaceLandmarker` with iris + blendshapes + transformation
matrix, feature extraction (ADR-0005), and a debug HUD.

**Done when**

- Face mesh, iris centers, and eye-corner basis vectors draw over the video
  preview at camera rate.
- `gx`/`gy` visibly respond to eye movement and are visibly *insensitive* to
  head roll and to leaning toward/away from the camera. This is the specific
  check that ADR-0005's normalization actually works — a raw-vs-normalized
  toggle in the HUD makes the difference obvious.
- Blendshape blink scores and EAR are both plotted; they should agree at rest
  and diverge under head rotation, with EAR being the one that degrades.
- Sustained ≥ 28 fps with GPU delegate; CPU fallback path exercised by forcing
  `delegate: 'CPU'`.

---

## M2 — Native mouse control

Rust mouse backends, Accessibility permission check, and the safety layer from
ADR-0011 — built before gaze drives anything.

**Done when**

- A debug panel can move the cursor to an absolute point and issue single and
  **real** double-clicks. Verified by double-clicking a word in a text editor
  and seeing word-selection, which is the check that distinguishes a true
  double-click from two singles (ADR-0010).
- Missing Accessibility permission produces a blocking banner, not silence.
- ⌥⌘E toggles control with the app unfocused.
- Killing the control renderer disables control within 500 ms.

---

## M3 — Calibration

Full-screen target sequence, sample collection with rejection, ridge fit with
GCV, leave-one-target-out reporting, profile persistence.

**Done when**

- 5- and 9-point flows both complete and report held-out error in px and
  degrees.
- Deliberately bad calibration (looking away from targets) produces a large
  reported error — the report must be able to say the calibration is bad.
- Profiles round-trip to disk and are invalidated by a display change.
- `cargo test` covers the solver against a synthetic quadratic ground truth,
  including the near-zero-variance head-pose case that motivates ridge.

---

## M4 — Gaze → cursor

Wire the mapped point through the filter pipeline to the mouse. Crosshair
overlay showing raw and smoothed positions.

**Done when**

- Cursor follows gaze across the full screen after calibration.
- Cursor is visually motionless during a fixation (fixation clamp working).
- Looking at a new target lands within ~1 frame, not with a glide (saccade gate
  working).
- Toggling control off freezes the cursor immediately.
- Measured photon-to-cursor latency reported in the HUD.

---

## M5 — Blink clicking

Blink FSM, click arbiter, pre-blink anchoring.

**Done when**

- Deliberate blink clicks; **natural blinks mostly do not** — measured as a
  false-click rate over a 5-minute reading session, which is the acceptance
  test that matters for ADR-0008.
- Double blink produces a real double-click.
- Clicks land at the pre-blink gaze position, not below it. Verified by
  clicking small targets in a row and checking the vertical bias is ~0.
- `min_close_ms` is adjustable live and visibly changes the false-click rate.

---

## M6 — Tuning and hardening

Live-tunable parameters, quality indicators, first-run flow, error states,
natural-blink-duration measurement to suggest `min_close_ms`.

**Done when**

- Every constant in ADR-0007 and ADR-0008 is adjustable at runtime without a
  rebuild.
- The HUD names the *specific* guard blocking control (ADR-0011).
- Camera denied, Accessibility denied, no face, no calibration, and stale
  calibration all have distinct, actionable UI states.

---

## M7 — Packaging

`electron-builder` for a signed, notarized macOS `.app` with the correct
usage-description strings.

**Done when**

- A packaged build runs on a clean machine, prompts for camera and
  Accessibility, and completes calibration.
- The native addon is correctly bundled per-architecture.

---

## Sequencing note

M2 (mouse + safety) deliberately precedes M3 and M4. Building the kill switch
and the guard set *before* anything can move the cursor means that the first
time gaze drives the pointer, the escape hatch already exists and has been
tested. Doing it the other way round means debugging a runaway cursor with a
runaway cursor.
