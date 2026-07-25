# ADR-0002: Electron shell and three-surface process topology

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

The product requirement is to control the **real OS cursor**, which rules out a
pure web app: a browser page cannot move the system pointer. We need a native
shell. Electron, Tauri, and a headless Node daemon with a separate UI were all
candidates.

The vision stack forces the issue. MediaPipe's `FaceLandmarker` for the web is
distributed as WASM + WebGL, and it needs `getUserMedia`, `OffscreenCanvas`, and
a GPU delegate. Those exist in a Chromium renderer. Reimplementing the pipeline
against the C++ MediaPipe libraries in Rust would mean building and shipping the
MediaPipe graph runtime ourselves — a large, brittle dependency for no accuracy
gain, since the model weights are identical.

That leaves a hard constraint: **the model runs in a renderer, the mouse is
driven from the main process.** A native `.node` addon cannot be loaded in a
renderer without `sandbox: false` and `nodeIntegration: true`, which we are not
willing to pay for a process that has a live camera feed attached to it.

A second constraint comes from the crosshair. It must float above every other
application, including full-screen ones, and must never intercept a click —
otherwise the app eats the very clicks it is synthesizing.

## Decision

Ship as an **Electron** application with three surfaces:

```
┌─ main (Node) ────────────────────────────────────────────────┐
│  @eye-tracker/native  (.node addon — Rust)                   │
│  engine bridge · settings · global shortcuts · watchdogs     │
│  window lifecycle · OS permission prompts                    │
└───────▲───────────────────────────────────┬──────────────────┘
        │ gaze:frame (packed Float64Array)  │ overlay:state
        │                                   ▼
┌───────┴──────────────────┐   ┌────────────────────────────────┐
│ control window (renderer)│   │ overlay window (renderer)      │
│ camera · FaceLandmarker  │   │ transparent · frameless        │
│ feature extraction · HUD │   │ always-on-top · click-through  │
│ calibration driver       │   │ crosshair · calibration target │
└──────────────────────────┘   └────────────────────────────────┘
```

- **Main** is the only process with native code, and the only process that can
  move the cursor. It owns all state that must survive a renderer crash.
- **Control window** owns the camera and the model. It is sandboxed, with
  `contextIsolation: true` and no Node integration; it talks to main only
  through a narrow `contextBridge` surface defined in the preload.
- **Overlay window** is a transparent, frameless, non-focusable, always-on-top
  window covering the work area, with `setIgnoreMouseEvents(true, { forward: true })`
  so pointer events pass straight through to whatever is underneath. On macOS it
  is created with `type: 'panel'` and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`
  so it survives Spaces and full-screen apps.

Rejected alternatives:

- **Tauri.** Smaller binary, and the Rust side would be first-class. But the
  webview is WKWebView on macOS, where MediaPipe's WebGL delegate support and
  `getUserMedia` behavior are materially less predictable than Chromium's. We
  are optimizing for tracking accuracy, not bundle size.
- **Node daemon + browser UI.** Removes Electron, but reintroduces it in
  spirit: we would still need a native always-on-top click-through overlay, and
  we would lose a single-process-tree lifecycle.
- **Everything in the renderer with `nodeIntegration`.** Simplest wiring, worst
  security posture: a compromised page in a process holding a camera handle
  would also hold the ability to synthesize input events.

## Consequences

### What this buys us

- The best-maintained build of the iris model, on the GPU, for free.
- A blast radius: the camera-facing process cannot synthesize input directly.
- The main process can enforce safety invariants (§ADR-0011) that a renderer
  cannot be trusted to enforce, because main stays alive when a renderer hangs.

### What this costs us

- One IPC hop per frame on the critical path. ADR-0009 makes that hop cheap.
- Electron's baseline footprint (~150 MB installed, ~200 MB RSS).
- Two renderer processes to keep in sync, and the overlay's platform-specific
  window flags are the most OS-fragile code in the project.

### What we would need to see to revisit this

- Measured IPC latency above ~3 ms p99, which would push us toward moving the
  filter into the renderer and sending only cursor targets to main.
- MediaPipe shipping a maintained Rust binding with iris support.
