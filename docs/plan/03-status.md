# Implementation status

What exists, what is verified, and — importantly — what is *not* verified.
Anything needing a human looking at a screen is called out as such, because a
green build says nothing about whether the tracker actually tracks.

## Verified mechanically

| Check | Command | Result |
| ----- | ------- | ------ |
| Rust core unit tests | `npm run test:native` | 150 passing |
| Native addon loads in Node | `npm run smoke:mouse` | backend `macos-cgevent`, Accessibility granted |
| TypeScript across all packages | `npm run typecheck` | clean |
| Full bundle build | `npm run build` | main + preload + 2 renderers + assets |
| App boots end to end | `npm run smoke:app` | no fatal errors; MediaPipe graph started on **GPU** |

The boot smoke test confirms the hard integration points: the native engine
constructs, the packed frame layout matches across the language boundary, the
preload resolves, both windows are created, the vendored WASM loads, and the
face landmarker graph starts with the GPU delegate.

> `smoke:app` reports `INCONCLUSIVE` if another instance is already running —
> the single-instance lock would otherwise make the second copy exit instantly
> and produce a confident pass having tested nothing.

## Verified on real hardware (one session, MacBook Pro webcam)

- Gaze tracking works and is usable.
- Calibration completes and reports held-out error.
- **Cursor was shaky during fixation** → diagnosed as the fixation clamp never
  engaging, since measured noise exceeded its fixed 14 px radius. Fixed by
  ADR-0014 (adaptive clamp + median pre-filter). **The fix is not yet
  re-verified on hardware.**
- **Head turning was unreliable** → diagnosed as the calibration containing no
  head compensation, because the user held still and ridge correctly zeroed
  those coefficients. Fixed by ADR-0015 (head-motion calibration phase).
  **Not yet re-verified on hardware.**

## Milestone status

| Milestone | Status | Notes |
| --------- | ------ | ----- |
| M0 Scaffold | Done | Two-crate Cargo workspace + npm workspaces + electron-vite |
| M1 Vision loop | Done | Verified running on GPU with a real face |
| M2 Mouse + safety | Done | Movement/click verified; kill switch needs a human |
| M3 Calibration | Done | Solver verified against synthetic ground truth; head-motion phase added |
| M4 Gaze → cursor | Done | Works; stability fixes pending re-verification |
| M5 Blink clicking | Done | Blink + wink modes; false-click *rate* unmeasured |
| M6 Tuning/hardening | Mostly done | Live tuning, guard reporting, camera picker, takeover |
| M7 Packaging | Not started | No `electron-builder` config, no signing/notarization |

## Not yet verified — needs a human

1. **Whether the shakiness fix worked.** Check "Gaze spread" and "Clamp radius"
   in the HUD during a fixation.
2. **Whether head-motion calibration restores head tolerance.** Watch "Pose
   drift" while turning your head.
3. **False-click rate.** The single most important UX number (risk R1), and it
   needs a multi-minute real session. Compare blink mode vs wink mode.
4. **Wink left/right mapping** on this camera — the wink test lamps answer it.
5. **Overlay behaviour** over full-screen apps and across Spaces.
6. **The kill switch under duress** — ⌥⌘E while the cursor misbehaves.
7. **Calibration accuracy in degrees** on a real face.
8. **Whether the camera honours the exposure lock** (ADR-0020 argument 5, #27).
   Read "Camera format" and "Exposure" in the Status panel: anything other than
   `locked` means the sensor is still re-metering to whatever is on screen, and
   that jitter is correlated with screen content rather than zero-mean, so no
   filter setting removes it. The same rows answer #42 — if the negotiated
   format traded frame rate away for resolution, it shows up here first.

## Known gaps

- **No tray icon.** ADR-0011 calls for a tray item as a second, pointer-based
  path to disable control. The global shortcut (pointer-free) and the in-app
  toggle both exist, so this is redundancy rather than a missing safety
  property — but the ADR is ahead of the code.
- **Thin TypeScript test coverage.** The Rust core has 150; the TS side has 38,
  covering the recording queue and eye-crop geometry. Feature extraction
  (ADR-0005) is pure and eminently testable, and still untested.
- **Session recording has never been run with a camera.** The capture path
  (ADR-0022) type-checks and its pure pieces are tested, but no frame has been
  captured, encoded or written by it on real hardware, and the claim that it
  costs the vision loop nothing is a design argument rather than a measurement.
- **`electron-builder` config absent** — no signed/notarized build, no
  `NSCameraUsageDescription`.
- **Windows/Linux mouse backend unverified**, and double-click there is emulated
  rather than genuine (ADR-0010).
- **No first-run natural-blink measurement** to suggest `minCloseMs`.
- **Smooth pursuit** trips the saccade gate repeatedly (ADR-0007, accepted).

## Suggested order for a session

1. `npm run smoke:mouse -- --click` with the cursor over a word in TextEdit.
   Confirms a genuine double-click before gaze is involved.
2. `npm run dev`. In the camera panel: move your eyes → `gx/gy` should move;
   roll your head and lean in/out while holding gaze → they should *not*.
3. If using wink mode, run the wink test lamps first.
4. Calibrate 9-point **with the head-motion phase enabled**. Read the held-out
   error in degrees.
5. Confirm ⌥⌘E disables control while another app has focus — **before**
   trusting it.
6. Then try clicking, and tune per `02-risks-and-tuning.md`.
