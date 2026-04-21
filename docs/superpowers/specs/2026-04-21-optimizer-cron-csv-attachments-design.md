# Optimizer Cron — CSV Attachments for Baseline Verification

**Date:** 2026-04-21
**Status:** Design approved; ready for implementation plan
**Scope:** Two CSV attachments on the nightly optimizer email so Danny can audit the cron's baseline against operational reality.

## Context

On 2026-04-21 the overnight cron predicted PCB NSO finishing 5/6; an ad-hoc local run (same config, 4 hours later) predicted 4/26. PCB has one operational step remaining in Fulcrum. The gap can't currently be diagnosed from the email or Render logs — we can't see which completed ops the DB filter removed, which tasks are still on each store's plate, or whether those tasks are attributed to the right teams.

The observability gap is the priority. Two attachments land in the email so mornings spent debugging become mornings spent verifying.

This spec is **staged** — a follow-up project ("LLM date-override latitude") is deferred until we've used these CSVs to confirm the cron's baseline matches reality. If the baseline is right, that project proceeds on solid footing. If it's wrong, these CSVs will pinpoint the discrepancy.

## Decisions

### Attachment 1 — `db-filtered-out-{YYYY-MM-DD}.csv`

One row per completed operation that `data-prep.js`'s DB filter removed from the raw task list during the baseline iteration.

| Column | Source |
|--------|--------|
| Store | Joined from upload tasks by Project (first match per project) |
| Project | `raw_fulcrum_job_log.job_name` |
| SKU | `raw_fulcrum_job_log.item_reference_name` |
| Operation | `raw_fulcrum_job_log.operation_name` |
| CompletionDate | `raw_fulcrum_job_log.created_at`, ISO format with time-of-day |

Time-of-day matters: a PCB op logged complete at 8:47am, after the 7:39am cron snapshot, would still be in this CSV (because the snapshot saw it as incomplete) — and the timestamp makes that visible.

### Attachment 2 — `remaining-work-by-store-{YYYY-MM-DD}.csv`

Generated from the baseline run only. All iterations share the same `preparedTasks`, so the work backlog is identical across runs.

One row per in-horizon store, wide format:

| Column | Notes |
|--------|-------|
| Store | |
| ProjectType | NSO / INFILL / RENO / PC from Dates CSV |
| Due | Production due date from Dates CSV |
| Projected Finish | From baseline's `projectSummary.FinishDate`, max across store's projects |
| Lateness Days | Calendar days Projected Finish is beyond Due (0 if on time) |
| Total Ops | Count of rows in `preparedTasks` for this store |
| Total Hours | Sum of `HoursRemaining` for this store |
| Receiving ops, Receiving hrs | |
| CNC ops, CNC hrs | |
| Metal ops, Metal hrs | |
| Scenic ops, Scenic hrs | |
| Paint ops, Paint hrs | |
| Carpentry ops, Carpentry hrs | |
| Assembly ops, Assembly hrs | |
| Tech ops, Tech hrs | |
| QC ops, QC hrs | |

Team columns ordered by the codebase's existing `TEAM_SORT_ORDER`. Teams in `params.teamsToIgnore` (Unassigned, Wrapping/Packaging, Print) are folded into Total Ops/Hours but not given their own columns.

Sort: ascending by Due (reusing `sortStoresByDueDate` from email-report.js). Stores without a due date sink to the bottom.

## Architecture

### Data flow

1. **Server-side (`/api/optimize-run`, baseline iteration only — `!skipDbFilter`)**

   Already happens:
   - `data-prep.js` returns `completedTasks` (currently discarded at the endpoint layer).
   - Engine produces `projectSummary`; scoring produces `storeBreakdown`.

   New:
   - A helper `computeStoreWorkBreakdown(preparedTasks, storeBreakdown, storeDueDates, teamsToIgnore)` aggregates per-store per-team counts and hours from `preparedTasks`, joined with due/finish data from the existing scoring output.
   - The endpoint response grows two optional fields, returned only when the cron opts in via `returnPreparedTasks: true`:
     - `completedTasks`: flat array from `data-prep.js`, one row per completed op
     - `remainingWorkByStore`: array of per-store rollups from the new helper

2. **Cron-side (`optimizer-cron.js`)**

   The baseline call already captures `preparedTasks` from `baseResult`. Capture the two new fields the same way. Pass both to `/api/send-optimization-report` alongside the existing payload.

3. **Email (`/api/send-optimization-report` + `email-report.js`)**

   Endpoint forwards the two fields to `sendOptimizationReport`. Two new attachments on the nodemailer message:
   - `db-filtered-out-{date}.csv` from `completedTasks`
   - `remaining-work-by-store-{date}.csv` from `remainingWorkByStore`

   Both formatted via a shared CSV helper in email-report.js.

