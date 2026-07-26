# Risks and tuning

## Risk register

| # | Risk | Likelihood | Impact | Response |
|---|------|-----------|--------|----------|
| R1 | **Involuntary blinks fire clicks.** Central UX risk of blink-as-click (ADR-0008). | High | High | Duration gating with `min_close_ms`; measure the user's natural blink distribution at first run and suggest a threshold; dwell-to-click as the fallback gesture if this proves insufficient. |
| R2 | **Accuracy below the useful threshold.** 1.5° may not be reachable on a poor camera or in bad lighting. | Medium | High | Report held-out error honestly; add a lighting/quality indicator; design targets to be large. Accept that some hardware will not work. |
| R3 | **Head movement breaks calibration.** The model is only valid near its calibration pose. | High | Medium | Head cross-terms + ridge (ADR-0006); detect pose drift beyond a threshold and prompt for recalibration rather than degrade silently. |
| R4 | **Runaway cursor traps the user.** | Low | Severe | Global shortcut, main-process watchdog, guard set, fail-safe defaults (ADR-0011). Built in M2, before gaze can move anything. |
| R5 | **Accessibility permission silently no-ops.** `CGEventPost` succeeds and nothing happens. | High on first run | Medium | Proactive `AXIsProcessTrustedWithOptions` check, blocking banner (ADR-0010/0011). |
| R6 | **GPU delegate fails to initialize** on some drivers. | Medium | Medium | CPU fallback path, exercised deliberately in M1, with a visible notice about the frame-rate cost. |
| R7 | **Blink corrupts click position.** Eyelid occlusion drags the estimate down. | Certain | High | Blink freeze + pre-blink anchoring (ADR-0007/0008). Verified by a zero-vertical-bias test in M5. |
| R8 | **Packed IPC layout drifts** between TS and Rust. | Low | High | Single file per side, runtime width assertion on first frame (ADR-0009). |
| R9 | **Electron/MediaPipe version churn.** | Medium | Low | Vendored model assets; pinned versions; no runtime network fetch. |
| R10 | **Fixation clamp sticks.** A stuck cursor reads as a crash. | Medium | Medium | Hard timeout on the clamp; HUD shows clamp state explicitly. |

## Diagnosing "it isn't accurate"

Before turning any knob, open **Debug & diagnostics** in the control window and
work down it in order (ADR-0018). Each view rules out one cause, and the causes
have *different* remedies — the most common failure is spending an afternoon
recalibrating a problem that calibration cannot fix.

| Question | View | If the answer is bad |
|----------|------|----------------------|
| Is there a usable signal at all? | **1 · Eye zoom** — check "Resolvable steps" and "Signal travel" | Under ~8 resolvable steps, or travel under 0.10 after looking hard left then hard right: the camera is not resolving your gaze. Sit closer, add light on your face, or use a better sensor. Nothing else will help. |
| Is the instability noise, lag, or a stuck clamp? | **2 · Scope** | Fuzzy red = noise (go back to view 1). Blue trailing red = smoothing lag (see below). Flat blue while red moves = clamp stuck (see R10). |
| How wrong is it, and in what way? | **3 · Validation** | Large arrows, small ellipses → recalibrate. Large ellipses → signal noise; recalibrating will not help. |
| It worked earlier — what changed? | **4 · Probe** + **6 · Pose drift** | Change one thing at a time and watch the offset. Any axis past 3σ means you have moved outside where the model was fitted. |
| Was the calibration ever going to work? | **5 · Scatter** | Overlapping clusters mean the input never separated the targets. Refitting is pointless. |

The key number is the **noise floor** in view 1, converted to cursor pixels.
Because `gx` is the iris offset divided by eye width (ADR-0005), the entire
usable signal range spans only about 58 px of iris travel at 720p — so a single
pixel of landmark wobble is roughly 33 px of cursor error. That is why signal
quality has to be ruled out first.

## Tuning playbook

