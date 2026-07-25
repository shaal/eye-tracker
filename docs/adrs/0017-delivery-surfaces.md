# ADR-0017: Delivery surfaces beyond the macOS desktop app

- **Status:** Proposed — analysis recorded, nothing built
- **Date:** 2026-07-24

## Context

Three related questions came up once the desktop app was working:

1. Could this be a hosted web app (e.g. `eye.shaal.dev`) that gives Mac, PC,
   Android and iPhone users a cursor?
2. Would a phone camera (Galaxy S24 Ultra) work better than a laptop webcam?
3. Bluetooth trackpads are accepted as input devices by every OS with no
   install — can we emulate that?

They share a root: **where the vision runs** and **what is allowed to move the
cursor** are separable, and only the second is hard.

## Analysis

### The vision half is portable; the actuation half is not

Everything upstream of `MouseBackend` — camera, MediaPipe, calibration,
filtering, gesture detection — runs anywhere. `eye-tracker-core` has no Node
dependency and compiles to `wasm32` essentially as-is; `mouse/` is the only
platform-specific module and is already behind a trait (ADR-0010).

Moving the OS cursor is the part that is gated, and gated deliberately:

| Surface | Can move the OS cursor? |
| ------- | ----------------------- |
| Browser (any OS) | **No.** No web API exists, and none will — synthesizing input that reaches *other applications* is the boundary browsers exist to enforce. `requestPointerLock()` only captures the cursor within the page. Extensions are sandboxed identically. |
| Electron/native desktop | Yes — what we do today. |
| Android app | Not its own cursor, but **can act as a Bluetooth HID peripheral** (`BluetoothHidDevice`, API 28+), moving the cursor of a *paired* device. |
| iOS app | No, in either direction. |
| ESP32 / Pi dongle | Yes, as a BT or USB HID peripheral. |

Critically, a **browser cannot be a Bluetooth HID peripheral either**: Web
Bluetooth implements only the *central* role. It can connect to devices, never
advertise as one.

### Camera quality is a real, separable win

Iris localization is sensor-limited, and a modern phone front camera is
materially better than a laptop webcam, particularly in imperfect light. But
this does **not** require porting anything: a phone exposed as a virtual webcam
(Camo, DroidCam, Continuity Camera) is just another `getUserMedia` device.

**This is already implemented** — the camera picker added alongside this ADR. It
is the cheapest available accuracy improvement.

### HID emulation has one significant catch

A standard HID mouse reports **relative** deltas. Gaze estimation produces an
**absolute** screen target, and with relative-only reporting there is no way to
observe where the cursor actually is — no closed loop.

Two mitigations:

- **Absolute HID descriptor.** HID supports absolute pointing devices; this is
  how graphics tablets work. Accepted by macOS, Windows, Linux and Android. The
  clean fix.
- **Corner-homing.** Slam the cursor to (0,0) with a large negative delta, then
  apply a known offset. Works everywhere, but produces visible jumps.

**iOS accepts BLE HID mice** (AssistiveTouch on iPhone, native pointer on iPad)
but treats them as relative only, so iOS gets degraded joystick-like control
rather than absolute gaze positioning.

## Decision

Record these as evaluated directions; build none of them yet. If pursued, in
this order:

### 1. Camera picker — **done**

Lowest cost, real accuracy benefit, no new architecture.

### 2. Phone-as-sensor, desktop-as-actuator

Phone browser at `eye.shaal.dev` runs the vision and streams packed gaze frames
to the desktop app over WebSocket; the desktop app keeps using CGEvent.

This fits the existing architecture with little disturbance, because ADR-0009
defined the renderer→engine boundary as **data** (a 16-float frame) rather than
a function call. Electron IPC becomes one transport among several.

**Security is the real work here, not the streaming.** An open port that lets
anything on the network move the cursor is an obvious hazard. Minimum bar:
explicit pairing code, LAN-or-localhost binding only, and the same guard set
(ADR-0011) applied to remote frames as to local ones.

### 3. In-page gaze cursor at `eye.shaal.dev`

A crosshair confined to the page, dispatching real events to DOM elements. Works
on all four platforms with zero install. Not a system cursor, but a genuine
product for web accessibility, demos and research data collection — and the
honest thing to ship at a URL, since a hosted page promising OS cursor control
cannot deliver it.

### 4. HID backend + Android shell

The largest piece and the only route to zero-install control of an arbitrary
machine, including iPad. Needs a native Android app (`BluetoothHidDevice` is
Kotlin-only), an absolute-pointer HID descriptor, and a `HidMouse` implementation
of `MouseBackend`.

macOS keeps CGEvent regardless: true absolute positioning and real `clickState`
for double-clicks (ADR-0010) are strictly better than HID can offer.

## Consequences

### What this buys us

- A clear statement of what is impossible (browser → OS cursor) so it is not
  re-litigated.
- An ordering by value-per-unit-work, with the cheapest win already delivered.
- Confirmation that the frame-contract seam (ADR-0009) makes the phone-as-sensor
  option a transport change rather than a rewrite.

### What this costs us

- Nothing yet — this is analysis. The risk of recording unbuilt directions is
  that they read as commitments; the status field says otherwise.

### What we would need to see to revisit this

- A concrete need for a non-macOS target, which promotes (4) from interesting to
  necessary.
- Measured accuracy gain from a phone camera large enough to justify (2) over
  simply using a better webcam.
