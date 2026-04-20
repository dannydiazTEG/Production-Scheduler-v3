# Optimizer Cron — Feedback Round 2

**Date:** 2026-04-20
**Status:** Design approved; ready for implementation plan
**Scope:** Nine tightly-related changes to scoring, LLM constraints, and email reports, delivered as one spec / one PR with logical commits.

## Context

The overnight optimizer cron (managed Claude agent + API tools) has been running. A working session with Dan surfaced nine issues across three layers:

- **Scoring** drifts high (76.4 → B+, should be C) and rewards patterns we don't want (>10 business days of over-buffer, baseline OT being invisible, CNC dwell treated like soft-team dwell).
- **LLM constraints** are missing real-world hiring rules (Metal doesn't hire, Kitting mostly doesn't, CNC is capped by machines, same-team hires should stagger) and allow horizon to drop to 3 months when it should stay locked at 6.
- **Email reports** sort the store comparison table by lateness instead of urgency (due date) and lack OT window detail needed to audit the agent's discipline.

## Decisions

### 1. Horizon — hard-lock at 6 months

- Remove `horizonMonths` from the LLM-tunable parameter space.
- `/api/optimize-run` validation rejects any proposal that changes horizon.
- `parameter-space.md` documents the 6-month floor.

### 2. OT in scoring (Labor Cost category, 18 pts)

Two changes, both required (user approved option C from brainstorm):

**2a. Capacity bug fix.** Before implementation, verify how `scheduling-engine.js` represents configured OT windows in `teamUtilization`. Two cases:
- If configured OT **raises `capacity`** for those weeks, `worked > capacity` is zero for configured OT → baseline OT is invisible to the scorer. Fix: accumulate OT from a separate `configuredOtHours` channel passed alongside `teamUtilization`.
- If configured OT shows as **`worked > capacity`** already, no plumbing change needed — only curve change applies.

**2b. Softer curve.** Replace the current `18 − (hours/100) × 4.5` (which flat-lines at 400h) with:

```
laborCostPoints = 18 × max(0, 1 − OT_hours / 1200)
```

Anchors: 0h → 18pts, 200h → 15pts, 600h → 9pts, 1200h → 0pts. Differentiates realistic OT ranges.

### 3. CNC dwell exclusion

Add `'CNC'` to the dwell-ratio exclusion set in `analyzeTeamHealth` and the dwell-category averager, alongside `Receiving` and `QC`. Reason: CNC dwell is structural (2 machines × 2 shifts is the ceiling), not a labor-balancing problem.

### 4. CNC hiring — hard cap + weekend-shift advisory

- `/api/optimize-run` rejects any proposal that takes CNC total headcount above 5.
- No LLM lever for "weekend shift" — too operationally heavy to automate.
- Scoring emits `cncWeekendShiftAdvisory: true` when CNC utilization is sustained above 90% AND NSO/Infill misses exist. Email report surfaces this as a human-review flag.

### 5. Grade bands — standard US academic scale

| Grade | Band |
|-------|------|
| A+ | 97+ |
| A | 93–96 |
| A- | 90–92 |
| B+ | 87–89 |
| B | 83–86 |
| B- | 80–82 |
| C+ | 77–79 |
| C | 73–76 |
| C- | 70–72 |
| D | 60–69 |
| F | <60 |

Under this scale, 76.4 = C (not B+ as today).

### 6. Buffer score — business days + new curve (40 pts)

**Business-days helper.** New `businessDaysEarly(dueDate, finishDate)` — counts weekdays between the two dates, signed (negative if late). No holiday calendar (not worth the maintenance).

**New curve** (replaces `bufferScore`):

| Business days early | Score |
|---------------------|-------|
| Late beyond tolerance | 0 (hard gate; unchanged) |
| 0 (on due date) | 50 |
| 1–4 | 50 → 80 linear |
| 5–10 | 80 → 100 linear (peak at 10) |
| 11–15 | 100 → 70 linear |
| 16+ | `max(40, 70 − (d − 15) × 2)` |

