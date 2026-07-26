/**
 * A bounded queue that drops its *oldest* entry when full.
 *
 * This is the whole of the recorder's hot-path policy, isolated so it can be
 * tested (ADR-0022). The asymmetry it encodes is the point: the vision loop
 * drives the cursor, so a recording frame that cannot be encoded in time must
 * be thrown away rather than made to wait. Backpressure — the usual answer —
 * would be exactly wrong here, because the only thing that could absorb it is
 * `requestVideoFrameCallback`.
 *
 * Dropping the *oldest* rather than the newest is deliberate. When the encoder
 * has fallen behind, the newest frame is the one whose pixels still correspond
 * to something the rest of the system is doing right now; the stale ones at the
 * back of the queue are the least useful data in it.
 */
export class DropOldestQueue<T> {
  private readonly items: T[] = [];
  private droppedCount = 0;

  /**
   * `onDrop` is not a notification — it is where the caller releases whatever
   * the dropped item owns. The recorder queues `ImageBitmap`s, which hold GPU
   * memory until `close()` is called on them, so silently discarding one would
   * leak until GC eventually got round to it.
   */
  constructor(
    readonly capacity: number,
    private readonly onDrop?: (item: T) => void,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`DropOldestQueue capacity must be a positive integer, got ${capacity}`);
    }
  }

  /** Returns false when something had to be dropped to make room. */
  push(item: T): boolean {
    let madeRoom = true;
    while (this.items.length >= this.capacity) {
      const evicted = this.items.shift();
      this.droppedCount++;
      madeRoom = false;
      if (evicted !== undefined) this.onDrop?.(evicted);
    }
    this.items.push(item);
    return madeRoom;
  }

  shift(): T | undefined {
    return this.items.shift();
  }

  /** Release everything still queued. Does not count as dropping. */
  clear(): void {
    for (const item of this.items) this.onDrop?.(item);
    this.items.length = 0;
  }

  get length(): number {
    return this.items.length;
  }

  /** Cumulative evictions, for the UI. Survives `clear()`. */
  get dropped(): number {
    return this.droppedCount;
  }

  resetDropped(): void {
    this.droppedCount = 0;
  }
}
