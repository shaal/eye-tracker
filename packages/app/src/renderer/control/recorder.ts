/**
 * Opt-in, local-only session recorder (ADR-0022).
 *
 * Captures the same eye-aligned crops the zoom view magnifies, plus the whole
 * feature struct and the head pose, so that a learned estimator (#33) has
 * training data taken from this user, this camera and this room. The crops are
 * recorded *raw* rather than pre-normalized: the Sugano/Zhang warp of #32 is a
 * lossy, parameter-laden transform, and baking today's version of it into the
 * data would make every recorded session obsolete the moment it is improved.
 *
 * ## What this does not do
 *
 * It does not send anything anywhere. There is no network client, no server
 * address, and no upload code path in this file or in anything it calls. The
 * only sink is the main process's filesystem writer.
 *
 * ## The hot-path rule
 *
 * `capture()` is called from inside the `requestVideoFrameCallback` tick that
 * also runs MediaPipe inference and produces the frame that moves the cursor.
 * Everything it does synchronously is bounded and small:
 *
 *   1. two comparisons to decide whether to record this frame at all,
 *   2. two crop-box calculations (a dozen multiplications),
 *   3. one object literal, and
 *   4. two `createImageBitmap` calls, which return immediately and do the crop
 *      and resize on a browser-internal thread.
 *
 * No pixel is touched, no canvas is read back, and nothing is encoded on this
 * thread. Everything after that runs on promise callbacks and in a worker.
 *
 * When any stage falls behind, the recorder throws frames away rather than
 * making the vision loop wait — the asymmetry is the whole design, and it is
 * isolated in `DropOldestQueue` where it can be tested.
 */

import {
  CROP_HEIGHT,
  CROP_WIDTH,
  DropOldestQueue,
  eyeCropBox,
  type CameraLockStatus,
  type CropBox,
  type FrameRecord,
  type GazeFeatures,
  type RecordedTarget,
  type RecordingStats,
} from '@eye-tracker/core';

/**
 * Minimum spacing between recorded frames while the user is just looking
 * around, in milliseconds.
 *
 * 10 Hz, against a camera running at 30. Consecutive frames of a fixation are
 * very nearly the same picture, so the third of them that is kept carries
 * almost all of the information for a third of the disk — and disk is the
 * binding constraint here: two 256×192 PNGs is roughly 70 KB, so 10 Hz is about
 * 42 MB per minute.
 *
 * Frames taken while a calibration or validation target is collecting ignore
 * this entirely. Those are the labelled frames, a target collects for only
 * ~700 ms, and 7 labelled samples per target instead of 21 would be a poor
 * trade for 0.2 MB.
 */
const FREE_VIEWING_INTERVAL_MS = 100;

/**
 * How many frames may be waiting for `createImageBitmap` to resolve at once.
 *
 * Three is deliberately tight. The bitmap is a snapshot of a video frame that
 * the decoder is free to recycle, so a deep backlog here is both memory the
 * compositor cannot reclaim and data that is going stale; if we are three
 * frames behind on a call that should take under a millisecond, something is
 * badly wrong and the right response is to skip, not to accumulate.
 */
const MAX_AWAITING_BITMAPS = 3;

/**
 * How many encoded-and-waiting frames the queue holds before evicting.
 *
 * Four frames is 400 ms of free viewing — long enough to ride out a slow PNG
 * encode or a stalled disk, short enough that the images still on the queue
 * when it overflows are not worth keeping anyway.
 */
const ENCODE_QUEUE_CAPACITY = 4;

/** Everything the recorder knows about itself, for the UI. */
export interface RecorderUiState {
  active: boolean;
  sessionId: string | null;
  /** Frames written to disk, as reported by main. */
  frames: number;
  /** Dropped in the renderer, before the frame ever reached main. */
  droppedLocal: number;
  /** Dropped by main because the disk fell behind. */
  droppedDisk: number;
  bytes: number;
  capBytes: number;
  sessions: number;
  message: string | null;
}

export interface RecorderContext {
  camera: CameraLockStatus | null;
  cameraLabel: string;
  swapEyes: boolean;
}

interface QueuedFrame {
  record: Omit<FrameRecord, 'eyeA' | 'eyeB'>;
  a: ImageBitmap;
  b: ImageBitmap;
}

interface EncodeResult {
  seq: number;
  a: ArrayBuffer | null;
  b: ArrayBuffer | null;
  error: string | null;
}

