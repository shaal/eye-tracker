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
  type CameraLockStatus,
  type GazeFeatures,
  type Landmark,
} from '@eye-tracker/core';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

export interface VisionCallbacks {
  /**
   * `landmarks` is the raw MediaPipe result for this frame, or null when no
   * face was found. It stays inside the renderer — it is far too large to send
   * over IPC every frame (ADR-0009) — and exists so the debug views can draw
   * the iris rim and eyelid contour, which the packed feature vector reduces
   * away. The array is MediaPipe's own; do not retain it past the callback.
   */
  onFrame(
    frame: Float64Array,
    features: GazeFeatures,
    inferenceMs: number,
    landmarks: readonly Landmark[] | null,
    /**
     * MediaPipe's 4×4 facial transformation matrix for this frame, column-major,
     * or undefined when the model emitted none.
     *
     * `features` already carries yaw/pitch/roll derived from it, which is all
     * the live pipeline needs. The full matrix is threaded through for the
     * session recorder alone (ADR-0022): the offline normalization warp of #32
     * needs the rotation *and* translation, and three Euler angles cannot be
     * un-collapsed back into them. Like `landmarks`, this array belongs to
     * MediaPipe — do not retain it past the callback.
     */
    transform: ArrayLike<number> | undefined,
  ): void;
  onStatus(patch: {
    cameraReady?: boolean;
    modelReady?: boolean;
    delegate?: 'GPU' | 'CPU' | 'none';
    message?: string;
    /** Emitted once per opened stream, after the image-control lock has run. */
    camera?: CameraLockStatus;
  }): void;
}

/**
 * Re-exported rather than declared here: the lock state is now also written
 * into every recorded session's manifest (ADR-0022), so it crosses the IPC
 * boundary and belongs with the shared contracts.
 */
export type { CameraLockStatus };

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

// ---------------------------------------------------------------------------
// Camera image controls
//
// The three interfaces below add the fields the Image Capture spec bolts onto
// `MediaTrackCapabilities` / `MediaTrackSettings` / `MediaTrackConstraintSet`.
// TypeScript's DOM lib declares none of them, because no engine but Chromium
// ships them — which is exactly the situation this file has to survive: the
// same build talks to a USB camera that exposes all four and to a MacBook
// built-in that exposes none. Declaring them explicitly optional keeps every
// read a plain `?? fallback` and every absence an ordinary runtime value,
// rather than an `any` that would hide the difference.
// ---------------------------------------------------------------------------

interface CameraControlCapabilities extends MediaTrackCapabilities {
  exposureMode?: string[];
  whiteBalanceMode?: string[];
  focusMode?: string[];
  exposureTime?: DoubleRange;
}

interface CameraControlSettings extends MediaTrackSettings {
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
  exposureTime?: number;
}

interface CameraControlConstraintSet extends MediaTrackConstraintSet {
  exposureMode?: string;
  whiteBalanceMode?: string;
  focusMode?: string;
  exposureTime?: number;
}

/**
 * The format asked for before the sensor has said what it has.
 *
 * Deliberately still 1280×720: the first `getUserMedia` must succeed on
 * anything, and the real resolution request is made from `getCapabilities()`
 * once there is a track to interrogate.
 */
const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;

/**
 * Auto-exposure warm-up bounds, before the metering loop is frozen.
 *
 * A UVC sensor starts from whatever gain it was last left at and walks toward
 * the metered value over roughly 10–30 frames — a third of a second to a second
 * at 30 fps, longer on a laptop camera that also ramps its gain. Pin at t=0 and
 * you pin the first frame, which is usually near-black.
 *
 * So: wait out the floor unconditionally, then, where `exposureTime` is
 * readable, poll until two consecutive reads agree. A fast camera is done
 * shortly after the floor; a slow one is given up to the ceiling. Cameras that
 * report no `exposureTime` (most macOS built-ins) get the floor and nothing
 * more, which is why the floor has to be defensible on its own.
 */
const WARMUP_FLOOR_MS = 700;
const WARMUP_CEILING_MS = 2500;
const WARMUP_POLL_MS = 100;

const delay = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

async function warmUpAutoExposure(track: MediaStreamTrack): Promise<void> {
  const started = performance.now();
  await delay(WARMUP_FLOOR_MS);

  const read = (): number | null =>
    (track.getSettings() as CameraControlSettings).exposureTime ?? null;

  let previous = read();
  if (previous === null) return;

  while (performance.now() - started < WARMUP_CEILING_MS) {
    await delay(WARMUP_POLL_MS);
    const current = read();
    // `null` here means the track ended mid-wait; there is nothing left to pin.
    if (current === null || current === previous) return;
    previous = current;
  }
}

