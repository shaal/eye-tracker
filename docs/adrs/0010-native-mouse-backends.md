# ADR-0010: Platform mouse backends — CGEvent on macOS, enigo elsewhere

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

Synthesizing input is the least portable thing an application can do, and the
cross-platform crates that paper over it do so by exposing the intersection of
what the platforms support. Two capabilities we need fall outside that
intersection:

1. **Real double-clicks.** A double-click is not two clicks in quick succession
   — on macOS it is a single `CGEvent` carrying
   `kCGMouseEventClickState = 2`. Applications read that field. Posting two
   independent click events at 100 ms spacing produces two *single* clicks;
   text will not select by word, files will not open. Most cross-platform
   wrappers do not expose click state.
2. **Absolute positioning with correct coordinate semantics.** macOS global
   display coordinates are top-left origin and measured in **points**, matching
   Electron's `screen` DIP coordinates exactly. Windows and Linux backends work
   in physical pixels, requiring a scale-factor conversion we must apply
   explicitly rather than hope for.

Since the primary target is macOS, and since getting double-click wrong would
fail a stated requirement, the primary backend should be native.

## Decision

Define a trait in `packages/native/src/mouse/mod.rs` and select the
implementation at compile time:

```rust
pub trait MouseBackend: Send {
    fn move_to(&mut self, x: f64, y: f64) -> Result<()>;
    fn click(&mut self, button: Button, count: u8) -> Result<()>;
    fn cursor_position(&self) -> Result<(f64, f64)>;
}
```

- **macOS** (`mouse/macos.rs`): `core-graphics` directly.
  - Movement: `CGEvent` of type `MouseMoved` posted to `CGEventTapLocation::HID`.
    We post an event rather than `CGWarpMouseCursorPosition` because warping
    does not generate the movement events that applications use for hover
    states, and it desynchronizes the hardware cursor association.
  - Clicks: `LeftMouseDown`/`LeftMouseUp` pairs with
    `EventField::MOUSE_EVENT_CLICK_STATE` set to the click count — this is the
    field that makes a double-click a real double-click.
  - Drag support falls out of the same primitives for future use.
- **Windows / Linux** (`mouse/fallback.rs`): `enigo`, and double-click emulated
  as two clicks. Flagged in code as lower fidelity and untested on those
  platforms.

  DPI conversion is owned **by the backend**, not the caller: `EnigoMouse` holds
  a `scale` factor and applies it in `move_to`/`cursor_position`, so the engine
  can keep speaking logical (DIP) coordinates everywhere. It currently defaults
  to 1.0 and nothing sets it, which is correct only on unscaled displays — see
  the platform issue tracking this.
- **Headless / test** (`mouse/null.rs`): records calls without touching the OS.
  This is what `cargo test` links against, so the full engine — including click
  synthesis — is testable in CI with no display and no permissions.

The backend is behind `#[cfg(target_os = ...)]` so unsupported platform code is
never compiled.

### Coordinate contract

The engine works exclusively in **logical (DIP) screen coordinates with a
top-left origin over the union of all displays**, which is Electron's `screen`
coordinate space. Each backend is responsible for converting to its platform's
native space at the boundary — macOS needs no conversion, which is why it is
also the reference implementation for the contract.

Targets are clamped to the union of display bounds before dispatch, and a move
is skipped entirely when it rounds to the previously dispatched position.

### Permissions

macOS requires **Accessibility** authorization before synthesized events reach
other applications. Without it `CGEventPost` silently succeeds and nothing
happens — a confusing failure we must detect, not discover. We expose
`AXIsProcessTrustedWithOptions` through napi so the UI can check status and
optionally trigger the system prompt, and we surface an explicit blocking
banner when permission is missing. See ADR-0011.

## Consequences

### What this buys us

- Genuine double-clicks and correct hover behavior on the primary platform.
- A trait seam that makes the whole engine testable headlessly.
- Coordinate conversion in exactly one place per platform.

### What this costs us

- Two implementations to maintain, of which only one is genuinely exercised.
- The Windows/Linux path is written but unverified; it should be treated as a
  starting point, not a supported target.

### What we would need to see to revisit this

- A serious Windows target, which would justify a native `SendInput` backend
  with the same fidelity as the macOS one.
