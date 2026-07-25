# ADR-0016: Yield to a physical mouse or trackpad

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Gaze control and a physical pointer fight over the same cursor. Without
arbitration the experience is actively hostile: the user reaches for the
trackpad, moves the pointer, and gaze immediately drags it back.

This is also a safety property, and a better one than the kill switch. ADR-0011
provides ⌥⌘E as a pointer-free escape, but that requires the user to *remember a
shortcut while something is going wrong*. Reaching for the trackpad is the
reflex people actually have. Making that reflex work is worth more than the
shortcut it complements.

The question is how to detect physical input. Options considered:

1. **A `CGEventTap`** observing real HID events. Most precise, and can
   distinguish our synthetic events from hardware ones by tagging ours with a
   magic `userData` field. Costs a background thread running a `CFRunLoop`, and
   more moving parts in the most permission-sensitive part of the app.
2. **Compare the actual cursor position to the last position we commanded.** We
   already know exactly where we put the pointer. If the OS reports it somewhere
   else, something else moved it.

Option 2 needs no new permissions, no threads, and no event filtering. Reading
the cursor position is a few microseconds per frame.

## Decision

**Enabled by default.** At the top of each frame, before dispatching this
frame's movement:

```
if control_enabled and we have previously dispatched a position:
    actual = mouse.cursor_position()
    if distance(actual, last_dispatched) > epsilon_px:   # default 8 px
        yield to the user until now + resume_after_ms    # default 1500 ms
```

The check happens *before* our own dispatch, so we compare against a position
the window server has already applied.

On detection:

- `Guard::ManualOverride` blocks both movement and clicks. Clicks matter most
  here: a stray click while the user is working with the trackpad could destroy
  something.
- `last_dispatched` is cleared, so detection does not re-trigger on every
  subsequent frame.
- Filter state is reset, so gaze does not glide from a stale position when it
  resumes.

Resumption is automatic after `resume_after_ms` of no further physical movement.
A `require_manual_resume` option makes the override latch instead, requiring an
explicit re-enable — safer, more friction. Explicitly toggling control on always
clears an override, since that is an unambiguous request for gaze control.

The 8 px epsilon absorbs rounding and the occasional late frame. It is well
below any real hand movement.

## Consequences

### What this buys us

- The reflex people actually have — grabbing the trackpad — takes back control
  instantly, with no shortcut to remember.
- No new permissions, no background thread, no event-tap filtering.
- Gaze and pointer stop fighting, which was the difference between usable and
  unusable when both are in play.

### What this costs us

- Detection is inferential rather than observed. Another application warping the
  cursor reads as user input; that is arguably correct behaviour anyway.
- One `cursor_position()` call per frame.
- A cursor moved *by exactly the amount gaze wanted* would go unnoticed. This is
  vanishingly unlikely and self-correcting.
- False positives would present as gaze "randomly stopping". The HUD names the
  guard explicitly (ADR-0011), so this is diagnosable rather than mysterious.

### What we would need to see to revisit this

- False positives from the position-comparison heuristic, which would justify
  the `CGEventTap` approach with magic-`userData` tagging of our own events.
- Users wanting gaze and pointer to blend rather than take turns — for example
  gaze for coarse positioning and trackpad for fine adjustment, which is a
  genuinely different interaction model.