/**
 * `createImageBitmap`'s crop rectangle is integral, so round before recording
 * the box rather than after. A recorded rectangle that is not the rectangle
 * actually cropped would put a sub-pixel lie into every offline warp.
 */
function integerBox(box: CropBox): CropBox {
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
  };
}

export class SessionRecorder {
  /**
   * Off, always, at construction.
   *
   * There is no persisted "was recording" flag anywhere in the app, and adding
   * one would defeat the point: enabling this must be a deliberate act taken
   * once per session by someone who knows they are doing it, not a preference
   * that quietly survives a restart (ADR-0011).
   */
  private recording = false;

  private worker: Worker | null = null;
  private readonly queue = new DropOldestQueue<QueuedFrame>(
    ENCODE_QUEUE_CAPACITY,
    (frame) => {
      frame.a.close();
      frame.b.close();
    },
  );

  private busy = false;
  /** The record whose images the worker is currently encoding. */
  private inFlight: Omit<FrameRecord, 'eyeA' | 'eyeB'> | null = null;
  private awaiting = 0;
  private seq = 0;
  private lastCaptureMs = Number.NEGATIVE_INFINITY;
  private droppedLocal = 0;
  private sessionId: string | null = null;
  private message: string | null = null;
  private pollTimer = 0;

  private state: RecorderUiState = {
    active: false,
    sessionId: null,
    frames: 0,
    droppedLocal: 0,
    droppedDisk: 0,
    bytes: 0,
    capBytes: 0,
    sessions: 0,
    message: null,
  };

  constructor(private readonly onChange: (state: RecorderUiState) => void) {}

  get active(): boolean {
    return this.recording;
  }

  async start(video: HTMLVideoElement, context: RecorderContext): Promise<void> {
    if (this.recording) return;
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error('the camera has not produced a frame yet');
    }

    const started = await window.eyeTracker.startRecording({
      camera: context.camera ? { ...context.camera, label: context.cameraLabel } : null,
      video: { width: video.videoWidth, height: video.videoHeight },
      intervalMs: FREE_VIEWING_INTERVAL_MS,
      swapEyes: context.swapEyes,
    });

    this.worker ??= new Worker(new URL('./recorder-worker.ts', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = (event: MessageEvent<EncodeResult>) => this.onEncoded(event.data);

    this.seq = 0;
    this.droppedLocal = 0;
    this.queue.resetDropped();
    this.lastCaptureMs = Number.NEGATIVE_INFINITY;
    this.sessionId = started.sessionId;
    this.message = null;
    this.recording = true;

    // A visible size readout is part of the bargain: the user agreed to a
    // bounded amount of disk, so they get to watch it being used.
    this.pollTimer = window.setInterval(() => void this.refresh(), 1000);
    await this.refresh();
  }

  async stop(reason = 'stopped by the user'): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    if (this.pollTimer) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = 0;
    }
    // Frames still queued belong to a session that is closing. Sending them
    // would race the manifest rewrite for no benefit.
    this.queue.clear();
    this.busy = false;

