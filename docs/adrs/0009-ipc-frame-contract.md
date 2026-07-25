# ADR-0009: Packed Float64Array frame contract over IPC

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

ADR-0002 puts a process boundary on the hot path, and ADR-0004 puts an FFI
boundary right behind it. Every camera frame therefore crosses:

```
renderer ──structured clone──► main ──napi marshalling──► Rust
```

at 30–60 Hz. The obvious encoding is a plain object with ~20 named fields. It
works, but it pays twice: V8's structured clone walks the object graph and
allocates a fresh object per frame in main (GC pressure at 60 Hz), and then
napi-rs has to perform ~20 individual property `get` calls to build the Rust
struct, each one a V8 lookup across the JS/native boundary.

## Decision

Encode the per-frame payload as a **fixed-layout `Float64Array`**, defined once
in `packages/core/src/ipc/frame-layout.ts` and mirrored in
`packages/native/src/frame.rs`.

```ts
export const FRAME_SLOTS = {
  TIMESTAMP: 0,   OK: 1,   QUALITY: 2,
  GX: 3,          GY: 4,   DGX: 5,
  YAW: 6,         PITCH: 7, ROLL: 8,
  HX: 9,          HY: 10,  HZ: 11,
  OPEN_A: 12,     OPEN_B: 13,
  BLINK_A: 14,    BLINK_B: 15,
} as const;
export const FRAME_WIDTH = 16;
```

Rust reads it as a `&[f64]` slice — one pointer, zero property lookups — and
asserts the width on entry:

```rust
if frame.len() != FRAME_WIDTH { return Err(...) }
```

A width mismatch is caught on the first frame with a clear error rather than
producing silently shifted fields, which is the failure mode that makes
hand-mirrored binary layouts dangerous.

The renderer **reuses a single `Float64Array`** across frames and sends a copy,
so steady-state allocation in the vision loop is zero.

### Timestamps

`TIMESTAMP` is milliseconds on a monotonic clock, captured in the renderer at
frame acquisition. Main does not re-stamp on receipt — that would fold IPC
queueing delay into the measured inter-frame time and corrupt the One Euro
speed estimate. Rust **rejects non-monotonic frames** (a late frame arriving
after a newer one) rather than integrating them out of order.

### Return path

`push_frame` returns a small struct (cursor position, blink phase, click event
if any, control state, quality). Object marshalling is fine in this direction:
it happens once per frame, is small, and gains real clarity from being named.

Main forwards state to the overlay window at full rate and to the control
window's HUD at ~20 Hz — the HUD is human-readable text and gains nothing from
60 Hz updates, while the crosshair needs every frame.

### Channels

| Channel         | Direction         | Rate  | Payload             |
| --------------- | ----------------- | ----- | ------------------- |
| `gaze:frame`    | control → main    | 30–60 | `Float64Array(16)`  |
| `overlay:state` | main → overlay    | 30–60 | cursor + phase      |
| `hud:state`     | main → control    | ~20   | full state snapshot |
| `control:*`     | control → main    | rare  | commands (invoke)   |

Only `control:*` uses `invoke`/handle (request/response). The streaming channels
are one-way `send`, because a per-frame round trip would serialize the vision
loop against the main process's event loop.

## Consequences

### What this buys us

- One buffer copy and one pointer hand-off per frame instead of ~20 V8 property
  lookups plus an object allocation.
- Zero steady-state allocation in the renderer's vision loop.
- Field-shift bugs become a loud startup error.

### What this costs us

- The layout is mirrored by hand in two languages. Mitigated by keeping it to
  one file per side, with the width check as a runtime tripwire.
- Debugging a packed buffer is less pleasant than an object; a `decodeFrame()`
  helper exists purely for logging.

### What we would need to see to revisit this

- The layout changing often enough that hand-mirroring becomes a real source of
  bugs, which would justify generating both sides from one schema.