Symptom → knob. All are live-adjustable (M6); none require a rebuild.

### "The cursor jitters when I hold still"

**First read "Gaze spread" in the HUD.** It measures your raw tracking noise in
pixels, before any filtering, and it decides which of these two problems you
have:

- **Spread is large (> ~25 px):** this is a *tracking* problem. No filter
  setting fixes it. Improve lighting, sit closer, or switch to a better camera
  (the camera picker accepts a phone exposed as a virtual webcam). Read
  "Exposure" in the HUD while you are there: anything other than `locked` means
  the camera is still re-metering the scene, and since the brightest thing on
  your face is the screen, every change of screen content moves the iris
  estimate. That motion is correlated with what you are doing, so no filter can
  tell it apart from gaze.
- **Spread is small but the cursor still moves:** this is a *filter* problem,
  so:
  1. Lower `min_cutoff` (0.6 → 0.4 Hz). More smoothing at rest.
  2. Raise "Clamp adaptivity" (2.5 → 3.5) so the clamp engages more readily.
  3. Raise `clamp_radius` — but note it is only a *floor*; the radius adapts to
     measured spread automatically (ADR-0014). Check "Clamp radius" in the HUD
     to see what is actually in use.
  4. Lower "Confidence floor" (0.35 → 0.2) if the jitter is worst when quality
     is low. It lets a poorly-tracked frame be discounted further, which smooths
     it harder and widens the clamp around it (ADR-0023). It does nothing at all
     when quality is high, so it is the right knob only when the two move
     together.

If the cursor jumps rather than jitters, raise "Spike rejection" from 3 to 5.

### "The cursor lags behind where I look"

**First read "Quality" in the HUD.** Since ADR-0023 the filter is deliberately
laggier when it does not believe the frame it was handed: a badly-tracked frame
is smoothed harder, held still more readily, and has to jump further to be
treated as a saccade. If quality is sitting around 0.5, the lag is the tracker
telling you it is unsure, and the fix is the lighting or your posture, not a
slider. If quality is above ~0.85 the modulation is doing almost nothing and the
lag is ordinary filter lag:

1. Raise `beta` (0.007 → 0.015). The filter gets out of the way faster when
   moving.
2. Lower `saccade_px` (120 → 80 px) so more movements are treated as jumps and
   bypass the filter entirely.
3. Check the reported inference time. Above ~15 ms/frame the lag is compute, and
   no filter setting will fix it.

If you would rather have a responsive cursor than an honest one, raise
**"Confidence floor"** (0.35 → 0.7, or 1.0 to disable the effect entirely).
That trades accuracy for immediacy: poorly-tracked frames go back to driving the
cursor at full strength right up to the point where the guard cuts them off.

### "It will not jump to a new target when tracking is poor"

Also ADR-0023, and the knob is the same one. A distrusted frame has to jump
*further* to clear the saccade threshold — at quality 0.4 the 120 px threshold
becomes 300 px — because a briefly mislocalised iris looks exactly like a
saccade, and the gate is the one stage with no recovery: it throws away the
filter state and teleports. A large movement below the raised threshold still
gets there, by gliding rather than jumping.

Retune from either end, both live:

1. Raise **"Confidence floor"** to cap the widening (0.7 allows at most 1.43×).
2. Lower **"Saccade threshold"** (120 → 80 px), which lowers it at every
   confidence level rather than only when tracking is poor.

The ratio between them is the parameter least validated against real hardware —
if you find a setting that is clearly better on a real face, that is worth
reporting.

### "The cursor feels different from one minute to the next"

Expected, and diagnosable. Watch "Quality" in the HUD while it happens.

Tracking quality modulates smoothing continuously (ADR-0023), so slouching,
turning away from the lamp, or leaning back changes how the cursor behaves — it
becomes steadier and laggier as quality falls, and snappier as it recovers.
Before ADR-0023 there was no such ramp: the cursor behaved identically at 0.41
and 0.99 and then stopped dead at 0.39, which felt like a fault rather than a
signal.

