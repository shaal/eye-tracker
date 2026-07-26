/**
 * On-disk format for a recorded training session (ADR-0022).
 *
 * The consumer of this format is an offline training script that does not exist
 * yet, will be written in another language, and will be read by someone who was
 * not here when it was designed. Everything below is therefore chosen for
 * obviousness over efficiency: one directory per session, one PNG per eye per
 * frame, one JSON object per line in a sidecar, and a manifest that says what
 * hardware and what settings produced it.
 *
 * Nothing in this module does I/O, and nothing anywhere in this repository
 * sends any of it off the machine.
 */

import type { CameraLockStatus } from '../types.js';
import type { GazeFeatures } from '../vision/features.js';

/**
 * Bumped whenever a field changes meaning rather than merely being added.
 *
 * A training script that silently mixes two incompatible vintages of data
 * produces a model that is wrong in a way no test will catch, so the version
 * is written into every manifest and is expected to be asserted on load.
 */
export const RECORDING_SCHEMA = 'eye-tracker/session-recording@1';

/** Files inside a session directory, relative to it. */
export const MANIFEST_FILE = 'session.json';
export const RECORDS_FILE = 'frames.jsonl';
export const FRAMES_DIR = 'frames';

/**
 * Output size of a recorded eye crop, in pixels.
 *
 * Chosen against the source, not against a model's input layer. At 1280×720 the
 * crop box is ~242 px across (see `CROP_MARGIN`), so 256 is a 1.06× upsample —
 * no sensor detail is discarded. At 1920×1080 the box is ~360 px and this is a
 * 1.4× downsample, which still leaves the eye ~122 px wide in the crop, i.e. no
 * worse than the 720p case that the whole error budget in ADR-0018 is quoted
 * against.
 *
 * Resizing to a model's preferred input is the training script's job. Doing it
 * here would bake one architecture's choice into data meant to outlive it.
 */
export const CROP_WIDTH = 256;
export const CROP_HEIGHT = 192;

/**
 * PNG, not JPEG.
 *
 * The premise of the entire learned-estimation track (#33) is that the
 * discarded pixels contain the answer, and the specific pixels that carry it
 * are the iris/sclera boundary — a high-contrast edge a few pixels wide. That
 * is exactly what a perceptual codec is tuned to throw away. ADR-0018 prices
 * one pixel of localisation error at ~33 px of cursor error, so recording
 * through a lossy encoder would be corrupting the measurement to save disk on a
 * machine that has plenty. Costs roughly 5× the bytes; the disk cap bounds it.
 */
export const CROP_FORMAT = 'image/png';

/** A rectangle in the camera frame's own pixel coordinates. */
export interface RecordedCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The camera lock state, plus which camera it was.
 *
 * In the manifest because a session recorded with exposure unlocked is *not the
 * same data* as one recorded with it locked: auto-exposure re-meters to
 * whatever is on screen, which is correlated with where the user is looking.
 * Training on both together without knowing which is which mixes a nuisance
 * variable straight into the label.
 */
export interface RecordedCamera extends CameraLockStatus {
  /** The camera's own label, so "which camera was this?" is answerable. */
  label: string;
}

/**
 * The screen point the user was being asked to look at, when there was one.
 *
 * This is the label. `null` means free viewing — still useful for
 * self-supervised work (#36), useless for supervised fitting.
 */
export interface RecordedTarget {
  kind: 'calibration' | 'validation';
  /** Screen coordinates, in the display layout named by `displayFingerprint`. */
  x: number;
  y: number;
  index: number;
  /**
   * A head-motion calibration target (ADR-0015): the user is holding gaze on
   * the dot while deliberately moving their head. The label is still valid, but
   * the pose distribution is not representative, so a consumer may want to
   * weight or hold out these frames separately.
   */
  headMotion: boolean;
}