Flips the signal: finishing >15 bd early is now a *negative* (resources misallocated vs other stores).

### 7. Hiring constraints

Enforced in `/api/optimize-run` validation:

| Team | Rule |
|------|------|
| Metal | 0 additional hires (Tech hybrid covers) |
| Kitting | Max 1 additional hire; LLM must provide strong justification |
| CNC | Max 5 total headcount |
| All teams | Same-team hires must be staggered by ≥14 days between start dates |

Existing rule unchanged: first hire starts `scheduleStart + 28 days`. With stagger, hire 2 starts at `+42 days`, hire 3 at `+56 days`, etc.

### 8. Store comparison table — sort by due date

In `email-report.js`, sort the per-store rows (email body "Schedule Comparison — Baseline vs Top Runs" table) ascending by due date. `NO_DUE_DATE` rows push to the bottom.

### 9. OT window clarity in email reports

Add a new OT section per run:

- **Per-team summary rows**: `Team | Weeks | Hours/day | Total OT hrs | Source (config / LLM / both)`
- **Cool-down violation flag**: call out any team with back-to-back OT windows < 1 month apart, e.g. `⚠ Paint: OT weeks 10–13 and 15–18 — no 1-month gap`
- **CNC weekend-shift advisory** (from §4) surfaced when flagged.

Data plumbing: `optimizer-cron.js` passes baseline OT windows (from the user config) through to scoring and email report so pre-existing vs LLM-added can be split.

## File impact

| File | Change |
|------|--------|
| `scheduler-backend/scoring.js` | New `bufferScore` (bd), `businessDaysEarly` helper, grade bands, CNC in dwell exclusion, OT accumulator + new curve, CNC weekend-shift advisory flag |
| `scheduler-backend/server.js` | `/api/optimize-run` validation additions: horizon lock, Metal/Kitting/CNC caps, stagger rule |
| `scheduler-backend/email-report.js` | Store table sort; OT window section; CNC advisory callout |
| `scheduler-backend/optimizer-cron.js` | Plumb baseline OT windows + configured OT hours through to scoring + report |
| `scheduler-backend/agent-context/parameter-space.md` | Remove horizon from tunables; document hire caps + stagger |
| `scheduler-backend/agent-context/scoring.md` | New buffer curve + grade bands + OT curve |
| `scheduler-backend/agent-context/system.md` | "Eliminate OT including baseline" directive |

## Testing

New `scheduler-backend/scoring.test.js`:

- `bufferScore` at business-day anchors: 0, 4, 10, 15, 20 bd
- `businessDaysEarly` across weekend boundaries and year boundary
- `computeGrade` at band boundaries (90, 89, 80, 79, 77, 76, 73, 72, 70, 69, 60, 59)
- OT curve at 0 / 200 / 600 / 1200 / 1500 hours
- `analyzeTeamHealth` excludes CNC from peaks; dwell average excludes CNC
- CNC weekend-shift advisory triggers only when utilization + NSO miss conditions both hold

Validation tests for `/api/optimize-run`:

- Rejects any Metal hire
- Rejects 2nd Kitting hire (accepts 1st)
- Rejects 6th CNC hire
- Rejects same-team hires < 14 days apart
- Rejects `horizonMonths` change

End-to-end: one real optimizer run pre/post change, manual score + grade comparison to sanity-check direction of movement.

## Implementation order (logical commits in one PR)

1. `scoring.js` changes + `scoring.test.js`
2. `/api/optimize-run` validation additions + validation tests
3. Agent-context markdown updates
4. `email-report.js` changes (sort, OT section, CNC advisory)
5. `optimizer-cron.js` plumbing for configured OT passthrough

## Pre-implementation verification

Before touching scoring, read `scheduler-backend/scheduling-engine.js` to confirm how configured OT windows modify `teamUtilization`. This determines whether §2a needs a new data channel or can be satisfied by the existing `worked - capacity` calculation.
