# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

This project pulls together four subsystems that each have several plausible
designs: computer vision, a statistical mapping model, signal filtering, and
native OS control. Most of the hard choices here are not visible in the code
that results from them — a reader can see *that* we use a ridge-regularized
quadratic model, but not that we tried and rejected a geometric 3D eyeball
model, or why the regularization is non-optional.

Gaze tracking in particular is full of decisions that look arbitrary until you
know the failure they prevent. Freezing the cursor during a blink is three lines
of code and the difference between a usable and an unusable product.

## Decision

We keep Architecture Decision Records in `docs/adrs/`, numbered sequentially,
in the format of [Michael Nygard's template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

An ADR is warranted when a choice is (a) hard to reverse, (b) crosses a module
boundary, or (c) encodes a non-obvious empirical fact about eye tracking. Routine
implementation choices do not get an ADR.

ADRs are immutable once accepted. Superseding an ADR means writing a new one and
marking the old one `Superseded by ADR-NNNN`.

## Consequences

### What this buys us

- The "why" survives past the point where anyone remembers writing it.
- A reviewer can challenge a decision at the level of its stated forces, rather
  than arguing about the code that implements it.

### What this costs us

- Discipline. An ADR set that lags the code is worse than none, because it
  misleads confidently.

### What we would need to see to revisit this

- The ADR set drifting more than a milestone behind the implementation.