/**
 * The value auto-exposure settled on, clamped into the range the camera says it
 * will accept in manual mode.
 *
 * Those two are not the same set of numbers on every driver — the auto path is
 * often free to integrate longer than the manual path allows — and an
 * out-of-range value fails the constraint outright rather than being rounded to
 * the nearest legal one.
 */
function clampExposureTime(
  current: number | undefined,
  range: DoubleRange | undefined,
): number | null {
  if (typeof current !== 'number' || !Number.isFinite(current)) return null;
  const min = range?.min ?? current;
  const max = range?.max ?? current;
  return Math.min(Math.max(current, min), max);
}

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
  /** Serializes `switchCamera` so concurrent calls cannot leak a stream. */
  private switching: Promise<void> = Promise.resolve();

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

  /**
   * Switch cameras without tearing down the loaded model.
   *
   * Serialized: two overlapping calls would each open a stream and the earlier
   * one would be overwritten without being stopped, leaking a camera (and
   * leaving its indicator light on).
   */
  async switchCamera(deviceId: string): Promise<void> {
    const previous = this.switching;
    let release!: () => void;
    this.switching = new Promise<void>((r) => {
      release = r;
    });
    await previous;

    try {
      this.options = { ...this.options, deviceId };
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.lastVideoTime = -1;
      await this.openCamera();
    } finally {
      release();
    }
  }

  private async openCamera(): Promise<void> {
    this.cb.onStatus({ message: 'Requesting camera…' });
    const { deviceId } = this.options;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: BASE_WIDTH },
          height: { ideal: BASE_HEIGHT },
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

    // Deliberately not awaited: the warm-up inside runs for a second or more,
    // and holding `start()` on it would delay the model load and the first
    // frame to buy nothing. Frames taken during the warm-up are as good as
    // today's — they are exactly today's.
    void this.lockCameraControls(this.stream);
  }

  /**
   * Pin the camera's automatic image controls, and take the sensor's full
   * resolution while we have the track in hand.
   *
   * The dominant light source on the subject's face is the screen, and its
   * content changes constantly. Left on automatic the camera re-meters every
   * time a dark window opens: gain and integration time step, the apparent
   * brightness of the iris/sclera boundary shifts with them, and MediaPipe's
   * iris centroid follows. `debug/eye-zoom.ts` prices that movement — one pixel
   * of iris localisation error is ~1.7% of the whole usable `gx` range, some
   * 33 px of cursor error on a 1920-wide screen. Nor can the filter take it
   * back out: ADR-0007's smoothing is aimed at zero-mean measurement noise, and
   * this is a step correlated with screen content.
   *
   * Resolution is here for the other half of the same arithmetic — the error is
   * quoted per *camera pixel*, so a sensor delivering 1920 wide instead of 1280
   * shrinks it by a third for free.
   *
   * Every group below is optional in practice. Support varies by camera and by
   * Chromium version, and macOS built-ins expose far less than USB cameras, so
   * each group is applied on its own inside its own try/catch: a rejected
   * white-balance lock must not cost us the exposure lock, and a camera that
   * supports none of them ends up precisely where it started.
   */
  private async lockCameraControls(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0];
    if (!track) return;

    const applied: string[] = [];
    const rejected: string[] = [];

    // Unimplemented on some platforms, `{}` on others. Both mean "ask for
    // nothing you were not going to ask for anyway".
    const caps: CameraControlCapabilities =
      typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};

    // `applyConstraints` replaces the track's entire constraint set, so the
    // format ideals ride along with every group. Pinning exposure with a bare
    // `{ exposureMode }` would drop the resolution request and let the source
    // fall back to its default format.
    //
    // All three stay `ideal` rather than `exact`: a camera whose maximum is
    // only reachable at 5 fps should quietly stay where it is, not fail.
    // Anchor to the aspect ratio the camera actually chose for itself, and ask
    // only for more *width*. Height follows from the two.
    //
    // Asking for `width.max` and `height.max` together looks obvious and is
    // wrong: `getCapabilities()` reports the largest value each dimension
    // reaches across *all* supported modes, and those two maxima need not
    // belong to the same mode. A 16:9 camera that also offers a square or
    // portrait mode can advertise `width.max === height.max`, and requesting
    // that pair asks for a format that does not exist. The browser then
    // satisfies it the only way it can — by cropping or rescaling — and the
    // first real measurement got exactly that: a 1552×1552 square stream from a
    // 16:9 laptop camera.
    //
    // That is far worse than the frame-rate trade this code was written to
    // avoid, because it is silent and it is geometric. A non-uniform squeeze
    // scales image x and y differently, and ADR-0005's whole premise is that
    // `gx` and `gy` are measured in a basis built from the eye's own corner
    // landmarks: distort the axes unevenly and the basis is no longer
    // orthonormal, roll invariance stops holding, and the horizontal and
    // vertical signals stop being comparable. Cropping instead of scaling is
    // milder but still throws away field of view at the sides, which is where
    // the head goes when the user shifts.
    const settled = track.getSettings();
    const nativeAspect =
      settled.width && settled.height ? settled.width / settled.height : BASE_WIDTH / BASE_HEIGHT;

    const format: MediaTrackConstraintSet = {
      width: { ideal: caps.width?.max ?? BASE_WIDTH },
      // `ideal` rather than `exact`: a camera that cannot hold this ratio at the
      // requested width should give us its nearest real mode, not fail.
      aspectRatio: { ideal: nativeAspect },
      frameRate: { ideal: 30, max: 60 },
    };

    const apply = async (group: string, set: CameraControlConstraintSet): Promise<boolean> => {
      // A run left over from a camera the user has since switched away from
      // must not touch the new stream, and an ended track throws.
      if (this.stream !== stream || track.readyState !== 'live') return false;
      try {
        await track.applyConstraints({ ...format, ...set });
        applied.push(group);
        return true;
      } catch (err) {
        rejected.push(`${group} [${(err as Error).name}]`);
        return false;
      }
    };

    // Resolution first: reconfiguring the sensor restarts its metering loop, so
    // pinning exposure before this would pin a value measured in a format we
    // are about to throw away.
    await apply('resolution', {});

    await warmUpAutoExposure(track);

    // `exposureMode: 'manual'` freezes the whole auto-exposure loop, gain
    // included — and gain is the half that actually moves the iris boundary,
    // since it scales noise along with signal.
    if (caps.exposureMode?.includes('manual')) {
      const settled = track.getSettings() as CameraControlSettings;
      const exposureTime = clampExposureTime(settled.exposureTime, caps.exposureTime);
      const pinned =
        exposureTime !== null &&
        (await apply('exposure+time', { exposureMode: 'manual', exposureTime }));
      // Drivers that accept the mode but reject the value are common enough to
      // be worth the second attempt — a step the sensor does not land on, or a
      // range that only holds in another format. The mode on its own still
      // stops the hunting, which is the point of the exercise.
      if (!pinned) await apply('exposure', { exposureMode: 'manual' });
    }

    // White balance moves the per-channel gains, which changes the sclera's
    // apparent brightness in the channels the landmark model reads even when
    // total luminance is held.
    if (caps.whiteBalanceMode?.includes('manual')) {
      await apply('white-balance', { whiteBalanceMode: 'manual' });
    }

    // Autofocus is the loudest of the three when it does fire: a hunt blurs the
    // iris rim for several frames, and the rim is what the refinement submodel
    // fits. Locked after the warm-up so it holds a focus found on the face
    // rather than on the wall behind it.
    if (caps.focusMode?.includes('manual')) {
      await apply('focus', { focusMode: 'manual' });
    }

    // Nothing to report to a loop that has been torn down, or about a stream
    // the user has already switched away from.
    if (this.disposed || this.stream !== stream) return;

    const settings = track.getSettings() as CameraControlSettings;
    const camera: CameraLockStatus = {
      width: settings.width ?? this.video.videoWidth,
      height: settings.height ?? this.video.videoHeight,
      frameRate: settings.frameRate ?? 0,
      exposureMode: settings.exposureMode ?? null,
      // The Image Capture spec measures `exposureTime` in 100 µs units, so 83
      // is 8.3 ms — a plausible indoor exposure — and not 83 ms, which at
      // 30 fps would be impossible.
      exposureTimeMs: typeof settings.exposureTime === 'number' ? settings.exposureTime / 10 : null,
    };

    // Once per opened stream. Which of these a camera honours is the first
    // thing to check when the same build tracks well on one machine and badly
    // on another, and it is not otherwise visible anywhere.
    console.info(
      `[vision] camera ${camera.width}×${camera.height} @ ${camera.frameRate.toFixed(0)} fps · ` +
        `applied: ${applied.join(', ') || 'none'} · rejected: ${rejected.join(', ') || 'none'} · ` +
        `exposure ${camera.exposureMode ?? 'unreported'}` +
        `${camera.exposureTimeMs === null ? '' : ` (${camera.exposureTimeMs.toFixed(1)} ms)`} · ` +
        `white balance ${settings.whiteBalanceMode ?? 'unreported'} · ` +
        `focus ${settings.focusMode ?? 'unreported'}`,
    );

    this.cb.onStatus({ camera });
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
    let faceLandmarks: readonly Landmark[] | null = null;
    let transform: ArrayLike<number> | undefined;
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
        transform = result.facialTransformationMatrixes?.[0]?.data;
        features = extractFeatures(
          { landmarks, blendshapes, transform },
          { swapEyes: this.options.swapEyes ?? false },
        );
        faceLandmarks = landmarks;
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
      this.cb.onFrame(this.buffer, features, this.inferenceMs, faceLandmarks, transform);
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
