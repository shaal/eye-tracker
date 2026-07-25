/**
 * Camera capture + MediaPipe Face Landmarker (ADR-0003).
 *
 * Runs in the control renderer, which is the only process with WebGL and
 * getUserMedia. Emits one packed frame per camera frame (ADR-0009).
 */

import {
  FRAME_WIDTH,
  extractFeatures,
  hasIrisLandmarks,
  packFrame,
  findNonFinite,
  NO_FACE,
  type GazeFeatures,
} from '@eye-tracker/core';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface VisionCallbacks {
  onFrame(frame: Float64Array, features: GazeFeatures, inferenceMs: number): void;
  onStatus(patch: {
    cameraReady?: boolean;
    modelReady?: boolean;
    delegate?: 'GPU' | 'CPU' | 'none';
    message?: string;
  }): void;
}

export interface VisionOptions {
  /** Preferred camera `deviceId`; empty selects the system default. */
  deviceId?: string;
  /** Flip which physical eye counts as the subject's left (ADR-0013). */
  swapEyes?: boolean;
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

/**
 * Available video inputs. Labels are only populated after camera permission has
 * been granted, so call this after `start()`.
 *
 * A phone exposed as a virtual webcam shows up here, which is how you get a
 * much better sensor than a built-in laptop camera.
 */
export async function listCameras(): Promise<CameraDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === 'videoinput')
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

// Relative paths so they resolve identically under the dev server and from
// file:// in a packaged build (see electron.vite.config.ts publicDir).
const WASM_PATH = './wasm';
const MODEL_PATH = './models/face_landmarker.task';

export class VisionLoop {
  private video: HTMLVideoElement;
  private landmarker: FaceLandmarker | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private disposed = false;

  /** Reused across frames: the vision loop allocates nothing in steady state. */
  private readonly buffer = new Float64Array(FRAME_WIDTH);
  private inferenceMs = 0;
  private lastVideoTime = -1;
  private rvfcHandle = 0;
  private fallbackTimer = 0;

  private options: VisionOptions;

  constructor(
    video: HTMLVideoElement,
    private readonly cb: VisionCallbacks,
    options: VisionOptions = {},
  ) {
    this.video = video;
    this.options = options;
  }

  /** Update options that do not require restarting the camera. */
  setOptions(patch: VisionOptions): void {
    this.options = { ...this.options, ...patch };
  }

  async start(): Promise<void> {
    await this.openCamera();
    await this.loadModel();
    this.running = true;
    this.scheduleNext();
  }

  /** Switch cameras without tearing down the loaded model. */
  async switchCamera(deviceId: string): Promise<void> {
    this.options = { ...this.options, deviceId };
    this.stream?.getTracks().forEach((t) => t.stop());
    this.lastVideoTime = -1;
    await this.openCamera();
  }

  private async openCamera(): Promise<void> {
    this.cb.onStatus({ message: 'Requesting camera…' });
    const { deviceId } = this.options;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 60 },
          // `exact` rather than `ideal`: silently falling back to a different
          // camera than the one chosen would invalidate the calibration
          // without any indication of why.
          ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
        },
        audio: false,
      });
    } catch (err) {
      this.cb.onStatus({
        cameraReady: false,
        message: `Camera unavailable: ${(err as Error).message}`,
      });
      throw err;
    }

    this.video.srcObject = this.stream;
    await this.video.play();
    this.cb.onStatus({ cameraReady: true, message: 'Camera ready' });
  }

  private async loadModel(): Promise<void> {
    this.cb.onStatus({ message: 'Loading face model…' });
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);

    const options = (delegate: 'GPU' | 'CPU') => ({
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: 'VIDEO' as const,
      numFaces: 1,
      // All three outputs come from one inference pass (ADR-0003).
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });

    try {
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('GPU'));
      this.cb.onStatus({ modelReady: true, delegate: 'GPU', message: 'Model ready (GPU)' });
    } catch (gpuErr) {
      // A real failure mode on some drivers — the CPU path costs roughly 3× the
      // inference time but keeps the app usable (ADR-0003).
      console.warn('[vision] GPU delegate failed, falling back to CPU:', gpuErr);
      this.landmarker = await FaceLandmarker.createFromOptions(fileset, options('CPU'));
      this.cb.onStatus({
        modelReady: true,
        delegate: 'CPU',
        message: 'Model ready (CPU fallback — expect lower frame rate)',
      });
    }
  }

  /**
   * Drive from `requestVideoFrameCallback` where available, so we run once per
   * *camera* frame rather than once per display refresh. On a 30 fps camera and
   * a 120 Hz display that is a 4× reduction in inference work for no loss of
   * information (ADR-0003).
   */
  private scheduleNext(): void {
    if (!this.running || this.disposed) return;

    const anyVideo = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number) => void) => number;
    };

    if (typeof anyVideo.requestVideoFrameCallback === 'function') {
      this.rvfcHandle = anyVideo.requestVideoFrameCallback(() => this.tick());
    } else {
      this.fallbackTimer = window.setTimeout(() => this.tick(), 1000 / 30);
    }
  }

  private tick(): void {
    if (!this.running || this.disposed || !this.landmarker) return;

    const now = performance.now();

    // Skip if the decoder has not advanced — detectForVideo requires strictly
    // increasing timestamps and re-running on the same frame is wasted work.
    if (this.video.currentTime === this.lastVideoTime) {
      this.scheduleNext();
      return;
    }
    this.lastVideoTime = this.video.currentTime;

    let features: GazeFeatures = NO_FACE;
    try {
      const t0 = performance.now();
      const result = this.landmarker.detectForVideo(this.video, now);
      const dt = performance.now() - t0;
      this.inferenceMs = this.inferenceMs === 0 ? dt : this.inferenceMs * 0.9 + dt * 0.1;

      const landmarks = result.faceLandmarks?.[0];
      if (landmarks && hasIrisLandmarks(landmarks.length)) {
        const blendshapes: Record<string, number> = {};
        for (const c of result.faceBlendshapes?.[0]?.categories ?? []) {
          blendshapes[c.categoryName] = c.score;
        }
        features = extractFeatures(
          {
            landmarks,
            blendshapes,
            transform: result.facialTransformationMatrixes?.[0]?.data,
          },
          { swapEyes: this.options.swapEyes ?? false },
        );
      } else if (landmarks) {
        this.cb.onStatus({
          message: `Model returned ${landmarks.length} landmarks — iris refinement missing`,
        });
      }
    } catch (err) {
      console.error('[vision] inference failed:', err);
    }

    packFrame(this.buffer, now, features);

    // A single NaN would propagate through the regression into the cursor
    // position. Rust rejects it too, but catching it here names the field.
    const bad = findNonFinite(this.buffer);
    if (bad !== null) {
      console.error(`[vision] non-finite value in frame slot ${bad}; dropping frame`);
    } else {
      this.cb.onFrame(this.buffer, features, this.inferenceMs);
    }

    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.fallbackTimer) window.clearTimeout(this.fallbackTimer);
    this.rvfcHandle = 0;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close();
    this.landmarker = null;
  }

  get inferenceTimeMs(): number {
    return this.inferenceMs;
  }
}
