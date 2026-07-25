# Architecture Decision Records

Each ADR records one decision, the forces that produced it, and what it costs us.
They are immutable once `Accepted` — to change a decision, write a new ADR that
supersedes the old one.

| #                                                     | Title                                            | Status   |
| ----------------------------------------------------- | ------------------------------------------------ | -------- |
| [0001](0001-record-architecture-decisions.md)          | Record architecture decisions                     | Accepted |
| [0002](0002-electron-process-topology.md)              | Electron shell and three-surface process topology | Accepted |
| [0003](0003-mediapipe-face-landmarker.md)              | MediaPipe Face Landmarker as the vision front end | Accepted |
| [0004](0004-rust-core-boundary.md)                     | Rust core via napi-rs, and where the seam sits    | Accepted |
| [0005](0005-roll-invariant-iris-features.md)           | Roll-invariant, scale-free iris feature vector    | Accepted |
| [0006](0006-gaze-mapping-ridge-regression.md)          | Gaze→screen mapping by regularized regression     | Accepted |
| [0007](0007-cursor-smoothing.md)                       | One Euro filter, saccade gate, fixation clamp     | Accepted |
| [0008](0008-blink-detection-and-click-synthesis.md)    | Blink FSM, click arbiter, pre-blink anchoring     | Accepted |
| [0009](0009-ipc-frame-contract.md)                     | Packed Float64Array frame contract over IPC       | Accepted |
| [0010](0010-native-mouse-backends.md)                  | Platform mouse backends (CGEvent / enigo)         | Accepted |
| [0011](0011-safety-and-permissions.md)                 | Kill switch, watchdogs, OS permissions            | Accepted |
| [0012](0012-no-ui-framework.md)                        | No UI framework in the renderer                   | Accepted |
| [0013](0013-wink-mode-and-eye-resolution.md)           | Wink mode, and resolving which eye is which       | Accepted |
| [0014](0014-adaptive-fixation-stability.md)            | Median pre-filter, self-tuning fixation clamp     | Accepted |
| [0015](0015-head-motion-calibration.md)                | Head-motion calibration and pose-drift reporting  | Accepted |
| [0016](0016-yield-to-physical-pointer.md)              | Yield to a physical mouse or trackpad             | Accepted |
| [0017](0017-delivery-surfaces.md)                      | Browser / phone / Bluetooth-HID delivery options  | Proposed |
| [0018](0018-diagnostics-and-validation.md)             | Diagnostics: signal quality vs. mapping error     | Accepted |
| [0019](0019-lambda-by-held-out-target.md)              | Ridge λ by held-out target, not GCV               | Accepted |

Template: [0000-template.md](0000-template.md)