- **If quality is stable and the feel still changes:** this is not the cause.
  Check "Clamp radius" in the HUD, which adapts separately to measured noise
  (ADR-0014).
- **To make the feel constant regardless of quality:** untick "Scale smoothing by
  tracking quality" in Behaviour & diagnostics. This restores the pre-ADR-0023
  filter exactly, and is the A/B switch to use if you suspect the change made
  things worse.
- **To keep the ramp but soften it:** raise "Confidence floor". It bounds how far
  a bad frame can be discounted — at the default 0.35 with the default quality
  gate at 0.4, no two usable frames differ by more than 2.5×.

### "It clicks when I do not mean to"

1. **Switch to Wink mode.** This is the real fix, not a tuning knob. An
   involuntary blink closes *both* eyes, and wink mode rejects that
   categorically rather than by a duration threshold (ADR-0013). It also gives
   you right-click.
2. In blink mode: raise `min_close_ms` (150 → 200 → 250 ms).
3. Raise `close_thresh` (0.55 → 0.65) so partial closures do not register.

### "My winks do not register"

1. Lower "Wink asymmetry required" (0.28 → 0.15). Most people cannot wink
   without the other eye squinting, and this is the margin that decides how much
   squint is tolerated.
2. Lower `wink_min_close_ms` (120 → 80 ms).
3. Check the wink test lamps in the Clicking panel — if the wrong side lights
   up, tick "My camera mirrors".

### "Wink mode clicks the wrong button"

Your camera delivers mirrored frames. Tick "My camera mirrors — swap left and
right" in the Clicking panel. This only affects which button fires; gaze
tracking is symmetric and unaffected (ADR-0013).

### "My deliberate blinks do not register"

1. Lower `min_close_ms`, but not below ~120 ms or R1 returns.
2. Lower `close_thresh` (0.55 → 0.45) — some users do not reach full closure.
3. Check that *both* eyes are being detected as closing; the `min(A, B)` rule
   means an asymmetric blinker registers the *less* closed eye.

### "Single clicks feel slow"

Intrinsic: a single click waits out `double_window_ms` to rule out a double
(ADR-0008). Set `double_window_ms = 0` to fire immediately and give up
double-click.

### "Accuracy is fine in the center, bad at the edges"

1. Use 9-point rather than 5-point calibration — the quadratic terms need
   eccentric samples to be identified.
2. Check calibration target insets; targets at 10 % are already near the useful
   limit of gaze eccentricity.
3. Inspect per-target held-out error in the calibration report; a single bad
   target usually means the user did not fixate it.

### "Turning my head sometimes works and sometimes doesn't"

**Check "Pose drift" in the HUD.** It reports how far your head is from the pose
you calibrated at, in standard deviations. Above ~3 the model is extrapolating.

The usual cause is calibrating while holding perfectly still: the
head-compensation terms then have no variance to fit, ridge correctly zeroes
them, and the model contains no head compensation at all (ADR-0015). The app
tells you when this has happened.

**Fix:** recalibrate with "Include head-motion phase" ticked. It adds ~15 s and
asks you to hold your gaze on a dot while moving your head, which is what gives
those terms something to learn from.

### "It worked yesterday and is off today"

Most likely a posture change. Check pose drift first — if it is high, recalibrate
in the posture you actually use. If it recurs daily even after a head-motion
calibration, that is evidence for the multi-pose model in ADR-0006's revisit
criteria.

### "Gaze randomly stops working"

Look at the guard reason in the title bar. If it says **"yielded to
mouse/trackpad"**, gaze has deliberately stepped aside because it detected
physical pointer input (ADR-0016). It resumes ~1.5 s after you stop touching the
trackpad, or immediately if you toggle control off and on. Turn it off with the
"Yield to mouse/trackpad" checkbox if it is triggering spuriously.
