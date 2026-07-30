# Gaze as a sensor in Cognitum Pulse

A plan for folding the shelf demo's attention measurement into
[cognitum-one/cognitum-pulse](https://github.com/cognitum-one/cognitum-pulse) as a
first-class sensor, and what that does to the Pulse demo.

Grounded in a read of both codebases (shelf-demo at ~1650 LOC; cognitum-pulse at
commit `HEAD`, July 2026) and a Grok consult whose objections are folded in below.

> **Status: implemented, and this document is now the *historical* plan.**
>
> Built on the `feat/gaze-sensor` branch of cognitum-pulse
> ([PR #5](https://github.com/cognitum-one/cognitum-pulse/pull/5)). The authoritative
> contract is `docs/gaze-sensor-plan.md` **in that repo** — read it, not this, before
> changing anything. Three design calls below were superseded during implementation
> because building them exposed them as wrong:
>
> 1. **§5's flat `lookToBuyRatio` as a raw ratio.** It explodes as attention
>    approaches zero, and the hidden-hero rule selects on *low* attention — i.e.
>    precisely where the ratio is least reliable. Selecting the max of a quantity
>    whose variance blows up in the selected region is selecting on noise. The
>    shipped version shrinks it toward neutral with pseudo-counts and gates
>    candidates to a 2–8% attention band.
> 2. **§5's tercile/quartile thresholds.** Unusable at n=12: intersecting two
>    tercile cuts has an expected match of ~1.3 items with high variance, so the
>    demo fires nothing on some seeds and three suggestions on others. Replaced with
>    a rank-1 candidate per rule gated on an absolute margin.
> 3. **§5's `anom_attention_concentration` on raw `topItemAttentionShare`.** Softmax
>    attention concentrates *by construction* — measured 0.278 on a healthy board
>    against a 0.32 threshold — so the rule fired on healthy boards and read as
>    noise. Replaced by *wasted eye level*, which is actionable.
>
> Two things this document got right and that turned out to be load-bearing: making
> interventions mutate **placement** rather than attention (§5), and generating POS
> lines **downstream of gaze × an independent conversion latent** (§4). One thing it
> understated: conversion independence alone is *not* enough to keep the sim honest,
> because attention share and unit rank are arithmetically coupled — the measured
> rank correlation was ~0.95 until the board was flattened and per-day demand noise
> added, landing at 0.539.

---

## 1. Why gaze belongs in Pulse at all

Pulse fuses four sensors — weather, POS, inbox, staff. **Every one of them measures
an outcome.** Money that already moved, a complaint already sent, a shift already
worked. Weather is the only leading indicator and it's exogenous: the owner can't
change it, only react to it.

Gaze is different in kind. It measures **attention** — consideration *before* the
transaction, over something the owner fully controls (what's placed where).

That matters because it splits a single POS observation into two diagnoses with
**opposite** fixes:

| Observation | Gaze says | Diagnosis | Fix |
| --- | --- | --- | --- |
| Item X sells poorly | nobody looked at it | visibility | **move it** |
| Item X sells poorly | everyone looked, nobody bought | offer | **don't move it** — price, photo, description |

Neither sensor alone can tell these apart. POS sees the same zero either way. That
is the honest argument for fusion rather than a standalone gaze dashboard, and it's
the one sentence the demo has to earn.

---

## 2. Three things that kill this if left unaddressed

### 2.1 Domain mismatch — Pulse is a café, the shelf demo is a grocery bay

Northstar Café's sensors are weather / labor / tickets / inbox. Grocery planogram
language (facings, endcaps, slotting, eye-level negotiation) is a different
industry with different buyers and different software incumbents. Bolting a cereal
shelf onto a café ops app reads as tech-demo cosplay, and a retail person spots it
in seconds.

### 2.2 There is no join key — and it's worse than it looks

`lookToBuyRatio` needs gaze and sales to name the same thing. They can't:

```ts
// cognitum-pulse/shared/types.ts:30
export interface PosTransaction {
  id: string; ts: string; date: string
  channel: 'in_store' | 'online' | 'pickup'
  amountUsd: number
  items: number                                   // ← a COUNT, not line items
  category: 'food' | 'drink' | 'merch' | 'service' // ← finest granularity in the app
  payment: 'card' | 'cash' | 'wallet'
  refunded: boolean
}
```

Pulse has **no menu-item or SKU concept anywhere**. There is nothing to join to.
This is the single largest piece of real work in the plan, and it is unavoidable —
per-item look-to-buy is the entire thesis.

### 2.3 The physics and the law both break on "shop owner points a webcam at shoppers"

The shelf demo runs `numFaces: 1`, requires a per-user calibration pass, and fits a
ridge affine map from iris offsets to *screen* coordinates at laptop distance. It is
explicitly demo-grade — not the validated Rust pipeline. At aisle distance, at an
angle, with several shoppers, under store lighting, none of it holds: the iris is a
few pixels, MediaPipe wants a roughly frontal face, and there's no camera-to-shelf
geometry.

Legally, "we never record video" is a weaker shield than it sounds. Under GDPR,
processing begins when the frame is analyzed, not when it's stored. Illinois BIPA
covers *scan of face geometry* and turns on capture, not only retention — and
face-mesh landmarks on non-consenting shoppers in Illinois is a well-known
litigation magnet. Aggregate-only output is good hygiene; it is not a lawful basis.

*(Not legal advice — the point is that the slogan can't carry the architecture.)*

---

## 3. The resolution: the counter is the shelf

All three problems collapse if the measured surface is **the café's own display case
and menu**, viewed from a **counter-side tablet or self-order kiosk**, rather than an
aisle camera pointed at strangers.

- **Domain fits.** A pastry case and a menu board *are* a planogram. Which item sits
  at eye level in a three-tier case, and which of eight items lead the menu, is a
  decision a café owner makes weekly and controls completely. No retheme needed —
  Northstar Café stays Northstar Café.
- **Join key becomes exact.** A kiosk session produces both the gaze trace *and* the
  order. Look-to-buy stops being a cross-sectional correlation and becomes a
  **within-session** measurement: this person looked at these six items for these
  durations, and bought these two. That's a materially stronger claim than anything
  an aisle camera can produce.
- **Physics fits.** One face, arm's length (~50–70 cm), front-facing camera, a person
  who is already deliberately looking at a screen. This is precisely the regime the
  shelf-demo code was built for and where webcam gaze genuinely works.
- **Consent fits.** A kiosk user is a single identified interaction point where notice
  and an explicit opt-in are natural and non-creepy: *"This kiosk can use the camera
  to learn which menu items get noticed. No video is recorded or sent. [Enable] [No
  thanks]."* Declining costs nothing. Contrast with a ceiling camera, where consent
  is impossible.
- **Geometry is free.** The existing 3×4 `DEFAULT_ZONES` grid maps 1:1 onto a
  three-tier display case or a twelve-item menu board. Zero layout work.

Keep the grocery shelf as the *R&D* surface in `eye-tracker`. Ship the **counter**
into Pulse.

---

## 4. Data contract

Grok's structural objection is correct: `DailyRollup` is a flat row of scalars, and
per-item attention is inherently N-wide. Forcing twelve zones into flat columns fights
the schema. Split it.

**Raw sensor rows — nested, per day:**

```ts
export type GazeSurface = 'menu_kiosk' | 'display_case'

export interface GazeItemAttention {
  itemId: string          // joins to MenuItem.id and PosLine.itemId
  dwellMs: number
  share: number           // 0–1, of measured attention that day
  firstFixationMs: number // time-to-notice; low = high salience
  revisits: number        // came back to it = considered, not glanced
}

export interface GazeDay {
  date: string
  surface: GazeSurface
  sessions: number             // opted-in sessions that day
  measuredMs: number           // total attention time with ok features
  items: GazeItemAttention[]
  meanQuality: number          // 0–1, from GazeFeatures.quality
  lowQualitySessions: number   // dropped for pose/lighting/glasses
}
```

**Derived flat scalars — so `windows.ts` and anomaly detection work unchanged:**

Add to `DailyRollup`: `gazeSessions`, `gazeMeasuredMin`, `attentionCoverage`
(fraction of menu items clearing a 2% dwell floor), `deadItemCount`,
`topItemAttentionShare`, `lookToBuyIndex`. Each is a plain numeric field, so it plugs
into `WINDOW_DEFS` with a one-line `metric(...)` entry and participates in 3d/7d/30d/YoY
for free.

**Per-item metrics stay nested** and drive anomalies and suggestions directly — they
do not get flattened into rollups.

**The prerequisite:** introduce a menu catalog to the café sim.

```ts
export interface MenuItem {
  id: string; name: string
  category: 'food' | 'drink' | 'merch'
  priceUsd: number
  placement: { surface: GazeSurface; tier: number; slot: number }
}

export interface PosLine { itemId: string; qty: number; amountUsd: number }
// PosTransaction gains: lines: PosLine[]   (items stays as the derived count)
```

This is worth doing on its own merits — per-line POS is more realistic than a
transaction count, and it makes every existing Pulse suggestion sharper.

---

## 5. Suggestions and the intervention loop

Pulse's best mechanic is that approving a suggestion writes an `ActiveIntervention`
whose `InterventionEffects` **rewrite future simulated sensor rows** — so time-travel
shows the counterfactual of your own decision. Gaze suggestions should reuse it, with
gaze effects added to the effect vector (`attentionShift`, `deadItemRecovery`) so
approving a placement change moves *attention* forward in time, not just revenue.

Four new deterministic `OpsChange` ids, each fired by an explicit threshold:

| id | Fires when | Says |
| --- | --- | --- |
| `chg_move_to_eye_level` | high look-to-buy, low attention share, item on tier 1 or 3 | "People buy it when they see it. They don't see it. Move it up a tier." |
| `chg_dead_case_slot` | a slot under the dwell floor for 7+ days | "This slot is invisible. Rotate stock through it or shrink the case." |
| `chg_seen_not_bought` | top-quartile attention, bottom-quartile conversion | "It gets noticed and skipped. Don't move it — the price or the photo is the problem." |
| `chg_promote_sleeper` | high revisits, low first-fixation salience | "People hunt for it. Give it a lead slot." |

Crucially, `chg_seen_not_bought` is a **negative** recommendation — "don't move this."
An advisor that sometimes tells you *not* to act is far more credible than one that
always has a change to sell.

The LLM's role does not change: it rewrites `title` / `inPlainEnglish` / `ifYouDoThis`
on these fixed ids via `applyLlmOverlays`, and the batch storytelling gets a new
`MonthStoryPack` field for the month's attention shifts. It still cannot invent
suggestions. That's a feature — keep it.

---

## 6. The live moment

The demo needs one thing a viewer can't dismiss as simulation: **their own eyes.**

Sixty seconds looking at Northstar's menu board on their own screen. They see the
heatmap build, the dwell bars sort themselves, and then — the part that lands — the
report tells them which item *they personally* ignored, and what it would do to the
month if the owner moved it.

Two rules to keep it honest:

1. **Label it as a prior, not a measurement.** The session seeds an attention
   *distribution* over the simulated history. Say so in the UI. One person's minute is
   not thirty days of customers, and projecting it forward flat looks obviously fake —
   add time-of-day and day-of-week variation when expanding it.
2. **Label intervention lift as a scenario.** `EFFECTS_BY_CHANGE` multipliers are
   assumptions, not measured causal effects. Show them as editable assumption cards.
   Real placement lift needs test/control and a promo calendar; claiming otherwise is
   the fastest way to lose a retail audience.

Replay mode stays as the no-camera fallback, and should be the default so the demo
never opens with a permission prompt.

---

## 7. Repo strategy

Grok's advice — don't extract an npm package yet — is right on the engineering, but it
under-weights that "cognitum-one owns the sensor" is part of the point here. The split
that serves both:

**Goes to cognitum-one now — the contract, not the runtime:**
`GazeDay`, `GazeItemAttention`, `MenuItem`, `PosLine`, the JSON schema, and the
privacy allowlist. These are the org's asset. They're small, stable, and they're what
a second consumer (a Cognitum Seed device, a different vertical) would actually need.

**Vendored into cognitum-pulse — the browser loop:**
Copy the MediaPipe loop, the ridge fit, `OneEuroFilter`, the zone hit-tester, and the
heatmap into a `app/gaze/` module. Roughly 700 lines, no framework, no build changes
beyond serving the MediaPipe wasm/model from `public/`.

**Stays in eye-tracker:** the Electron app, the Rust estimator, cursor control, blink
FSM. Unrelated to this and shouldn't follow.

Publish a real `@cognitum/gaze-sensor` package when a second consumer exists and the
contract has stopped moving. Extracting now buys dual-repo CI and MediaPipe asset
packaging for exactly one consumer, and it over-legitimizes a fit that
`gaze-model.ts` itself flags as demo-grade.

One migration note: Pulse blobs the entire world into IndexedDB under a single key
(`world-v3`), and `loadOrSeedWorld` re-runs `buildRollups` on load. Adding fields
requires bumping to `world-v4` or old blobs silently produce `NaN` columns.

---

## 8. What not to claim

Kill these before they reach a slide:

- ❌ "Any webcam, in-store, multi-shopper, per-product gaze." — Not what the code does.
- ❌ "Privacy-complete because no video is stored." — Processing ≠ storage under GDPR;
  BIPA turns on capture.
- ❌ "We measured that your decision lifted revenue." — It's a scenario multiplier.
- ❌ "Eye-level is a free optimization." — In real retail it's vendor-negotiated.

The claim that survives all scrutiny and is still worth money:

> **Opted-in attention measurement at the point of order, joined to the order itself,
> turning "this doesn't sell" into either a placement problem or an offer problem —
> with video that never leaves the device.**

---

## 9. Phasing

| Phase | Work | Outcome |
| --- | --- | --- |
| **0** | `MenuItem` catalog + `PosLine[]` in the café sim; regenerate rollups; bump `world-v4` | Pulse gets per-item sales. Useful on its own, no gaze yet. |
| **1** | `GazeDay` contract + `SensorId 'gaze'` + synthetic gaze history correlated with the menu | Gaze appears in Radar, WindowCompare, and the data tables. |
| **2** | 4 anomaly rules + 4 `OpsChange` ids + gaze `InterventionEffects` | Approve → time-travel shows attention *and* revenue shift. |
| **3** | Vendor the browser gaze loop; kiosk consent UI; 60s live seeding | The moment. Their own eyes drive the report. |
| **4** | `CognitumDebug` denylist → explicit allowlist; "video never leaves this device" live indicator | Privacy becomes a demonstrated property, not a claim. |

Phase 0 is the unglamorous one and everything depends on it. Phases 0–2 are shippable
without touching a camera, which means the demo degrades gracefully if the vision work
slips.

---

## 10. Ranked upgrades beyond gaze

The gaze work raises Pulse a lot, but it isn't the highest impact-per-effort change
available. Ranked:

1. **Assumption cards + counterfactual honesty** *(medium effort)* — show the
   `InterventionEffects` multipliers, let the viewer edit them, show approved-vs-rejected
   side by side. Turns the best existing mechanic from a magic trick into an advisor.
   Highest ratio in the list, and it's a prerequisite for gaze suggestions being credible.
2. **Suggestion lineage** *(small–medium)* — every `OpsChange` traceable back through
   anomaly id → `DailyRollup` fields → window → rule threshold → exact LLM payload.
   Wins technical buyers instantly and pairs naturally with the privacy allowlist.
3. **Explicit "what left this browser" allowlist** *(small)* — replace the hard-coded
   `notSent` denylist with a generated list of exactly what was sent. Table stakes once
   anything camera-adjacent exists.
4. **The gaze sensor** *(large)* — the memorable moment and the only genuine sensor
   differentiator, but the most fake-risk if oversold.
5. **One real external feed** *(medium)* — a CSV POS import. Breaks "it's all simulated"
   in ten seconds. Worth considering ahead of gaze if credibility is the bottleneck.

Do 1–3 alongside phases 0–2. They cost little and they're what make the gaze claims
land instead of bounce.

---

## Open questions

- Is a counter kiosk the right retail surface for Cognitum's actual audience, or is
  the grocery bay the market and the café just the current demo skin? That answer
  changes phase 3 substantially.
- Does `api.cognitum.one` batch pricing make a per-item month story affordable, or does
  the attention narrative have to ride inside the existing `story_month_*` jobs?
- Note: `server/utils/reportEngine.ts` `synthesizeOpsReport` references undeclared
  symbols and appears dead — worth confirming before building on that path rather than
  the live `analyze.post.ts` one.