/** One line of `frames.jsonl`. */
export interface FrameRecord {
  seq: number;
  /**
   * Monotonic milliseconds, from the same clock and the same instant as
   * `FRAME_SLOTS.TIMESTAMP` on the frame that produced these pixels (ADR-0009).
   * That is what lets a recorded frame be joined to anything else stamped on
   * the renderer's clock.
   */
  tMs: number;
  /** Wall clock, for correlating with logs only. Not monotonic; do not diff. */
  wallMs: number;
  /** Paths relative to the session directory. */
  eyeA: string;
  eyeB: string;
  /**
   * Where each crop came from in the full camera frame. Recorded rather than
   * recomputed because it is what makes the crop invertible: a normalization
   * warp applied offline (#32) needs to map back into frame coordinates.
   */
  cropA: RecordedCrop;
  cropB: RecordedCrop;
  /** The complete feature struct the live pipeline computed for this frame. */
  features: GazeFeatures;
  /**
   * MediaPipe's 4×4 facial transformation matrix, column-major, or `null` when
   * the model did not emit one.
   *
   * `features` already carries yaw/pitch/roll, but those are a lossy summary:
   * the Sugano/Zhang normalization of #32 needs the full rotation and
   * translation to build the virtual-camera warp. Recording sixteen extra
   * numbers per frame is free next to the images, and not recording them would
   * make every session useless for the one thing they exist to enable.
   */
  headTransform: number[] | null;
  target: RecordedTarget | null;
}

/** `session.json`. Written at start, rewritten with the totals at stop. */
export interface SessionManifest {
  schema: string;
  sessionId: string;
  /** App version, so a behaviour change can be attributed to a code change. */
  appVersion: string;
  startedIso: string;
  startedWallMs: number;
  /** Monotonic clock at session start, the origin for every record's `tMs`. */
  startedMonotonicMs: number;
  camera: RecordedCamera | null;
  /** What the video element actually decoded, which can differ from `camera`. */
  video: { width: number; height: number };
  crop: {
    width: number;
    height: number;
    margin: number;
    format: string;
  };
  /**
   * Minimum spacing between recorded frames while free-viewing. Frames taken
   * while a calibration or validation target is collecting ignore it — see
   * ADR-0022.
   */
  intervalMs: number;
  capBytes: number;
  /** Whether eye A/B were swapped for gesture purposes (ADR-0013). */
  swapEyes: boolean;
  /**
   * The display layout every `target` coordinate is expressed in. A recording
   * made on one layout cannot be pooled with one made on another without
   * re-projecting the labels (ADR-0006).
   */
  displayFingerprint: string;
  stoppedIso?: string;
  /** Records actually written. */
  frames?: number;
  /** Frames the recorder deliberately discarded to protect the vision loop. */
  dropped?: number;
  bytes?: number;
  stopReason?: string;
}

/** Live counters, for the UI readout. */
export interface RecordingStats {
  active: boolean;
  sessionId: string | null;
  frames: number;
  dropped: number;
  /** Bytes used by *all* recordings on disk, not just the active session. */
  bytes: number;
  capBytes: number;
  sessions: number;
  lastError: string | null;
}

/**
 * `20260725-143205` — sortable, unambiguous, and readable in a file listing.
 *
 * Local time rather than UTC: the person who has to find "the session I
 * recorded after lunch" is sitting in the local timezone, and the manifest
 * carries an absolute timestamp for anything that needs one.
 */
export function sessionIdFor(at: Date): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0');
  return (
    `${p(at.getFullYear(), 4)}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
  );
}

/**
 * `frames/000123-a.png`. Zero-padded so a plain `ls` sorts chronologically,
 * which is the difference between a directory you can skim and one you cannot.
 *
 * Six digits is 27 hours at the 10 Hz free-viewing rate, well past the point
 * where the disk cap has stopped the session.
 */
export function frameImagePath(seq: number, eye: 'a' | 'b'): string {
  return `${FRAMES_DIR}/${String(seq).padStart(6, '0')}-${eye}.png`;
}
