/**
 * The disk half of the session recorder (ADR-0022).
 *
 * Lives in main because the renderer has no filesystem and must not be given
 * one (ADR-0002). Everything here is local: it creates a directory under
 * `userData`, writes PNGs and a JSONL sidecar into it, counts the bytes, and
 * deletes them on request. There is no network client in this file, and none
 * anywhere else in the recording path.
 *
 * The other constraint is that **main is on the tracking hot path**. Every
 * camera frame arrives here, goes through the Rust engine, and comes back out
 * as a cursor move; a synchronous `writeFileSync` of a 40 KB PNG would stall
 * that loop for as long as the disk took. So every write below is `fs/promises`
 * on a serialized chain, with a bound on how far behind it may fall.
 */

import { app, shell } from 'electron';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  FRAMES_DIR,
  MANIFEST_FILE,
  RECORDING_SCHEMA,
  RECORDS_FILE,
  CROP_FORMAT,
  CROP_HEIGHT,
  CROP_MARGIN,
  CROP_WIDTH,
  frameImagePath,
  sessionIdFor,
  type FrameRecord,
  type RecordedCamera,
  type RecordingStats,
  type SessionManifest,
} from '@eye-tracker/core';

/**
 * How many frame writes may be in flight before the store starts discarding.
 *
 * The renderer already drops frames it cannot encode in time, so reaching this
 * means the *disk* is the bottleneck, not the encoder. Eight frames is under a
 * second of data at the free-viewing rate — far enough behind to be worth
 * reporting, not so far that we buffer megabytes of images in main's heap while
 * the cursor waits behind them on the same event loop.
 */
const MAX_PENDING_WRITES = 8;

/** What the renderer knows and main does not, at the moment a session opens. */
export interface StartRecordingRequest {
  camera: RecordedCamera | null;
  video: { width: number; height: number };
  intervalMs: number;
  swapEyes: boolean;
}

/** One frame's payload. The renderer supplies pixels and metadata, never paths. */
export interface FrameWritePayload {
  /** Everything but the image paths, which main derives from `seq` itself. */
  record: Omit<FrameRecord, 'eyeA' | 'eyeB'>;
  eyeA: Uint8Array;
  eyeB: Uint8Array;
}

export interface StartedSession {
  sessionId: string;
  directory: string;
}

interface ActiveSession {
  id: string;
  directory: string;
  manifest: SessionManifest;
  records: WriteStream;
  frames: number;
}

/** Recursive byte total. Only walked when there is no live counter to trust. */
async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // A missing recordings directory is the normal, expected state.
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else {
      try {
        total += (await stat(path)).size;
      } catch {
        // Raced with a delete. Nothing to count.
      }
    }
  }
  return total;
}

export class RecordingStore {
  private session: ActiveSession | null = null;
  /** Serializes writes so records land in the order the renderer produced them. */
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  /** Frames discarded because the disk fell behind, distinct from encoder drops. */
  private droppedWrites = 0;
  /** Bytes across *all* sessions on disk, maintained live while recording. */
  private bytes = 0;
  private lastError: string | null = null;
  private stopping: Promise<RecordingStats> | null = null;

  /**
   * Notified when a session ends without the user asking — today only when the
   * disk cap is reached. The UI turns this into a banner, because a recorder
   * that stopped silently is indistinguishable from one that is still running,
   * and both directions of that confusion are bad.
   */
  private stopListener: ((reason: string) => void) | null = null;

  constructor(private capBytes: number) {}

  get active(): boolean {
    return this.session !== null;
  }

  get sessionId(): string | null {
    return this.session?.id ?? null;
  }

  onAutoStop(cb: (reason: string) => void): void {
    this.stopListener = cb;
  }

  setCapBytes(bytes: number): void {
    this.capBytes = bytes;
  }

  /** `<userData>/recordings`. One place, so "delete everything" is one `rm`. */
  root(): string {
    return join(app.getPath('userData'), 'recordings');
  }

