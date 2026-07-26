# ADR-0022: Opt-in, local-only recording of eye crops for offline training

- **Status:** Accepted
- **Date:** 2026-07-25

## Context

ADR-0009 puts the process boundary in exactly the right place for a learned
gaze estimator: pixels stay in the renderer, sixteen doubles cross to main. The
cost of that boundary is that **nothing keeps the pixels.** `extractFeatures()`
reduces a ~115×60 px eye region to two numbers and the rest is discarded on the
next frame.

That is fine for the geometric pipeline and fatal for everything after it. A
learned appearance model (#33), a learned uncertainty head (#34), and the
head-pose normalization that both depend on (#32) all need training data from
*this* user, *this* camera and *this* room — and no such data exists anywhere,
on any machine, today. ADR-0018 explicitly declined to build this ("no session
recording or offline refitting"), correctly, because at the time the question
was "why is it inaccurate" and six diagnostic views answered it. The question
now is "train something better", and that cannot be answered without pixels.

Three forces shape the design, and they pull against each other.

**1. This writes pictures of the user's face to disk.** Everything else in this
repository processes the camera and forgets it. A feature that keeps the frames
is a different kind of thing, and the risk is not a bug — it is a user who does
not realise it is on, or who cannot find what it wrote.

**2. The tracking loop must not pay for it.** Recording runs inside the
`requestVideoFrameCallback` tick that does MediaPipe inference and produces the
frame that moves the cursor. PNG encoding a 256×192 image is single-digit
milliseconds; at 30 fps the whole budget for a frame is 33 ms and inference
already takes 10–20 of them. Doing the encode on that thread would drop
tracking frames, which the user experiences as the cursor stuttering — for a
feature that is supposed to be invisible.

**3. The consumer does not exist yet.** It will be written later, probably in
Python, by someone who was not here. Anything clever costs more in
archaeology than it saves in bytes.

## Decision

### It is off, and there is no setting that turns it on

`SessionRecorder` is constructed with `recording = false` at every launch, and
there is deliberately **no `recordingEnabled` field in `Settings`**. Only the
disk cap is persisted. A remembered enablement would mean that a user who
recorded once is recorded every time they open the app, which is exactly the
failure the opt-in framing exists to prevent — and "I turned it off last
Tuesday" is not something anyone should have to remember.

### There is no upload path, anywhere

There is no HTTP client, no socket, no destination URL, and no configuration
field that could hold one, in `recorder.ts`, `recorder-worker.ts`,
`main/recordings.ts`, `scripts/recordings.mjs`, or the preload surface. The
preload API for recording is five channels wide and none of them takes a
destination. This is stated here so that a future change adding one is visibly
a change to a documented decision rather than a small convenience.

The renderer's CSP already forbids remote origins (ADR-0003 vendors the
MediaPipe assets precisely so the app needs no network at runtime), so an upload
from the camera-facing process would have to defeat that too.

### While it runs, it is unmissable — in two places

A persistent banner in the control window, using the existing `setBanner` /
`clearBanner` idiom, in its own `recording` level rather than borrowing the
error colour: an error is something the app failed to do, this is something the
app is doing to the user.

And a pulsing **RECORDING** badge on the click-through overlay. That one matters
more. The overlay is always-on-top, spans every display, and is visible on every
Space and over full-screen apps (ADR-0002) — it is the only surface in the app
guaranteed to be in front of someone whose control window is minimised. It
ignores the "show crosshair" preference, and it draws *over* the calibration
blackout, because a preference may hide the crosshair and nothing may hide this.

Both pulse. A static red mark in a familiar corner stops being seen within a
minute, and this is the one fact in the app that must not fade into the
furniture. Both honour `prefers-reduced-motion`.

### Deleting is one button, and also one command

`Delete all recordings` in the UI removes the whole `recordings` directory, and
`npm run recordings -- --delete` does the same from a terminal with a
confirmation prompt. Deliberately all-or-nothing: a per-session picker would be
a better file manager and a worse safety valve, and deleting must never require
launching an application that turns the camera on.

`npm run recordings` on its own lists what is there, including directories with
no manifest — an unexplained folder of face images is exactly what someone
auditing this wants named rather than hidden.

### One directory per session; PNG and JSONL, not a database

```
<userData>/recordings/20260725-143205/
  session.json      the manifest — camera, app version, crop geometry, cap
  frames.jsonl      one JSON object per recorded frame
  frames/000123-a.png, 000123-b.png
```

Six-digit zero-padded names so `ls` sorts chronologically. The manifest is
written **before** the first frame, so a session killed by a crash is still
self-describing; it is rewritten with the totals at stop.

**PNG, not JPEG.** The premise of the whole learned track is that the discarded
pixels contain the answer, and the pixels that carry it are the iris/sclera
boundary — a high-contrast edge a few pixels wide, which is exactly what a
perceptual codec is tuned to throw away. ADR-0018 prices one pixel of
localisation error at ~33 px of cursor error on a 1920-wide screen; recording
through a lossy encoder would be corrupting the measurement to save disk on a
machine that has plenty. It costs roughly 5× the bytes, and the cap bounds that.

**256×192 crops**, sized against the source rather than against any model's
input layer. The crop box is 2.1× the eye width (`CROP_MARGIN = 0.55`), so at
1280×720 it is ~242 px across and 256 is a 1.06× upsample — nothing is
discarded. At 1920×1080 the box is ~360 px and this is a 1.4× downsample, which
still leaves the eye ~122 px wide in the crop, no worse than the 720p case the
entire error budget is quoted against. Resizing to a network's preferred input
is the training script's job; doing it here would bake one architecture's
choice into data meant to outlive it.

### Raw crops plus pose, not pre-normalized crops

The Sugano/Zhang normalization of #32 is a lossy, parameter-laden warp, and it
does not exist yet. Applying today's version of it on the way to disk would make
every recorded session obsolete the first time it is improved. So each record
carries the raw crop, the crop rectangle in source pixels (which is what makes
the crop invertible), the full `GazeFeatures` struct, and MediaPipe's **4×4
facial transformation matrix**.

The matrix is the reason the vision callback grew a parameter. `GazeFeatures`
already has yaw/pitch/roll, but three Euler angles cannot be un-collapsed into
the rotation *and* translation a virtual-camera warp needs. Sixteen extra floats
per record is free next to two PNGs, and omitting them would make every session
useless for the one thing they exist to enable.

### The camera settings are part of the data

The manifest records the `CameraLockStatus` actually in effect — resolution,
frame rate, exposure mode, integration time — plus the camera's label. A session
recorded with exposure unlocked is *not the same data* as one recorded with it
locked: auto-exposure re-meters to whatever is on screen, and what is on screen
is correlated with where the user is looking — that is the whole argument for
`lockCameraControls` in `vision.ts`, and it applies with more force to recorded
data than to live tracking, because a training set can encode the correlation
permanently. Pooling locked and unlocked sessions without knowing which is which
mixes a nuisance variable straight into the label. `CameraLockStatus` moved from
`vision.ts` into the shared contracts for this reason.

`displayFingerprint` is in the manifest for the same reason it keys a
calibration profile (ADR-0006): the target coordinates are screen pixels, and
they mean nothing without the layout they were measured in.

### The hot path does four cheap things, and drops rather than waits

`SessionRecorder.capture()` runs on the vision loop and does exactly:

1. two comparisons to decide whether to record this frame,
2. two crop-box calculations — about a dozen multiplications,
3. one object literal, and
4. two `createImageBitmap` calls, which return immediately and perform the crop
   and resize on a browser-internal thread.

No pixel is touched on that thread, no canvas is read back, and nothing is
encoded. The bitmaps are then **transferred** (not copied) to a worker, which
draws them into an `OffscreenCanvas` and encodes the PNGs, and the bytes go to
main over a one-way `send` — the same argument that makes `gaze:frame` one-way
in ADR-0009: the renderer must never end up awaiting the disk.

Between those stages sits a bounded queue that **drops its oldest entry** when
full. This is the entire policy, and it is isolated in
`packages/core/src/recording/queue.ts` so it can be tested:

- Backpressure is the usual answer and is exactly wrong here, because the only
  thing that could absorb it is `requestVideoFrameCallback`.
- Dropping the *oldest* rather than the newest is deliberate: when the encoder
  has fallen behind, the newest frame is the one whose pixels still correspond
  to what the rest of the system is doing, and the stale ones at the back are
  the least useful data in the queue.
- The eviction callback closes the `ImageBitmap`, which holds GPU memory. At 20
  bitmaps a second, silently dropping one is a leak.

Main is on the hot path too — every camera frame goes through it into the Rust
engine and back out as a cursor move — so every write there is `fs/promises` on
a serialized chain with its own bound. A `writeFileSync` of a 40 KB PNG in main
would stall the cursor for as long as the disk took.

Dropped counts are reported in the UI, split by where they were dropped, because
the user is entitled to know that the recording is thinner than the elapsed time
suggests.

### Labelled frames are not rate-limited; free viewing is

Free viewing records at 10 Hz against a 30 fps camera: consecutive frames of a
fixation are very nearly the same picture, so the third that is kept carries
nearly all of the information for a third of the disk. Two PNGs is ~70 KB, so
10 Hz is ~42 MB per minute.

Frames taken while a calibration or validation target is **collecting** ignore
the interval entirely. Those are the labelled frames, a target collects for only
~700 ms, and 7 labelled samples per target instead of 21 would be a poor trade
for 0.2 MB.

Only the `collect` phase is labelled. During `instruct` there is no dot on
screen at all, and during `settle` the eye is still travelling to it — labelling
those frames would put the wrong answer next to the right pixels, which is the
one kind of error a training set cannot recover from.

### The cap is enforced by stopping, and by saying so

The cap applies to the whole `recordings` directory, not to one session;
otherwise ten sessions sail past a per-session limit. When the running total
reaches it, main closes the session, writes `stopReason` into the manifest, and
pushes a notice. Stopping *at* the cap rather than after it matters: recording is
bounded by an explicit promise to the user, and overshooting it by a session's
worth of images breaks that promise in the direction that counts.

Main is the authority on whether a session is open, and the renderer follows —
a UI still claiming to record into a session that main has closed would be worse
than no UI at all.

### The renderer never names a file

The renderer sends a sequence number; main validates it is a non-negative
integer and derives the filename itself with `frameImagePath()`. The
camera-facing renderer is the most exposed surface in the app (ADR-0002), and a
compromised one must not be able to choose a path.

## Consequences

### What this buys us

- Stage 3 of the roadmap becomes possible at all. #32, #33 and #34 are blocked
  on data that does not currently exist anywhere.
- A session directory is self-describing: someone holding only the directory can
  tell which camera, at what resolution, with exposure locked or not, from which
  app version, in which display layout.
- The eye-zoom debug view and the recorder now share one crop calculation, so
  the pixels a user inspects while judging "the tracking looks fine" are the
  pixels a model would later be trained on.

### What this costs us

- **A worker and a transfer protocol** for something that would have been six
  lines with a synchronous canvas. The cost is justified only by the hot-path
  constraint, and it is the main thing a reviewer should push back on if the
  measurement (which has not been taken — see below) says otherwise.
- **Disk.** ~42 MB per minute of free viewing, ~2.5 GB per hour. The cap makes
  it bounded and the readout makes it visible, but this is a genuinely large
  feature to leave running by accident, which is most of why it cannot be left
  running by accident.
- **A second privacy surface in the app.** ADR-0011 previously had one story:
  the app takes over the pointer. It now has two, and the second one is
  amended into it rather than living only here.
- **Sixteen extra floats and a wider vision callback** for a warp that does not
  exist yet. If #32 is never built, that is dead weight in the record.

### What we deliberately did not do

- **No click labels.** #30 will harvest implicit labels from real mouse clicks,
  and those belong in this record. They are not here because the feature that
  produces them is not built, and adding the field now would mean writing `null`
  into every record of every session for an unknown number of releases.
- **No compression of the JSONL, and no binary container.** The sidecar is
  ~1 KB per record against ~70 KB of images; the saving is noise and the cost is
  that you can no longer read it with `head`.
- **No automatic recording during calibration.** It is the single most valuable
  data the app produces, and turning the recorder on for the user "just for the
  calibration run" is precisely the silent enablement this ADR refuses.
- **No retention policy or automatic pruning.** Deleting data the user chose to
  record, without being asked, is its own kind of surprise. The cap stops
  growth; the user decides what goes.

### What has not been verified

The hot-path claim is a design argument, not a measurement. Nobody has run this
with a camera attached, so the acceptance criterion "recording on/off produces
no measurable change in tracked frame rate" is **untested**. The `s-fps` readout
in the control window is what to check it with, and if the number moves, the
first suspect is `createImageBitmap` on the vision thread — the fallback would be
to sample every Nth frame rather than on a wall-clock interval.

### What we would need to see to revisit this

- The recorder measurably costing tracking frames, which would mean the crop
  must move off the renderer thread entirely.
- A trained model needing a normalized crop *at capture time* to be viable,
  which would mean recording is no longer independent of #32 and this ADR's
  raw-crops argument was wrong.
- Users hitting the disk cap routinely during ordinary collection, which would
  mean either the rate or the crop size is set wrong.
