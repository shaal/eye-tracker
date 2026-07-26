/**
 * PNG encoder for the session recorder (ADR-0022).
 *
 * This exists for one reason: PNG encoding is CPU-bound and synchronous
 * somewhere, and the only thread it must never be on is the one running
 * `requestVideoFrameCallback`. That thread does MediaPipe inference and drives
 * the cursor; a dropped recording frame is free, a dropped tracking frame is
 * not (ADR-0022).
 *
 * The renderer hands over `ImageBitmap`s, which are *transferable* — the crop
 * and resize have already happened off-thread inside `createImageBitmap`, so no
 * pixel data is copied on the vision loop's thread and none is copied here.
 */

import { CROP_FORMAT, CROP_HEIGHT, CROP_WIDTH } from '@eye-tracker/core';

interface EncodeRequest {
  seq: number;
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
 * `DedicatedWorkerGlobalScope` lives in TypeScript's webworker lib, which this
 * package deliberately does not load — the renderer tsconfig carries the DOM
 * lib so that the rest of the control window typechecks. Naming the two members
 * actually used is more honest than pulling in a second, conflicting global
 * environment for them.
 */
interface WorkerScope {
  onmessage: ((event: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(message: EncodeResult, transfer: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;

// One canvas for the life of the worker. Requests are handled strictly one at a
// time, so there is no window in which two frames could share it.
const canvas = new OffscreenCanvas(CROP_WIDTH, CROP_HEIGHT);
const ctx = canvas.getContext('2d');

async function encode(bitmap: ImageBitmap): Promise<ArrayBuffer> {
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

  // Cleared rather than overwritten: the crop box is allowed to extend past the
  // camera frame (see `eyeCropBox`), and those pixels arrive transparent. Left
  // over from the previous frame they would paste one eye onto another's
  // margin, which is the kind of corruption a training script cannot detect.
  ctx.clearRect(0, 0, CROP_WIDTH, CROP_HEIGHT);
  ctx.drawImage(bitmap, 0, 0, CROP_WIDTH, CROP_HEIGHT);

  const blob = await canvas.convertToBlob({ type: CROP_FORMAT });
  return blob.arrayBuffer();
}

scope.onmessage = (event: MessageEvent<EncodeRequest>) => {
  const { seq, a, b } = event.data;
  void (async () => {
    try {
      // Sequential, because both share the one canvas.
      const encodedA = await encode(a);
      const encodedB = await encode(b);
      scope.postMessage({ seq, a: encodedA, b: encodedB, error: null }, [encodedA, encodedB]);
    } catch (err) {
      // Reported rather than thrown: the renderer is waiting for a reply before
      // it will send the next frame, so a silent failure here would stall the
      // recorder for the rest of the session.
      scope.postMessage({ seq, a: null, b: null, error: (err as Error).message }, []);
    } finally {
      // GPU-backed memory. Closing is not optional at 20 bitmaps a second.
      a.close();
      b.close();
    }
  })();
};
