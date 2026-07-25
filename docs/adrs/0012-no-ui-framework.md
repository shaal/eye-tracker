# ADR-0012: No UI framework in the renderer

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

The UI surface is small and unusual:

- A **control window**: video preview, a handful of status readouts, a few
  toggles and sliders, a calibration launcher.
- An **overlay window**: a crosshair and a calibration target. Nothing else.

The overlay redraws at camera rate. A React/Vue/Svelte component tree updating
state 60 times a second on the same thread that must draw a crosshair is a
reconciliation cost paid for nothing — the crosshair is two lines and a circle
on a canvas, and the "component" abstraction has no leverage over it.

The HUD does have small amounts of genuine UI state, but it updates at 20 Hz
(ADR-0009) and consists of roughly a dozen text nodes.

There is also a build-cost argument. Adding React pulls in a renderer runtime, a
JSX transform, and a component library's worth of conventions into a project
whose interesting complexity is entirely in Rust and in the vision loop.

## Decision

Plain TypeScript with direct DOM and Canvas 2D. No UI framework.

- **Overlay** renders to a single full-window `<canvas>` in a
  `requestAnimationFrame` loop, reading the latest state from a mutable
  variable that IPC writes into. It draws the newest state at display refresh
  and never queues — a dropped state update is simply overwritten, which is the
  correct semantics for a cursor position.
- **HUD** is static HTML with `textContent` updates against cached element
  references. A tiny `bind()` helper handles the repetitive cases.
- **Styling** is hand-written CSS with custom properties. Two small windows do
  not need a design system.

This is a deliberate scope call, not an ideological one. If the control window
grows into genuine application UI — profile management, per-app settings,
multi-user support — introducing a framework there is a contained change,
because the overlay would remain canvas regardless.

## Consequences

### What this buys us

- The 60 Hz path is a canvas draw with no reconciliation between the data and
  the pixels.
- Small dependency surface and a fast build.
- No question about whether a render is dropping frames.

### What this costs us

- Manual DOM updates are more error-prone than declarative rendering, and grow
  worse than linearly with UI complexity.
- Contributors comfortable with React have to write imperative UI code.

### What we would need to see to revisit this

- The control window exceeding roughly two screens' worth of stateful UI, at
  which point the manual binding code becomes the larger cost.