### New files

**`scheduler-backend/store-work-breakdown.js`** — pure function, single responsibility. Signature:

```js
/**
 * @param {Array} preparedTasks - Tasks remaining after DB+horizon filter
 * @param {Array} storeBreakdown - scoreResult.storeBreakdown (Store, dueDate, finishDate, latenessDays, etc.)
 * @param {Map}   storeDueDates - From parseDatesCsv, gives ProjectType per store
 * @param {Set}   teamsToIgnore - Normalized team names to fold into totals but not column-out
 * @returns {Array<Object>} One entry per store with per-team counts/hours
 */
function computeStoreWorkBreakdown(preparedTasks, storeBreakdown, storeDueDates, teamsToIgnore) { ... }
```

**`scheduler-backend/test/store-work-breakdown.test.js`** — unit tests.

CSV helper tests land alongside the existing sort tests in `scheduler-backend/test/email-report.test.js` — one test file per module.

### Modified files

- `scheduler-backend/server.js` — `/api/optimize-run` baseline response includes two new fields; `/api/send-optimization-report` forwards them.
- `scheduler-backend/optimizer-cron.js` — capture + forward.
- `scheduler-backend/email-report.js` — one internal `toCsv(rows, columns)` helper, two attachment-builders, two `attachments` entries.

## CSV format specifics

- Line ending: `\r\n` (Excel-friendly, matches existing task-CSV attachment).
- Cell quoting: quote any cell containing `,`, `"`, `\r`, or `\n`. Double-quotes inside quoted cells are escaped `"` → `""`.
- Empty / null values: render as empty string, not `null` or `—`.
- Numeric hours rounded to 1 decimal. Counts are integers.
- Headers in the first row.

## Testing

### `store-work-breakdown.test.js`

Anchor cases:
- Single store with tasks on one team → correct counts, hours, zeros elsewhere.
- Single store with tasks across multiple teams → correct per-team split, correct totals.
- Two stores → independent rollups.
- Tasks on ignored teams (Wrapping/Packaging, Unassigned, Print) → counted in Total but not in per-team columns.
- Store with no preparedTasks but present in storeBreakdown → all zeros, still emits row.
- Store not in storeBreakdown but present in preparedTasks → skipped (out of horizon).
- Join with `storeDueDates` handles the `Philadadelphia` typo case (reuse `matchStoreName` from scoring.js).

### `csv-format.test.js`

- Commas in cells quoted correctly.
- Double-quotes escaped correctly.
- Empty cells produce empty fields (not `undefined`).
- Line endings are `\r\n`.
- Header row matches column order exactly.
- Round-trip: feed generated CSV through a parser, get the original rows back.

### Manual smoke test

Trigger a cron run (or just the `/api/send-optimization-report` endpoint with fixture data) and open both attachments in Excel/Sheets:
- DB-filtered-out CSV: grep for PCB, confirm the completed PCB ops match Fulcrum reality.
- Remaining-work-by-store CSV: find PCB's row, confirm `Total Ops` matches what Danny sees in Fulcrum. Confirm per-team split (which team still has pending PCB work).

## Not in scope

- In-progress ops CSV (not requested; data exists if we ever want it).
- Per-SKU drill-down CSV (the 16k-row task CSV already provides that).
- Delta between baseline and best run for Attachment 2 (work backlog is identical across iterations; a delta CSV would be all zeros).
- LLM date-override latitude tuning (separate spec, deferred until CSV verification confirms the cron baseline matches reality).
- Changes to any scoring or agent-context behavior.

## File impact summary

| File | Change |
|------|--------|
| `scheduler-backend/store-work-breakdown.js` | NEW — pure aggregation helper |
| `scheduler-backend/test/store-work-breakdown.test.js` | NEW — unit tests |
| `scheduler-backend/test/email-report.test.js` | Extended — add CSV format tests alongside existing sort tests |
| `scheduler-backend/server.js` | `/api/optimize-run` + `/api/send-optimization-report` forward the two new fields |
| `scheduler-backend/optimizer-cron.js` | Capture + forward baseline's completedTasks + remainingWorkByStore |
| `scheduler-backend/email-report.js` | `toCsv` helper; two attachment builders; two new `attachments` entries |

No new npm dependencies.

## Implementation ordering (single PR)

1. `store-work-breakdown.js` + tests (TDD).
2. CSV format helper + tests.
3. `server.js` `/api/optimize-run` forwards completedTasks + remainingWorkByStore in baseline response.
4. `email-report.js` attachment builders.
5. `/api/send-optimization-report` accepts + plumbs the new fields.
6. `optimizer-cron.js` captures from baseline result + passes to send call.
7. Manual smoke verification.
