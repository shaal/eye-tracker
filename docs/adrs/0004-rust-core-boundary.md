# ADR-0004: Rust core via napi-rs, and where the seam sits

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

The requirement is a Rust core exposed through napi-rs for "system mouse control
and performance-critical logic." The design question is not *whether* to use
Rust — it is **where to cut the seam**, because the cut determines how many
times per second we cross the FFI boundary and how much state has to be
duplicated on both sides.

Three candidate seams:

1. **Thin seam.** Rust exposes `moveMouse(x, y)` and `click()`. All estimation,
   filtering, and blink logic lives in TypeScript.
2. **Thick seam.** Rust owns everything downstream of feature extraction: the
   calibration model, the filter, the blink state machine, and the mouse.
   TypeScript pushes one feature frame per camera frame and gets back a state
   snapshot.
3. **Total seam.** Rust also does landmark→feature extraction. Requires shipping
   478 landmarks (1 434 floats) across FFI per frame.

The deciding force is **where timing correctness lives.** Blink classification
depends on measuring closure duration against a monotonic clock, and the
double-click arbiter depends on a 400–600 ms deadline. A renderer is subject to
GC pauses, background-tab throttling, and compositor stalls. If the blink FSM
runs there, a 250 ms jank turns a single blink into a double-click — or drops
the click entirely. In the main process, backed by `std::time::Instant`, the
same jank shows up as a stale-but-well-ordered timestamp that the FSM can reject
explicitly.

The second force is that filter state, calibration coefficients, and click
history are all state that must survive a renderer crash and must not be
duplicated. Whoever owns the mouse should own them.

## Decision

**Take the thick seam.** The Rust crate `@eye-tracker/native` exposes a single
stateful `Engine` object:

```rust
#[napi]
impl Engine {
    #[napi(constructor)] pub fn new(config: EngineConfig) -> Self;

    /// Hot path. One call per camera frame. Runs mapping → filter → blink →
    /// mouse, and returns a snapshot for the UI.
    #[napi] pub fn push_frame(&mut self, frame: Float64Array) -> FrameOutput;

    #[napi] pub fn begin_calibration(&mut self, targets: Vec<Point>) -> ();
    #[napi] pub fn add_calibration_sample(&mut self, i: u32, frame: Float64Array) -> ();
    #[napi] pub fn finish_calibration(&mut self) -> CalibrationReport;
    #[napi] pub fn load_calibration(&mut self, model: CalibrationModel) -> ();

    #[napi] pub fn set_control_enabled(&mut self, on: bool) -> ();
    #[napi] pub fn set_config(&mut self, patch: ConfigPatch) -> ();
    #[napi] pub fn check_accessibility_permission(&self, prompt: bool) -> bool;
}
```

`push_frame` is the only per-frame call: **one FFI crossing per camera frame**,
carrying one packed buffer (ADR-0009) and returning one small struct.

TypeScript keeps landmark→feature extraction (ADR-0005). That code is pure,
allocation-light, ~40 floating point operations per frame, and it is where the
MediaPipe-specific knowledge lives. Pushing it into Rust would mean shipping
1 434 floats per frame to save perhaps 20 µs, and would spread MediaPipe's
landmark conventions across two languages.

The crate is built with `@napi-rs/cli` (`napi build --platform --release`),
producing a per-platform `.node` binary plus generated `index.d.ts`, so the
TypeScript side gets real types for the whole native surface.

**The Rust core has no dependency on Electron or Node semantics** beyond the
napi attribute macros. `cargo test` exercises the calibration solver, the
filter, and the blink FSM with no JS runtime present, which is the point: the
parts most likely to be subtly wrong are the parts testable in isolation.

## Consequences

### What this buys us

- Timing-critical logic runs against a monotonic clock in a process that is not
  doing GPU work.
- One FFI crossing per frame, one owner for all downstream state.
- The math is unit-testable without a browser, a camera, or a display.

### What this costs us

- Iterating on filter tuning means a Rust rebuild (~2–5 s incremental), not a
  hot reload. We mitigate by exposing every tuning constant through
  `set_config`, so tuning at runtime does not require a rebuild.
- Contributors need a Rust toolchain.
- The packed-buffer contract must be kept in sync across two languages by hand;
  ADR-0009 makes that a single-file change with a compile-time width check.

### What we would need to see to revisit this

- FFI overhead measuring above ~200 µs/frame, which would argue for batching.
- A need to run the estimator somewhere other than a Node process.
