# ADR-0024: A diagnostics bundle designed to be shared

- **Status:** Accepted
- **Date:** 2026-07-25
- **Extends:** [ADR-0018](0018-diagnostics-and-validation.md), which produced the
  numbers. This ADR is only about getting them off the machine.
- **Deliberate opposite of:** [ADR-0022](0022-local-session-recording.md), which
  records images and must never be shared. The contrast is the point and is
  written into the code.

## Context

ADR-0018 built six diagnostic views and a validation pass that produce genuinely
diagnostic figures: per-target bias vectors *with direction*, precision measured
about the cloud centroid rather than about the target, the quiet-period noise
floor, the `pxPerGx` sensitivity that turns that noise floor into cursor pixels.
ADR-0021 added the calibration weight distribution on top.

Every one of those numbers is rendered to a canvas and then lost. There is no
clipboard path, no JSON export and no file dump anywhere in
`renderer/control/`.

That makes remote diagnosis impossible. The person with the camera can see the
arrow map; nobody helping them can. Every accuracy conversation degrades into
prose descriptions of a picture — *"the arrows kind of point up-left"* — which is
exactly the ambiguity ADR-0018 was written to eliminate. The one artefact that
can settle the question is a picture that cannot be pasted and would not carry
the numbers if it were.

The timing makes it acute. Tracking quality has never been measured on a real
face (#2), and three merged changes ship with off-switches *specifically* so
they can be A/B'd: the camera exposure lock (#41), the quality-weighted
calibration fit (ADR-0021), and confidence-modulated filter trust (ADR-0023). An
A/B is only worth running if the two results can be put side by side by someone
who can act on the difference. Today they cannot leave the room they were
measured in.

## Decision

A **Copy diagnostics** action next to *Run validation* serializes the current
diagnostic state, writes it to a file, and puts a compact summary on the
clipboard.

### The bundle is numbers only, and that is a design constraint

**No images. No landmark coordinates. Nothing from which a face could be
reconstructed.** A bundle that cannot reconstruct a face is one a user can paste
into a public issue without stopping to think, and that property is worth
protecting deliberately rather than holding by accident.

It is enforced structurally rather than by review. `buildDiagnosticsBundle`
copies every field **by name** from a typed input; there is no `...spread` of a
caller-supplied object anywhere in the path, so a struct that grows a thumbnail
upstream cannot leak one downstream. `bundle.test.ts` builds a bundle from a
deliberately contaminated input carrying a PNG data URI, a landmark array and a
raw frame, and asserts that none of them survive — checking field *names* as well
as values, so a future `eyeCrop` field would fail even if its contents happened
to be numeric.

This is the exact inverse of ADR-0022. That recorder writes PNGs of the user's
eyes, is off at every launch, and has no network code anywhere in its path. This
bundle carries no pixels and exists to be shared. Neither posture makes sense
without the other being stated, so both files say so in their headers and in the
preload contract that separates them.

### The tuning is read back from the engine, not from the UI

`getTuning()` calls through to Rust's `EngineConfigView`. The whole value of the
bundle for an A/B is knowing what the engine was *actually running*, and the UI's
idea of that has already been wrong once: ADR-0021's `qualityWeighting` was
settable in the type, storable in settings, and silently dropped on the way to
the engine for two releases (fixed in #48). A bundle sourced from the UI would
have recorded the knob's position rather than its effect, and the resulting A/B
would have compared two identical runs.

The A/B switches are additionally **hoisted** into an `abSwitches` block near the
top of the file. It is a strict projection of `tuning` — same values, never
sourced independently, asserted equal by test — bought because the thing this
bundle exists for is diffing two runs with one flag flipped, and a diff that
lands in the middle of forty tuning keys is a diff nobody reads.

### Signal statistics are in, despite living in the renderer

The noise floor and `pxPerGx` are the highest-value fields for anyone reading a
bundle cold, and they were the easiest to leave out: `SignalStats` is a rolling
buffer in `renderer/control/debug/`, on the far side of an IPC boundary from
everything else in the bundle.

They are in because they are what separates *"the sensor cannot resolve the
iris"* from *"the mapping is wrong"* — the one distinction ADR-0018 exists to
make, and the one that decides between buying a camera and recalibrating. The
conversion is applied before serialization, too: `noiseGx = 0.0041` means nothing
to a reader, while `±22 px` is a finding. A reader who has to do arithmetic to
reach the finding will not do it.

`resolvableSteps` moved to `packages/core` and is re-exported by the renderer, so
that the figure a user quotes in a bug report is the same figure they were
looking at when they decided to file it.

### The arrow map, in words

A remote reader has the numbers but not the picture, and a list of thirteen bias
vectors is not something a human pattern-matches reliably. `describeBiasPattern`
therefore names the shape: uniform offset (and its direction), outward splay,
inward compression, one bad point, or no consistent direction — the same four
readings `debug/validation-view.ts` documents, each with a different remedy.

It is phrased as a *description*, not an instruction. Whether the pattern is
worth acting on belongs to `advice`, which knows the verdict bands: a run can be
graded good and still have a small uniform offset, and telling that user to
recalibrate would contradict the line above it.

### Clipboard and file carry different things

The full bundle is 6–10 KB of JSON without the raw clouds and upwards of 80 KB
with them. That is a fine thing to attach and a terrible thing to paste — nobody
scrolls past forty lines of JSON to find the finding.

So the **file** gets everything and the **clipboard** gets `formatBundleSummary`:
about thirty lines stating the A/B switch positions, the noise floor, and
accuracy and precision side by side, ending with the path to the full file. One
formatter serves the clipboard and `scripts/diagnostics.mjs` both, so a
conversation cannot proceed with the two participants reading different summaries
of the same file.

The renderer shows that summary in the panel after exporting. A privacy promise
the user cannot check before they paste is not worth much.

### Every float is rounded

Pixels to two decimals, degrees to three, gaze-feature units to six. Unrounded
f64s differ in the last digit on every line, which turns the two-line diff of an
A/B into a hundred-line one and buries the finding. A test asserts that two
bundles differing only in `confidenceTrust` differ in exactly two lines.

Non-finite values become `null` rather than being left to `JSON.stringify`, which
writes `null` for NaN anyway. Doing it explicitly makes the *type* say so, and
NaN is a normal outcome here: every degree figure is NaN when the display
geometry was unavailable, which ADR-0018 is careful to distinguish from a bad
grade.

### It never refuses

No calibration, no validation run, no signal statistics — a bundle is still
produced, and each absent section names itself in `notes`. A user who cannot get
through calibration is reporting the most interesting failure there is, and an
exporter that declined without one would drop exactly that case on the floor.

### The raw clouds are behind a flag

They let a reader re-derive every statistic instead of trusting ours, which is
worth a great deal when the disagreement is about whether the statistics are
right. They are also about 90% of the bytes, which the test asserts rather than
assumes. Off by default; a checkbox turns them on.

## Consequences

### What this costs

- **Two new IPC channels**, `diagnostics:export` and `diagnostics:reveal`.
  Neither takes a URL, a destination or a path: the renderer supplies
  measurements, main derives the filename from its own clock and writes to one
  directory it names itself — the same rule the recorder applies to `seq`.
- **A third consumer of `ValidationReport`'s shape.** The canvas, the HTML
  report and now the bundle all read it. The bundle is the one that is
  versioned, so a field that changes meaning now costs a `schemaVersion` bump.
- **A `<userData>/diagnostics` directory** that grows by ~10 KB per export and
  is never pruned. At a click per export that is not a disk problem, and an
  automatic delete of files a user may be about to attach to an issue would be.
- **`resolvableSteps` moved packages**, which is a small churn in a debug view
  for a single definition of a number that now appears in two places.

### What we deliberately did not do

- **No upload, and no channel that could become one.** The bundle is a file and
  a clipboard string. Anything that posted it somewhere would make the privacy
  argument above a promise about a remote service rather than a property of the
  data, and those are not the same kind of claim.
- **No redaction of the display fingerprint or camera label.** They are how you
  tell two bundles apart and whether they are comparable at all; a bundle with
  them stripped is a bundle you cannot pool. The camera *label* is not exported
  — only its negotiated format and exposure state, which is what affects the
  data (ADR-0022 makes the same argument for the recording manifest).
- **No automatic export on a bad validation result.** Tempting, and it would
  catch the runs people never think to report. It would also mean the app
  writing a file about the user without being asked, which is the behaviour
  ADR-0022 spent an entire ADR making impossible on the recording side.
- **No diff tool.** `git diff --no-index a.json b.json` already does it, which
  is most of why the rounding above matters.