    const stats = await window.eyeTracker.stopRecording();
    this.sessionId = null;
    this.message = reason;
    this.apply(stats);
  }

  /**
   * Called from the vision loop, once per camera frame. See the hot-path rule
   * at the top of this file.
   *
   * `transform` is MediaPipe's 4×4 facial transformation matrix. It is not part
   * of `GazeFeatures` — the live pipeline only needs the three Euler angles —
   * but the offline normalization warp needs the full matrix, so it is threaded
   * through the vision callback purely for this.
   */
  capture(
    video: HTMLVideoElement,
    features: GazeFeatures,
    transform: ArrayLike<number> | undefined,
    target: RecordedTarget | null,
    tMs: number,
  ): void {
    if (!this.recording || !features.ok) return;

    // Labelled frames are never rate-limited; free viewing is.
    if (!target && tMs - this.lastCaptureMs < FREE_VIEWING_INTERVAL_MS) return;

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const aspect = CROP_HEIGHT / CROP_WIDTH;
    const rawA = eyeCropBox(features.eyeA, vw, vh, aspect);
    const rawB = eyeCropBox(features.eyeB, vw, vh, aspect);
    if (!rawA || !rawB) return;

    if (this.awaiting >= MAX_AWAITING_BITMAPS) {
      this.droppedLocal++;
      return;
    }

    const cropA = integerBox(rawA);
    const cropB = integerBox(rawB);
    this.lastCaptureMs = tMs;

    const record: Omit<FrameRecord, 'eyeA' | 'eyeB'> = {
      // Incremented here rather than at write time, so a dropped frame leaves a
      // gap in the filenames. A directory that silently renumbered would hide
      // exactly the fact the dropped-frame counter exists to surface.
      seq: this.seq++,
      tMs,
      wallMs: Date.now(),
      cropA,
      cropB,
      // Safe to hold by reference: `extractFeatures` allocates a fresh struct
      // per frame and nothing downstream mutates it. The clone happens once, at
      // the IPC boundary, rather than on this thread now.
      features,
      // `Array.from` on 16 floats. Kept as a plain array so the JSONL line is
      // readable rather than being a typed-array shaped object.
      headTransform: transform ? Array.from(transform) : null,
      target,
    };

    this.awaiting++;
    // `allSettled`, not `all`: if one eye's bitmap resolves and the other
    // rejects, `all` would reject and lose the reference to the one that
    // succeeded — leaking GPU memory that only `close()` releases.
    void Promise.allSettled([this.grab(video, cropA), this.grab(video, cropB)]).then(
      ([resultA, resultB]) => {
        this.awaiting--;
        const a = resultA?.status === 'fulfilled' ? resultA.value : null;
        const b = resultB?.status === 'fulfilled' ? resultB.value : null;

        // Either a half-captured frame, or the session stopped while the
        // bitmaps were being made. Both are ordinary at teardown: the video
        // element can be reconfigured between the call and its resolution.
        if (!a || !b || !this.recording) {
          a?.close();
          b?.close();
          if (!a || !b) this.droppedLocal++;
          return;
        }

        this.queue.push({ record, a, b });
        this.pump();
      },
    );
  }

  private grab(video: HTMLVideoElement, box: CropBox): Promise<ImageBitmap> {
    // The crop and the resize both happen inside this call, off this thread.
    // Doing them with `drawImage` into a canvas here would put a scale-and-copy
    // of every recorded frame directly on the vision loop.
    return createImageBitmap(video, box.x, box.y, box.width, box.height, {
      resizeWidth: CROP_WIDTH,
      resizeHeight: CROP_HEIGHT,
      resizeQuality: 'high',
    });
  }

  /** One frame in the worker at a time; the queue absorbs the rest. */
  private pump(): void {
    if (this.busy || !this.worker) return;
    const next = this.queue.shift();
    if (!next) return;
    this.busy = true;
    this.inFlight = next.record;
    // The bitmaps are transferred, not copied — after this line they are
    // detached here and owned by the worker, which closes them.
    this.worker.postMessage({ seq: next.record.seq, a: next.a, b: next.b }, [next.a, next.b]);
  }

  private onEncoded(result: EncodeResult): void {
    const record = this.inFlight;
    this.inFlight = null;
    this.busy = false;

    if (record && result.a && result.b && this.recording) {
      // One-way, never awaited: the renderer must not be able to end up waiting
      // on main's disk, for the same reason `gaze:frame` is one-way (ADR-0009).
      window.eyeTracker.recordFrame({ record, eyeA: result.a, eyeB: result.b });
    } else if (result.error) {
      this.droppedLocal++;
      this.message = `encoder: ${result.error}`;
    }

    this.pump();
  }

  /** Pull the disk-side counters and publish a merged state to the UI. */
  async refresh(): Promise<void> {
    this.apply(await window.eyeTracker.getRecordingStats());
  }

  /** Adopt a stats snapshot pushed by main — including one it stopped itself. */
  apply(stats: RecordingStats): void {
    // Main is the authority on whether a session is open: it is the side that
    // stops when the disk cap is hit, and the UI must follow rather than keep
    // claiming to record into a session that has closed.
    if (this.recording && !stats.active) {
      this.recording = false;
      if (this.pollTimer) {
        window.clearInterval(this.pollTimer);
        this.pollTimer = 0;
      }
      this.queue.clear();
      this.busy = false;
      this.sessionId = null;
    }

    this.state = {
      active: this.recording,
      sessionId: this.sessionId ?? stats.sessionId,
      frames: stats.frames,
      droppedLocal: this.droppedLocal + this.queue.dropped,
      droppedDisk: stats.dropped,
      bytes: stats.bytes,
      capBytes: stats.capBytes,
      sessions: stats.sessions,
      message: stats.lastError ?? this.message,
    };
    this.onChange(this.state);
  }

  get snapshot(): RecorderUiState {
    return this.state;
  }
}