  /**
   * Open a session directory and write its manifest.
   *
   * The manifest is written *first*, before any frames, so that a session
   * killed by a crash is still self-describing rather than being an anonymous
   * pile of eye images.
   */
  async start(
    request: StartRecordingRequest,
    context: { displayFingerprint: string },
  ): Promise<StartedSession> {
    if (this.session) throw new Error('a recording session is already open');

    const root = this.root();
    const now = new Date();

    // Two sessions in the same wall-clock second needs two clicks in one
    // second, but an id collision would silently interleave two recordings into
    // one directory, so it is cheap insurance.
    let id = sessionIdFor(now);
    for (let n = 2; await exists(join(root, id)); n++) id = `${sessionIdFor(now)}-${n}`;

    const directory = join(root, id);
    await mkdir(join(directory, FRAMES_DIR), { recursive: true });

    // Recompute from disk rather than trusting a stale counter: the user may
    // have deleted sessions from Finder since the last time we looked.
    this.bytes = await directoryBytes(root);

    const manifest: SessionManifest = {
      schema: RECORDING_SCHEMA,
      sessionId: id,
      appVersion: app.getVersion(),
      startedIso: now.toISOString(),
      startedWallMs: now.getTime(),
      // The renderer stamps every record with `performance.now()`, whose origin
      // is the renderer's own load time. Recording main's monotonic clock here
      // would be recording a *different* clock and inviting a wrong join, so
      // the origin is taken from the first record instead (see `write`).
      startedMonotonicMs: Number.NaN,
      camera: request.camera,
      video: request.video,
      crop: {
        width: CROP_WIDTH,
        height: CROP_HEIGHT,
        margin: CROP_MARGIN,
        format: CROP_FORMAT,
      },
      intervalMs: request.intervalMs,
      capBytes: this.capBytes,
      swapEyes: request.swapEyes,
      displayFingerprint: context.displayFingerprint,
    };

    await writeFile(join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    this.session = {
      id,
      directory,
      manifest,
      records: createWriteStream(join(directory, RECORDS_FILE), { flags: 'a' }),
      frames: 0,
    };
    this.droppedWrites = 0;
    this.lastError = null;

    console.info(`[recording] started ${id} in ${directory}`);
    return { sessionId: id, directory };
  }

  /**
   * Queue one frame. Never awaited by the caller, and never throws.
   *
   * Returning `void` is the contract, not an oversight: the renderer sends
   * these one-way precisely so that it cannot end up waiting on the disk
   * (ADR-0009 makes the same argument for `gaze:frame`).
   */
  write(payload: FrameWritePayload): void {
    const session = this.session;
    if (!session) return;

    const { seq } = payload.record;
    // The renderer never supplies a path. It supplies a sequence number, which
    // is validated here and turned into a filename by code main controls — a
    // renderer that had been compromised through the camera-facing surface must
    // not be able to name a file outside the session directory.
    if (!Number.isInteger(seq) || seq < 0) {
      this.lastError = `ignored a frame with a non-integer sequence number (${String(seq)})`;
      return;
    }

    if (this.pending >= MAX_PENDING_WRITES) {
      this.droppedWrites++;
      return;
    }

    if (!Number.isFinite(session.manifest.startedMonotonicMs)) {
      // Anchor the manifest to the renderer's clock using the first record, so
      // `tMs` values are interpretable without guessing at their origin.
      session.manifest.startedMonotonicMs = payload.record.tMs;
    }

    const record: FrameRecord = {
      ...payload.record,
      eyeA: frameImagePath(seq, 'a'),
      eyeB: frameImagePath(seq, 'b'),
    };

    this.pending++;
    this.chain = this.chain
      .then(() => this.writeOne(session, record, payload))
      .catch((err: unknown) => {
        this.lastError = (err as Error).message;
        console.error('[recording] write failed:', err);
      })
      .then(() => {
        this.pending--;
      });
  }

  private async writeOne(
    session: ActiveSession,
    record: FrameRecord,
    payload: FrameWritePayload,
  ): Promise<void> {
    // The session may have been stopped while this write sat in the chain.
    if (this.session !== session) return;

    const line = `${JSON.stringify(record)}\n`;
    await Promise.all([
      writeFile(join(session.directory, record.eyeA), payload.eyeA),
      writeFile(join(session.directory, record.eyeB), payload.eyeB),
    ]);
    session.records.write(line);

    session.frames++;
    this.bytes += payload.eyeA.byteLength + payload.eyeB.byteLength + Buffer.byteLength(line);

    // Stop *at* the cap rather than after it. Recording is opt-in and bounded
    // by an explicit promise to the user; overshooting it by even one session's
    // worth of images would break that promise in the one direction that
    // matters.
    if (this.bytes >= this.capBytes) {
      const reason = `disk cap of ${(this.capBytes / 1e6).toFixed(0)} MB reached`;
      void this.stop(reason).then(() => this.stopListener?.(reason));
    }
  }

  /**
   * Close the session, flushing whatever is still queued.
   *
   * Idempotent and re-entrant: the cap check calls it from inside the write
   * chain, and the user may hit Stop at the same moment.
   */
  async stop(reason: string): Promise<RecordingStats> {
    if (this.stopping) return this.stopping;
    const session = this.session;
    if (!session) return this.stats();

    this.stopping = (async () => {
      // Detach first so no further frames join the chain, then drain what is
      // already in it — those frames' images are already half-written.
      this.session = null;
      await this.chain.catch(() => undefined);

      await new Promise<void>((resolve) => {
        session.records.end(() => resolve());
      });

      const manifest: SessionManifest = {
        ...session.manifest,
        stoppedIso: new Date().toISOString(),
        frames: session.frames,
        dropped: this.droppedWrites,
        bytes: await directoryBytes(session.directory),
        stopReason: reason,
      };
      await writeFile(
        join(session.directory, MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      ).catch((err: unknown) => {
        this.lastError = `could not finalise the manifest: ${(err as Error).message}`;
      });

      console.info(
        `[recording] stopped ${session.id} — ${session.frames} frames, ` +
          `${this.droppedWrites} dropped at the disk, ${reason}`,
      );
      return this.stats();
    })();

    try {
      return await this.stopping;
    } finally {
      this.stopping = null;
    }
  }

  async stats(): Promise<RecordingStats> {
    const root = this.root();
    // While a session is open the live counter is both cheaper and more
    // accurate than a directory walk, which would race the writes in flight.
    const bytes = this.session ? this.bytes : await directoryBytes(root);
    if (!this.session) this.bytes = bytes;

    let sessions = 0;
    try {
      sessions = (await readdir(root, { withFileTypes: true })).filter((e) =>
        e.isDirectory(),
      ).length;
    } catch {
      sessions = 0;
    }

    return {
      active: this.session !== null,
      sessionId: this.session?.id ?? null,
      frames: this.session?.frames ?? 0,
      dropped: this.droppedWrites,
      bytes,
      capBytes: this.capBytes,
      sessions,
      lastError: this.lastError,
    };
  }

  /**
   * Remove every recording on this machine.
   *
   * Deliberately all-or-nothing and deliberately not undoable. A recorder that
   * writes pictures of someone's face has to have a delete that is easier to
   * use than the recorder itself; a per-session picker would be a better file
   * manager and a worse safety valve.
   */
  async deleteAll(): Promise<{ sessions: number; bytes: number }> {
    if (this.session) await this.stop('deleted while recording');

    const root = this.root();
    const before = await this.stats();
    await rm(root, { recursive: true, force: true });
    this.bytes = 0;

    console.info(`[recording] deleted ${before.sessions} session(s), ${before.bytes} bytes`);
    return { sessions: before.sessions, bytes: before.bytes };
  }

  /** Open the recordings folder so the user can see exactly what is there. */
  async reveal(): Promise<void> {
    const root = this.root();
    await mkdir(root, { recursive: true });
    await shell.openPath(root);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
