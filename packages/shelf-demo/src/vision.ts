/**
 * Camera → MediaPipe → gaze features, browser-only.
 *
 * A trimmed version of the Electron app's vision loop: no recording, no HUD
 * telemetry, no capability-upgrade dance for camera resolution. The one thing
 * that must not be trimmed is `extractFeatures` itself — that's the
 * roll-invariant iris geometry (ADR-0005) carried over unchanged from
 * `@eye-tracker/core`.
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { extractFeatures, hasIrisLandmarks, NO_FACE, type GazeFeatures } from '@eye-tracker/core';

const WASM_PATH = '/wasm';
const MODEL_PATH = '/models/face_landmarker.task';
const CAMERA_WIDTH = 1280;
const CAMERA_HEIGHT = 720;

export type VisionStatus =
  | { kind: 'loading'; message: string }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export class VisionLoop {
  private video: HTMLVideoElement;
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private disposed = false;
  private lastVideoTime = -1;
  private rvfcHandle: number | null = null;
  private fallbackTimer: number | null = null;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(
    onFeatures: (features: GazeFeatures, tMs: number) => void,
    onStatus: (status: VisionStatus) => void,
  ): Promise<void> {
    this.running = true;
    try {
      onStatus({ kind: 'loading', message: 'Requesting camera…' });
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: CAMERA_WIDTH },
          height: { ideal: CAMERA_HEIGHT },
          frameRate: { ideal: 30, max: 60 },
        },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();

      onStatus({ kind: 'loading', message: 'Loading face model…' });
      const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
      const options = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: MODEL_PATH, delegate },
        runningMode: 'VIDEO' as const,
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
      } catch (gpuErr) {
        console.warn('[vision] GPU delegate failed, falling back to CPU:', gpuErr);
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
      }

      onStatus({ kind: 'ready' });
      this.scheduleNext(onFeatures);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onStatus({ kind: 'error', message });
      throw err;
    }
  }

  private scheduleNext(onFeatures: (features: GazeFeatures, tMs: number) => void): void {
    if (!this.running || this.disposed) return;

    const anyVideo = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
    };
    if (typeof anyVideo.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = anyVideo.requestVideoFrameCallback(() => this.tick(onFeatures));
    } else {
      this.fallbackTimer = window.setTimeout(() => this.tick(onFeatures), 1000 / 30);
    }
  }

  private tick(onFeatures: (features: GazeFeatures, tMs: number) => void): void {
    if (!this.running || this.disposed || !this.landmarker) return;

    const now = performance.now();
    if (this.video.currentTime === this.lastVideoTime) {
      this.scheduleNext(onFeatures);
      return;
    }
    this.lastVideoTime = this.video.currentTime;

    let features: GazeFeatures = NO_FACE;
    try {
      const result = this.landmarker.detectForVideo(this.video, now);
      const landmarks = result.faceLandmarks?.[0];
      if (landmarks && hasIrisLandmarks(landmarks.length)) {
        const blendshapes: Record<string, number> = {};
        for (const c of result.faceBlendshapes?.[0]?.categories ?? []) {
          blendshapes[c.categoryName] = c.score;
        }
        const transform = result.facialTransformationMatrixes?.[0]?.data;
        features = extractFeatures({ landmarks, blendshapes, transform });
      }
    } catch (err) {
      console.error('[vision] inference failed:', err);
    }

    onFeatures(features, now);
    this.scheduleNext(onFeatures);
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle !== null) {
      (this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void })
        .cancelVideoFrameCallback?.(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    this.landmarker?.close();
    this.landmarker = null;
  }
}
