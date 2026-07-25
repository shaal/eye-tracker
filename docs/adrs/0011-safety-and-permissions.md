# ADR-0011: Kill switch, watchdogs, and OS permissions

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

This application takes over the pointer. The failure modes are not "the feature
does not work" — they are "the user cannot operate their computer to turn the
feature off." That is a qualitatively different risk class and deserves
explicit design rather than a checkbox in the UI.

Concretely, the ways this can trap a user:

- Tracking degrades (lighting change, user leaves) and the cursor parks in a
  corner while blinks keep firing clicks.
- The renderer hangs mid-frame; main keeps the last commanded position while the
  user has no way to reach a control that is behind a stuck cursor.
- The user toggles control on and an in-flight blink immediately clicks.
- Calibration is stale after a display change, mapping gaze to coordinates far
  from where the user is looking.

A UI toggle inside the app is not sufficient, because clicking it requires the
pointer that is currently misbehaving.

## Decision

### The kill switch is global and outside the app

A `globalShortcut` (default **⌥⌘E**) toggles control from anywhere, whether or
not the app has focus, and does not require the pointer. It is registered at
startup; if registration fails, the app starts with control **disabled** and
says why. A tray menu item provides a second, pointer-based path.

Disabling is instantaneous and synchronous: it flips a flag in the Rust engine
that gates every mouse dispatch, rather than tearing down the pipeline.

### Fail-safe by default, at every layer

The engine only moves the cursor when *all* of these hold. Any one failing
suspends movement, and suspension defaults to "do nothing" rather than "keep
going from the last estimate":

| Guard                    | Condition                                    |
| ------------------------ | -------------------------------------------- |
| Control enabled          | user toggled on                              |
| Calibration loaded       | a valid model for the current display config |
| Face tracked             | continuously for ≥ 300 ms                    |
| Quality                  | above threshold                              |
| Frame freshness          | last frame < 250 ms old                      |
| Not blinking             | ADR-0007 blink freeze                        |
| Arming delay             | ≥ 300 ms since control was enabled           |

### Watchdog in main, not in the renderer

A timer in the **main** process disables control if no frame has arrived for
**500 ms**. This lives in main deliberately: a watchdog inside the renderer
cannot fire when the renderer is the thing that has hung. Main is not doing GPU
work and is the last component to become unresponsive.

Renderer crash or window close also disables control immediately.

### Clicks are gated more tightly than movement

Everything above, plus a 250 ms refractory period (ADR-0008), plus the arming
delay. A misbehaving tracker that moves the cursor wrongly is annoying; one that
clicks wrongly can destroy work.

### Display configuration changes invalidate calibration

We listen to `screen`'s `display-added` / `display-removed` /
`display-metrics-changed`. Because the model regresses directly to screen
coordinates (ADR-0006), a layout change makes it invalid. On change we disable
control and prompt for recalibration rather than continue with a model that is
confidently wrong.

### Permissions are checked, not assumed

- **Camera.** Requested via `systemPreferences.askForMediaAccess('camera')`
  before the vision loop starts, with an explicit denied state in the UI.
- **Accessibility (macOS).** Checked through the native
  `check_accessibility_permission` binding at startup and whenever control is
  enabled. Without it, `CGEventPost` *silently no-ops* — so we must check
  proactively rather than infer from a failure that never surfaces. The UI shows
  a blocking banner with a button that opens the relevant Settings pane.

The app never requests permissions it is not about to use.

## Consequences

### What this buys us

- Every path to "cannot regain control" has a non-pointer escape.
- Degradation stops the cursor rather than moving it somewhere wrong.
- The silent-no-op Accessibility failure becomes a visible, actionable state.

### What this costs us

- A global shortcut can collide with another application's binding; it is
  configurable, and we report registration failure loudly.
- The guard set makes "why is it not moving?" a real support question. The HUD
  therefore displays *which specific guard* is currently blocking, rather than a
  single boolean.

### What we would need to see to revisit this

- Users disabling the watchdog because false trips are frequent, which would
  mean the frame-freshness budget is wrong for their hardware.
