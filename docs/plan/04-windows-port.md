# Windows port — session handoff

Everything below happened in one uncommitted session. Nothing is on `main`.
This doc exists so a future session (or a human) can pick up mid-stream
without re-deriving the reasoning.

## Environment, read this first

- Dev machine is WSL2 on Windows. WSL2 has **no camera** (`/dev/video*` never
  appears; the stock kernel lacks `CONFIG_USB_VIDEO_CLASS`) and a degraded GPU
  path (`WebGL1 blocklisted` under WSLg's Vulkan/dzn stack). The app cannot be
  meaningfully run there — only built and unit-tested.
- Two checkouts exist, both uncommitted, **currently byte-identical on tracked
  files** (verified by diff, not assumed):
  - `~/code/experiments/eye-tracker` (WSL) — source only. `node_modules`,
    `packages/*/target`, `packages/*/dist`, `packages/*/out` were deleted
    during a disk cleanup (see below) and **not reinstalled**. Fine for
    editing; `npm`/`cargo` commands will fail here until `npm install` is
    rerun.
  - `E:\code\eye-tracker` (Windows) — the one that actually builds and runs.
    This is where every build/test/smoke result below was produced.
- Windows toolchain: Node 24, Rust 1.97.1 stable-x86_64-pc-windows-msvc, MSVC
  Build Tools 2022 (installed this session via winget). `RUSTUP_HOME` and
  `ELECTRON_CACHE` are persisted in `HKCU\Environment` pointing at `E:\rustup`
  and `E:\electron-cache` — a **normal Windows terminal** picks these up
  automatically; WSL-interop-launched processes do not (until
  `wsl --shutdown`), which is why `E:\et-dev.cmd` / `E:\et-build.cmd` exist —
  they set `RUSTUP_HOME` explicitly before running npm.
- **To run it:** from a Windows terminal, `cd E:\code\eye-tracker && npm run
  dev`. Kill switch is **Alt+Ctrl+E** on Windows (not ⌥⌘E).
- Leftover helper scripts on `E:\`: `et-dev.cmd`, `et-build.cmd`,
  `et-procs.cmd` (kills only eye-tracker's Electron processes, matched by
  path — safe around VS Code etc.), `et-shot.ps1`/`et-shot.png` (screenshot
  scratch, safe to delete).

## Disk cleanup (separate from the code work, already done)

C: was down to 5 GB free. Moved to E: and verified working before deleting
originals: npm cache (4.3 GB), the eye-tracker project itself, `.rustup`
(1.4 GB, verified via a real `cargo clean` + recompile + test run before
deleting the C: copy), Electron cache (138 MB). `.cargo` (222 MB) was
deliberately left on C: — moving it needs a `PATH` edit, which was judged not
worth doing for the size. C: free went 4.67 GB → ~12 GB. WSL's own `ext4.vhdx`
(576 GB) is the real remaining hog; compacting it needs `wsl --shutdown` +
`Optimize-VHD`, which the user has to run themselves.

## What changed, and why

### 1. Windows can build and launch at all

- `packages/native/package.json` — added `x86_64-pc-windows-msvc` and
  `aarch64-pc-windows-msvc` to napi `targets` (was Apple-only).
- `packages/app/package.json` — added an `electron-builder` `build` config
  (there was **none** anywhere — only `electron-builder --mac`) with a `win`
  target (nsis + portable) and a `package:win` script.
- `packages/app/src/main/settings.ts` — kill-switch default is now
  `process.platform === 'darwin' ? 'Alt+Command+E' : 'Alt+Control+E'`
  (`DEFAULT_SHORTCUT`, exported). `Command` is a macOS-only Electron modifier;
  registering it on Windows fails, and the app **fails closed** (control can
  never be enabled) with no in-app rebind UI.
- `packages/app/src/main/index.ts` — `registerShortcut()` now falls back:
  if the saved `settings.shortcut` fails to register and isn't already the
  platform default, it retries with `DEFAULT_SHORTCUT` and persists it. This
  matters for anyone whose `settings.json` predates this change or was
  copied from a mac.
- `packages/app/src/main/index.ts` — `app.setName('Eye Tracker')` moved to
  **before** `loadSettings()` (was inside `whenReady`, i.e. after). userData
  path derives from the app name, so the old order meant dev-mode settings/
  profiles/recordings lived somewhere `recordings.mjs`/`diagnostics.mjs`
  don't look. **Caveat, not yet resolved:** this is a silent behaviour change
  for any existing macOS dev checkout — an existing developer's profiles
  would appear to vanish (still on disk, under the old path).
- `permissions:camera` IPC handler — was a blanket `return 'granted'` for
  every non-darwin platform. Windows *does* support
  `getMediaAccessStatus('camera')` (no `askForMediaAccess` prompt API exists
  there), so it now reports the real status. This directly fixes the earlier
  symptom `Could not start the vision pipeline: Requested device not found`
  reading as a generic failure instead of a permissions issue.
- `permissions:openSettings` — routes to `ms-settings:privacy-webcam` on
  Windows instead of the mac-only `x-apple.systempreferences:` URI (which
  popped a "how do you want to open this?" dialog on Windows).
- `displays.ts` — `estimatePxPerDegree`'s assumed DIP/inch is now
  `process.platform === 'win32' ? 96 : 110`. Windows defines a DIP as 1/96";
  using the mac constant over-reports error ~15% on every Windows machine.

### 2. Cursor placement at non-100% display scaling

`packages/native/crates/core/src/mouse/fallback.rs` (`enigo` backend) had a
`set_scale` method with **zero callers** — no napi binding existed — so every
cursor move used a hardcoded scale of 1.0, wrong on any non-100%-scaled
Windows display. Windows also scales *per monitor*, so a single scalar is
wrong in principle even if wired up.

Fixed with a new module, `packages/native/crates/core/src/mouse/geometry.rs`:
piecewise DIP↔physical conversion from a table of per-display geometry
(logical bounds + physical origin + scale factor), with nearest-display
fallback for points in inter-monitor gaps. 10 unit tests cover mixed-DPI
layouts, negative origins (a display left of/above the primary), round-trips,
and degenerate input. `packages/native/crates/bindings/src/lib.rs` exposes
`set_display_geometry(displays)`; `packages/app/src/main/index.ts`
(`pushDisplayGeometry`) builds the table from
`screen.getAllDisplays()` + `screen.dipToScreenPoint()` and republishes it on
every `display-added`/`display-removed`/`display-metrics-changed` event,
**before** `bridge?.handleDisplayChange()` so the mapping is never stale when
a move can happen. Gated to `process.platform === 'win32'` only —
`dipToScreenPoint` is `@platform win32,linux` in Electron's own types, and
unsupported under Wayland, so publishing a garbage table on Linux/Wayland
would be worse than the identity mapping it always had.

**Not yet verified on real mixed-DPI hardware** — the user's own two displays
are both `@1` scale factor, so this path is unit-tested but not field-tested.

### 3. Two real cross-platform bugs, found while chasing a Windows-only failure

These affect macOS too, not just Windows — worth keeping regardless of how
the Windows work gets merged.

**a) Calibration overlay froze the camera loop for the entire run (Windows).**
The always-on-top calibration overlay fully covers the control window (which
owns the camera loop) on Windows. Chromium treats a fully-occluded window as
backgrounded and stops servicing `requestVideoFrameCallback`. Result: a
calibration run collected **1 frame total** and failed with
`calibration needs at least 3 distinct targets, got 0` — the overlay still
advanced through all 13 steps on its own timers, because target advancement
was never gated on sample count (`engine-bridge.ts`, purely `setTimeout`
driven). No throttling protection existed anywhere in the codebase. Fixed:
`backgroundThrottling: false` on both `BrowserWindow`s in `windows.ts`, plus
three Chromium switches in `index.ts` before `whenReady`:
`disable-backgrounding-occluded-windows`, `disable-renderer-backgrounding`,
`disable-background-timer-throttling`. This is the fix that actually made
calibration work on Windows.

**b) A renderer reload permanently wedges frame acceptance (any platform).**
Frame timestamps are the renderer's `performance.now()`, scoped to that
document's lifetime. The engine lives in the main process and keeps a
monotonic `last_frame_ms` across reloads. `electron-vite dev` reloads the
renderer on file changes. After a reload, every frame's timestamp is smaller
than the engine's high-water mark, so `engine.rs`'s out-of-order guard
(ADR-0009) rejects **every subsequent frame, forever**, silently, until the
app is restarted — no error, no guard state that says why. Fixed: a backwards
jump over `CLOCK_RESET_MS = 1000.0` ms is now read as a new clock epoch
(`Engine::begin_clock_epoch`) rather than a late frame — resets filter/
history/gesture/arbiter state and clock-relative timestamps, but
**deliberately does not touch the calibration collector or fitted model** (a
reload should cost continuity, not the user's already-collected fixations).
Small backwards jumps (real reordering) are still rejected exactly as before.
4 new tests pin both directions, including one confirming a reload mid-run
keeps prior calibration samples.

### 4. Calibration failures were undiagnosable — now they explain themselves

The original failure, `calibration needs at least 3 distinct targets, got 0`,
could mean "no frames arrived" or "every frame was rejected" — opposite
fixes — and nothing distinguished them.
`packages/native/crates/core/src/calibration/collector.rs`'s `add()` computed
a precise rejection reason (`NoFace`/`Blinking`/`LowQuality`/`UnknownTarget`)
and threw it away. Added `RejectionCounts` (per-reason totals + a `dominant()`
helper), and in `engine.rs`, `calib_frames_seen`/`calib_frames_stale`
counters plus `CalibrationDiagnostics::explain()` that produces one of four
distinct messages depending on the failure shape (zero frames at all / all
frames stale — names the reload-clock cause directly / frames rejected, names
the commonest reason / frames arrived but collection was never armed).
Exposed via napi as `calibrationDiagnostics()`
(`CalibrationDiagnosticsJs`), consumed in `engine-bridge.ts`'s
`finishCalibration()` catch block to append the explanation to the thrown
error and log the full breakdown. This is what turned the second real failure
into an immediately actionable one-liner instead of another guessing round.

8 new tests (`engine::diagnostics_tests`) cover each explanation branch and
that a successful run isn't explained away.

### 5. Calibration sampling was silently frame-rate-dependent

`CALIBRATION_TIMING` (`packages/core/src/calibration/protocol.ts`) sampled
for a fixed 500 ms per fixation dot, authored against 30 fps (~15 samples).
The user's 1080p webcam runs inference at ~30ms/frame → ~15 fps actual, so
real sessions got ~7-8 samples/dot. This wasn't visible as a failure — ridge
regression cross-validated to a very large λ and shrank the model toward the
mean, producing `VERTICAL RANGE 0.60` (fitted model spanning only 60% of the
vertical range shown) and told the user to fix it by recalibrating, which
reproduces the same starvation.

Added `CALIBRATION_SAMPLING` (`targetSamples: 15`, `maxCollectMs: 2000` safety
ceiling, `pollMs: 50`). `engine-bridge.ts`'s `runSettleAndCollect` gained a
`wantSamples` parameter: fixation targets now collect until 15 samples or the
2s ceiling, whichever first (with the original 500ms still enforced as a
*floor*, so a fast camera can't race through a dot faster than a fixation can
land). **Head-motion targets deliberately stay purely time-driven** — the
duration there is the instruction (sweeping a pose range), and cutting it
short on sample count would truncate the sweep. 5 new protocol tests
(including one asserting `targetSamples` still matches what the old 500ms
window gave at 30fps, and one bounding worst-case per-dot time so a starved
camera reads as slow, not hung).

**This change is real-world tested but the result is inconclusive — see next
section.** It should not be described as "fixes calibration accuracy" without
qualification.

## Real-hardware findings (2 calibration+validation sessions, user's own webcam)

| | session 1 (before sampling fix) | session 2 (after sampling fix) |
|---|---|---|
| samples | 175 | 222 |
| λ | 0.0077 / 77.42 | 190.80 / 1.07 |
| VERTICAL RANGE | 0.60 | 0.89 |
| held-out error | 366px / 9.24° | 434px / 10.96° |
| validation accuracy | 611px / 15.43° [poor] | 597px / 15.07° [poor] |
| validation precision | ±37px / 0.94° [usable] | ±48px / 1.21° [poor] |
| travel (gx, gy) | 1.217, 0.952 | **0.515, 0.305** |
| noise floor | ±24px | ±34px |
| bias direction | up-left | up |

**Interpretation:** the sampling fix did what it was designed to do — samples
up, vertical-range shrinkage relaxed from 0.60→0.89 exactly as the mechanism
predicted. But held-out error got *worse*, and precision degraded, because
`travel` — how far the gaze feature actually moved across the same on-screen
targets — collapsed to less than half of session 1. Same dots (calibration
targets are placed on the primary display only, `engine-bridge.ts:328`,
unchanged between sessions), so a physically smaller eye-movement range means
either the user sat further back or moved their head toward each target
instead of their eyes. Squeezing less feature range onto the same pixel span
mechanically raises sensitivity (px per unit gaze-feature), which amplifies
raw noise by the same factor — this alone accounts for most of the precision
regression, independent of anything code-related.

One clean result: the bias **direction rotated** between sessions (up-left →
up) while magnitude stayed ~600px. A fixed coordinate/DPI bug cannot rotate
between runs — this rules out a systematic mapping bug in the Windows port
and confirms the residual error is pose drift between calibrating and
validating, not a code defect.

**Open/next real-world step:** re-run with head deliberately still, eyes only,
sitting close, checking `travel` is back near session-1 levels (~1.2 gx)
*before* completing a full validation. Also lock camera exposure if possible
— both sessions flagged `exposure: continuous` in the bundle's own
comparability warning, and it measurably changed between sessions (62.5ms →
31.3ms), so no session-to-session comparison so far is clean.

## Verified (Windows, `E:\code\eye-tracker`, this session)

| Check | Result |
|---|---|
| `npm install` | clean |
| `npm run build` (native MSVC addon + core + app) | clean |
| `npm run typecheck` | clean |
| `cargo clippy --all-targets -- -D warnings` (what CI gates on) | clean, exit 0 |
| Rust core tests | **195 passing** (was 173 at session start) |
| Core TS tests | **74 passing** (was 71) |
| `smoke:mouse` | backend `enigo`, real cursor position read |
| `smoke:app` | camera 1920×1080@30fps live, MediaPipe graph running on GPU, no fatal errors |
| Real calibration + validation, twice | completes; see table above |

**Not verified:** macOS (no mac hardware available this session — every native
change was written to compile identically there, but never built/run there).
Windows CI does not exist.

## Git state

Nothing is committed. `main` is unchanged at `c3b16cf`. Both checkouts carry
the identical uncommitted diff (16 modified files, 1 new file
`packages/native/crates/core/src/mouse/geometry.rs`, 859 insertions / 66
deletions per `git diff --stat`).

## Before merging — gaps identified, not yet closed

1. **Needs a branch + commits.** Currently just a working-tree diff.
2. **ADRs are now stale/contradicted and need updating or a new ADR:**
   - ADR-0009 (IPC frame contract) — says out-of-order frames are rejected;
     doesn't mention the clock-epoch exception.
   - ADR-0006 / ADR-0015 (calibration protocol / head motion) — describe
     fixed-duration sampling; fixation targets are now count-driven.
   - ADR-0010 (native mouse backends) — macOS is "the target", enigo "written
     but unverified"; that's no longer accurate framing given the DPI work
     and real Windows testing.
   - ADR-0011 (safety and permissions) — kill switch "fails closed"; now also
     auto-rebinds and rewrites `settings.json` on a stale/wrong platform
     accelerator.
3. **No Windows CI job.** `.github/workflows/ci.yml` is `macos-latest` only.
   A reviewer will ask for this immediately given the PR's whole point.
4. **Not verified on macOS at all.** Should build+test there before merging,
   particularly the `app.setName` reordering (dev-mode userData path change)
   and the new Chromium command-line switches (should be harmless on mac but
   unconfirmed).
5. **The sampling-fix commit message must not overclaim.** Framed correctly
   ("removes a hidden 30fps assumption from the calibration protocol"), not
   ("fixes calibration accuracy") — the one real-world A/B so far is
   confounded by a pose/distance change and doesn't demonstrate improvement.

**Suggested PR split** (proposed to user, not yet confirmed as the chosen
approach):
- **PR 1 — Windows support proper:** napi targets, electron-builder config,
  platform accelerator + fallback, camera permissions, `ms-settings:` link,
  DPI cursor mapping (`geometry.rs`), px-per-degree constant, README, + a
  Windows CI job.
- **PR 2 — two cross-platform bugs:** occlusion/throttling fix, clock-epoch
  reset. Independent of Windows-specific work; useful on their own.
- **PR 3 — calibration observability:** rejection diagnostics
  (`CalibrationDiagnostics`), count-driven sampling. Keep the unproven
  sampling change isolated so it can't block the Windows port if someone
  wants more real-world evidence first.

## Suggested next steps, in order

1. Decide the PR split (or do it as one PR — the user hadn't decided when
   this session ended).
2. Get real-hardware calibration data with `travel` controlled for (see
   above) — this is the actual open technical question, not a chore.
3. Write/update the four ADRs listed above.
4. Add Windows to CI.
5. Build once on real macOS hardware before merging, specifically checking
   the `app.setName`-ordering change against an existing dev profile.
6. Branch off `main`, commit as logical units matching whatever PR split is
   chosen, push, open PR(s).
