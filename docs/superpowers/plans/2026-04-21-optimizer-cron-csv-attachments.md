# Optimizer Cron — CSV Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two CSV attachments to the nightly optimizer email — the DB-filtered-out completed ops, and a per-store remaining-work rollup — so Danny can audit the cron's baseline against Fulcrum reality.

**Architecture:** Two new pure helper modules (`csv-format.js` for CSV serialization, `store-work-breakdown.js` for per-store aggregation), a small data-flow addition in `server.js`'s `/api/optimize-run` baseline response, and client-side CSV construction in `optimizer-cron.js` that pushes into the already-wired `attachments` array. `email-report.js` and `/api/send-optimization-report` need no changes — they already forward attachments verbatim.

**Tech Stack:** Node.js 22, Express 5, built-in `node --test` runner + `node:assert/strict`.

**Spec:** [`docs/superpowers/specs/2026-04-21-optimizer-cron-csv-attachments-design.md`](../specs/2026-04-21-optimizer-cron-csv-attachments-design.md)

**Pre-verified facts (from code reading during planning):**

- `scheduler-backend/data-prep.js` already returns `completedTasks` from `prepareProjectData`, but `server.js:2768` destructures only `{ tasks }` and discards it.
- `scheduler-backend/optimizer-cron.js:1068` already POSTs an `attachments: [{ filename, content }]` array to `/api/send-optimization-report`.
- `scheduler-backend/server.js:3489` already forwards `attachments` verbatim to `sendOptimizationReport`, which `email-report.js:592` maps onto nodemailer. **No email-report or /api/send-optimization-report changes needed.**
- `TEAM_SORT_ORDER` lives at `scheduler-backend/scheduling-engine.js:86` and is already exported. It ends with `'Hybrid'` — a meta-team that should NOT be a CSV column.
- `params.teamsToIgnore` is a CSV string like `"Unassigned, Wrapping / Packaging, Print"`. Split + trim into a Set.
- `scoreResult.storeBreakdown` entries have: `store`, `matchedStore`, `projectTypes` (array), `finishDate`, `dueDate`, `latenessDays`, `isNso`, `isInfill`, `isHardGate`, `status`. No `ProjectType` string — we have a `projectTypes` Set and the `isNso`/`isInfill` booleans.
- `projectSummary[]` has `{ Project, Store, FinishDate }` shape from the engine.

**Note on one spec deviation (documented, intentional):** the spec said CSV formatting would live in `email-report.js`. The existing codebase pattern has `optimizer-cron.js` building CSV strings inline and pushing them into the `attachments` array (see `optimizer-cron.js:1031-1048` for the existing task-CSV). Following that pattern is cleaner than pulling CSV logic into email-report. The shared `toCsv` helper lives in a new `csv-format.js` module; cron imports it for all three CSVs (existing task CSV gets refactored onto it as opportunistic cleanup).

---

## Task 1: CSV format helper (TDD)

**Files:**
- Create: `scheduler-backend/csv-format.js`
- Modify: `scheduler-backend/test/email-report.test.js` (extend existing test file)

- [ ] **Step 1: Write failing tests**

Append to `scheduler-backend/test/email-report.test.js`:

```javascript
const { toCsv } = require('../csv-format');

test('toCsv: basic rows + columns', () => {
    const out = toCsv([{ a: 1, b: 2 }, { a: 3, b: 4 }], ['a', 'b']);
    assert.equal(out, 'a,b\r\n1,2\r\n3,4\r\n');
});

test('toCsv: quotes cells with commas', () => {
    const out = toCsv([{ name: 'Foo, Inc', count: 5 }], ['name', 'count']);
    assert.equal(out, 'name,count\r\n"Foo, Inc",5\r\n');
});

test('toCsv: escapes embedded double quotes', () => {
    const out = toCsv([{ op: 'said "hi"' }], ['op']);
    assert.equal(out, 'op\r\n"said ""hi"""\r\n');
});

test('toCsv: quotes cells with newlines or CR', () => {
    const out = toCsv([{ note: 'line1\nline2' }], ['note']);
    assert.equal(out, 'note\r\n"line1\nline2"\r\n');
});

test('toCsv: null/undefined become empty cells', () => {
    const out = toCsv([{ a: null, b: undefined, c: 0 }], ['a', 'b', 'c']);
    assert.equal(out, 'a,b,c\r\n,,0\r\n');
});

test('toCsv: empty rows array still emits header + trailing CRLF', () => {
    const out = toCsv([], ['a', 'b']);
    assert.equal(out, 'a,b\r\n');
});

test('toCsv: column order matches argument, not row key order', () => {
    const out = toCsv([{ b: 2, a: 1 }], ['a', 'b']);
    assert.equal(out, 'a,b\r\n1,2\r\n');
});

test('toCsv: missing keys render as empty cells', () => {
    const out = toCsv([{ a: 1 }, { b: 2 }], ['a', 'b']);
    assert.equal(out, 'a,b\r\n1,\r\n,2\r\n');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — `Cannot find module '../csv-format'`.

- [ ] **Step 3: Create `scheduler-backend/csv-format.js`**

```javascript
/**
 * csv-format.js — Convert rows of objects to a CSV string.
 *
 * CRLF line endings for Excel friendliness. Cells containing comma, double
 * quote, CR, or LF get quoted; embedded quotes are doubled. null/undefined
 * render as empty cells. Column order follows the `columns` argument — row
 * key order is ignored.
 *
 * Always emits a header row followed by a trailing CRLF (even with zero
 * data rows) so that downstream tooling can rely on `\r\n` terminators.
 */

function escapeCell(value) {
    if (value == null) return '';
    const str = String(value);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * @param {Array<Object>} rows
 * @param {Array<string>} columns - column names in the order they should appear
 * @returns {string} CSV text with CRLF line endings
 */
function toCsv(rows, columns) {
    const lines = [columns.map(escapeCell).join(',')];
    for (const row of rows) {
        lines.push(columns.map(col => escapeCell(row[col])).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

module.exports = { toCsv, escapeCell };
```

- [ ] **Step 4: Run tests — confirm all pass**

```bash
cd scheduler-backend && npm test
```

Expected: all new `toCsv` tests pass; existing tests still pass (total should be previous+8).

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/csv-format.js scheduler-backend/test/email-report.test.js
git commit -m "Add csv-format helper for CRLF-quoted CSV generation"
```

(From repo root `/Users/dannydiaz/production-scheduler-v2/.claude/worktrees/flamboyant-hamilton-521587`.)

---

## Task 2: Store work breakdown helper (TDD)

**Files:**
- Create: `scheduler-backend/store-work-breakdown.js`
- Create: `scheduler-backend/test/store-work-breakdown.test.js`

- [ ] **Step 1: Write failing tests**

Create `scheduler-backend/test/store-work-breakdown.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStoreWorkBreakdown } = require('../store-work-breakdown');

const TEAMS = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC'];

function row(overrides) {
    // helper for a scoreResult storeBreakdown entry
    return {
        store: 'X', matchedStore: 'X', projectTypes: [],
        finishDate: null, dueDate: null, latenessDays: 0, daysEarly: 0,
        isNso: false, isInfill: false, isHardGate: false,
        status: 'ON_TIME',
        ...overrides,
    };
}

test('computeStoreWorkBreakdown: single store, single team', () => {
    const preparedTasks = [
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 4.5 },
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 2 },
    ];
    const storeBreakdown = [row({
        store: 'PCB', projectTypes: ['NSO'], isNso: true,
        dueDate: '2026-04-26', finishDate: '2026-05-06', latenessDays: 10,
    })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 1);
    const r = result[0];
    assert.equal(r.store, 'PCB');
    assert.equal(r.projectType, 'NSO');
    assert.equal(r.dueDate, '2026-04-26');
    assert.equal(r.finishDate, '2026-05-06');
    assert.equal(r.latenessDays, 10);
    assert.equal(r.totalOps, 2);
    assert.equal(r.totalHours, 6.5);
    assert.equal(r.teams.Paint.ops, 2);
    assert.equal(r.teams.Paint.hours, 6.5);
    assert.equal(r.teams.Tech.ops, 0);
    assert.equal(r.teams.Tech.hours, 0);
});

test('computeStoreWorkBreakdown: single store across multiple teams', () => {
    const preparedTasks = [
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 3 },
        { Store: 'PCB', Team: 'Tech', HoursRemaining: 1.5 },
        { Store: 'PCB', Team: 'Tech', HoursRemaining: 2 },
    ];
    const storeBreakdown = [row({ store: 'PCB' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    const r = result[0];
    assert.equal(r.totalOps, 3);
    assert.equal(r.totalHours, 6.5);
    assert.equal(r.teams.Paint.ops, 1);
    assert.equal(r.teams.Paint.hours, 3);
    assert.equal(r.teams.Tech.ops, 2);
    assert.equal(r.teams.Tech.hours, 3.5);
});

test('computeStoreWorkBreakdown: multiple stores rolled up independently', () => {
    const preparedTasks = [
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 3 },
        { Store: 'Dallas', Team: 'Assembly', HoursRemaining: 5 },
    ];
    const storeBreakdown = [row({ store: 'PCB' }), row({ store: 'Dallas' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 2);
    const pcb = result.find(r => r.store === 'PCB');
    const dal = result.find(r => r.store === 'Dallas');
    assert.equal(pcb.teams.Paint.ops, 1);
    assert.equal(dal.teams.Assembly.ops, 1);
    assert.equal(pcb.teams.Assembly.ops, 0);
});

test('computeStoreWorkBreakdown: ignored teams fold into totals but not per-team breakdown', () => {
    const preparedTasks = [
        { Store: 'X', Team: 'Paint', HoursRemaining: 5 },
        { Store: 'X', Team: 'Unassigned', HoursRemaining: 2 },
        { Store: 'X', Team: 'Print', HoursRemaining: 3 },
    ];
    const storeBreakdown = [row({ store: 'X' })];
    const teamsToIgnore = new Set(['Unassigned', 'Print']);
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), teamsToIgnore);
    const r = result[0];
    assert.equal(r.totalOps, 3);
    assert.equal(r.totalHours, 10);
    assert.equal(r.teams.Paint.ops, 1);
    assert.equal(r.teams.Paint.hours, 5);
    // Ignored teams should not appear as keys in r.teams
    assert.ok(!('Unassigned' in r.teams));
    assert.ok(!('Print' in r.teams));
});

test('computeStoreWorkBreakdown: store in breakdown with no tasks emits zero row', () => {
    const preparedTasks = [];
    const storeBreakdown = [row({ store: 'Quiet', dueDate: '2026-06-01' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 1);
    const r = result[0];
    assert.equal(r.store, 'Quiet');
    assert.equal(r.totalOps, 0);
    assert.equal(r.totalHours, 0);
    for (const t of TEAMS) {
        assert.equal(r.teams[t].ops, 0);
        assert.equal(r.teams[t].hours, 0);
    }
});

test('computeStoreWorkBreakdown: tasks for stores outside breakdown are skipped', () => {
    const preparedTasks = [
        { Store: 'InScope', Team: 'Paint', HoursRemaining: 5 },
        { Store: 'OutOfScope', Team: 'Paint', HoursRemaining: 99 },
    ];
    const storeBreakdown = [row({ store: 'InScope' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 1);
    assert.equal(result[0].totalOps, 1);
});

test('computeStoreWorkBreakdown: projectType resolves from storeBreakdown.projectTypes', () => {
    const storeBreakdown = [
        row({ store: 'A', projectTypes: ['NSO'] }),
        row({ store: 'B', projectTypes: ['INFILL'] }),
        row({ store: 'C', projectTypes: ['RENO', 'PC'] }),
        row({ store: 'D', projectTypes: [] }),
    ];
    const result = computeStoreWorkBreakdown([], storeBreakdown, new Map(), new Set());
    const byStore = Object.fromEntries(result.map(r => [r.store, r.projectType]));
    assert.equal(byStore.A, 'NSO');
    assert.equal(byStore.B, 'INFILL');
    // Multi-type stores: join with '/' for display.
    assert.equal(byStore.C, 'PC/RENO');  // alphabetical
    assert.equal(byStore.D, '');
});

test('computeStoreWorkBreakdown: fractional hours round to 1 decimal', () => {
    const preparedTasks = [
        { Store: 'X', Team: 'Paint', HoursRemaining: 0.333333 },
        { Store: 'X', Team: 'Paint', HoursRemaining: 0.666666 },
    ];
    const storeBreakdown = [row({ store: 'X' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result[0].totalHours, 1);
    assert.equal(result[0].teams.Paint.hours, 1);
});
```

- [ ] **Step 2: Run tests — confirm failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — `Cannot find module '../store-work-breakdown'`.

- [ ] **Step 3: Implement `scheduler-backend/store-work-breakdown.js`**

```javascript
/**
 * store-work-breakdown.js — Per-store rollup of remaining task work.
 *
 * Takes the post-filter task set plus the scoring output's storeBreakdown and
 * produces one row per in-scope store with per-team ops/hours counts. Used to
 * build the "remaining-work-by-store" CSV attached to the cron's nightly
 * email.
 *
 * Why this exists: lets Danny audit "does PCB really have N ops of Paint work
 * left, or is the engine seeing stale task state?" directly from the email
 * attachment, without needing to log into the scheduler UI.
 */

// Match the physical teams that show up in the schedule — `Hybrid` is a meta
// team synthesized by the engine for flex workers and has no CSV column.
const TEAM_COLUMNS = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC'];

function emptyTeamMap() {
    const out = {};
    for (const t of TEAM_COLUMNS) out[t] = { ops: 0, hours: 0 };
    return out;
}

function roundHours(h) {
    return Math.round((h || 0) * 10) / 10;
}

/**
 * @param {Array} preparedTasks - Post-filter task list (each has Store, Team, HoursRemaining)
 * @param {Array} storeBreakdown - scoreResult.storeBreakdown — defines which stores to emit
 * @param {Map}   _storeDueDates - Reserved for future enrichment (unused today; breakdown already has dueDate)
 * @param {Set}   teamsToIgnore - Team names to fold into totals but not column-out (e.g. Unassigned, Print)
 * @returns {Array<Object>} One row per store with per-team counts + hours
 */
function computeStoreWorkBreakdown(preparedTasks, storeBreakdown, _storeDueDates, teamsToIgnore) {
    const ignore = teamsToIgnore || new Set();
    // Initialize one bucket per scored store so we emit zero-rows for stores
    // with no tasks left (lets Danny see "PCB has 0 ops" instead of a missing row).
    const buckets = new Map();
    for (const s of storeBreakdown) {
        buckets.set(s.store, {
            store: s.store,
            projectType: (s.projectTypes || []).slice().sort().join('/'),
            dueDate: s.dueDate || null,
            finishDate: s.finishDate || null,
            latenessDays: s.latenessDays || 0,
            totalOps: 0,
            totalHours: 0,
            teams: emptyTeamMap(),
        });
    }

    for (const task of (preparedTasks || [])) {
        const bucket = buckets.get(task.Store);
        if (!bucket) continue;  // out of horizon / not in scoring scope
        const hours = parseFloat(task.HoursRemaining) || 0;
        bucket.totalOps += 1;
        bucket.totalHours += hours;
        if (ignore.has(task.Team)) continue;
        if (bucket.teams[task.Team]) {
            bucket.teams[task.Team].ops += 1;
            bucket.teams[task.Team].hours += hours;
        }
        // Tasks on teams not in TEAM_COLUMNS and not in `teamsToIgnore` still
        // contribute to totalOps/Hours but are silently dropped from the
        // per-team rollup. This keeps the column set stable across runs.
    }

    // Round all hours to 1 decimal for CSV readability.
    const result = [];
    for (const bucket of buckets.values()) {
        bucket.totalHours = roundHours(bucket.totalHours);
        for (const t of TEAM_COLUMNS) {
            bucket.teams[t].hours = roundHours(bucket.teams[t].hours);
        }
        result.push(bucket);
    }
    return result;
}

module.exports = { computeStoreWorkBreakdown, TEAM_COLUMNS };
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
cd scheduler-backend && npm test
```

Expected: all 8 new `computeStoreWorkBreakdown` tests pass; previous tests still pass.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/store-work-breakdown.js scheduler-backend/test/store-work-breakdown.test.js
git commit -m "Add store-work-breakdown helper for per-store remaining-work rollup"
```

---

## Task 3: Server — forward `completedTasks` and `remainingWorkByStore` in `/api/optimize-run` baseline response

**Files:**
- Modify: `scheduler-backend/server.js`

- [ ] **Step 1: Capture `completedTasks` from the DB-filter call**

In `scheduler-backend/server.js`, find line ~2766-2770:

```javascript
            } else {
                updateProgress(0, 'Preparing project data...', 'preparing');
                const { tasks } = await prepareProjectDataLocal(projectTasks, updateProgress, timings, { fresh: forceFresh });
                preparedTasks = tasks;
            }
```

Change to:

```javascript
            let completedTasksForReport = null;
            } else {
                updateProgress(0, 'Preparing project data...', 'preparing');
                const { tasks, completedTasks } = await prepareProjectDataLocal(projectTasks, updateProgress, timings, { fresh: forceFresh });
                preparedTasks = tasks;
                completedTasksForReport = completedTasks;
            }
```

Hmm — `let completedTasksForReport = null;` inside the else branch would scope incorrectly. Put the `let` declaration outside the if/else. Correct replacement:

```javascript
            let preparedTasks;
            let completedTasksForReport = null;
            if (skipDbFilter) {
                preparedTasks = projectTasks;
                timings.note('skipDbFilter', true);
                updateProgress(10, 'Using pre-prepared tasks (DB filter skipped)...', 'preparing');
            } else {
                updateProgress(0, 'Preparing project data...', 'preparing');
                const { tasks, completedTasks } = await prepareProjectDataLocal(projectTasks, updateProgress, timings, { fresh: forceFresh });
                preparedTasks = tasks;
                completedTasksForReport = completedTasks;
            }
```

(Read the block at lines 2760-2770 to verify the surrounding context before editing — you're replacing the `let preparedTasks; if (skipDbFilter) { ... } else { ... }` block.)

- [ ] **Step 2: Import the new helper and compute `remainingWorkByStore` after scoring**

At the top of `server.js` with the other `require` statements (~lines 1-25), add:

```javascript
const { computeStoreWorkBreakdown } = require('./store-work-breakdown');
```

Then find the block around line ~2908-2930 that builds `optResultPayload`. Just after the `const scoreData = scoreResult(...)` call and `const trimmed = trimEngineResult(engineResult);`, compute the breakdown and augment the payload:

Find:

```javascript
            const optResultPayload = {
                score: scoreData,
                projectSummary: trimmed.projectSummary,
                ...
                preparedTasks: (req.body.returnPreparedTasks && !skipDbFilter) ? preparedTasks : undefined,
                logs: (trimmed.logs || []).slice(-30)
            };
```

Change to:

```javascript
            // Compute per-store remaining-work rollup so the cron can attach a CSV.
            // Only meaningful on the baseline iteration (same task set every time).
            const teamsToIgnoreSet = new Set(
                String(params.teamsToIgnore || '').split(',').map(t => t.trim()).filter(Boolean)
            );
            const remainingWorkByStore = computeStoreWorkBreakdown(
                preparedTasks, scoreData.storeBreakdown, storeDueDates, teamsToIgnoreSet
            );

            const optResultPayload = {
                score: scoreData,
                projectSummary: trimmed.projectSummary,
                teamUtilization: trimmed.teamUtilization,
                teamWorkload: trimmed.teamWorkload,
                weeklyOutput: trimmed.weeklyOutput,
                projectedCompletion: trimmed.projectedCompletion,
                projectTypeMap,
                configUsed: {
                    params,
                    priorityWeights: priorityWeights || {},
                    headcounts: teamDefs.headcounts,
                    workHourOverrides: workHourOverrides || [],
                    teamMemberChanges: teamMemberChanges || [],
                    hybridWorkers: hybridWorkers || []
                },
                preparedTasks: (req.body.returnPreparedTasks && !skipDbFilter) ? preparedTasks : undefined,
                // completedTasks and remainingWorkByStore are returned ONLY for the
                // baseline iteration (same opt-in flag). Subsequent LLM iterations
                // don't need them — they're static across the cron run.
                completedTasks: (req.body.returnPreparedTasks && !skipDbFilter) ? completedTasksForReport : undefined,
                remainingWorkByStore: (req.body.returnPreparedTasks && !skipDbFilter) ? remainingWorkByStore : undefined,
                logs: (trimmed.logs || []).slice(-30)
            };
```

(Read the surrounding block to verify `storeDueDates` is in scope at the insertion point — it is, parsed at line ~2866 a bit earlier.)

- [ ] **Step 3: Syntax check**

```bash
cd scheduler-backend && node --check server.js && echo "syntax OK"
```

- [ ] **Step 4: Run full test suite to confirm no regressions**

```bash
cd scheduler-backend && npm test
```

Expected: all previous tests still pass (no new tests in this task — the shape change is covered by the end-to-end smoke test in Task 6).

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/server.js
git commit -m "Return completedTasks and remainingWorkByStore in baseline /api/optimize-run response"
```

---

## Task 4: Cron — build the two CSV attachments

**Files:**
- Modify: `scheduler-backend/optimizer-cron.js`

- [ ] **Step 1: Import the CSV helper**

At the top of `scheduler-backend/optimizer-cron.js` with other requires, add:

```javascript
const { toCsv } = require('./csv-format');
```

- [ ] **Step 2: Capture the new fields from the baseline result**

Find the baseline call in `optimizer-cron.js:807-814`:

```javascript
    } else {
        baseResult = await runWithConfig(data, { priorityWeights: {} }, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ false);
        logScore('Baseline', baseResult.score);
        preparedTasks = baseResult.preparedTasks || null;
        if (preparedTasks) {
            console.log(`  Captured ${preparedTasks.length} DB-filtered tasks for reuse across iterations.`);
        } else {
            console.log(`  WARNING: server did not return preparedTasks. Subsequent runs may not match baseline.`);
        }
    }
```

Change to:

```javascript
    } else {
        baseResult = await runWithConfig(data, { priorityWeights: {} }, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ false);
        logScore('Baseline', baseResult.score);
        preparedTasks = baseResult.preparedTasks || null;
        if (preparedTasks) {
            console.log(`  Captured ${preparedTasks.length} DB-filtered tasks for reuse across iterations.`);
        } else {
            console.log(`  WARNING: server did not return preparedTasks. Subsequent runs may not match baseline.`);
        }
        console.log(`  Baseline completed ops: ${(baseResult.completedTasks || []).length}`);
        console.log(`  Baseline stores in scope: ${(baseResult.remainingWorkByStore || []).length}`);
    }
```

- [ ] **Step 3: Build a Store lookup for enriching completedTasks**

`baseResult.completedTasks` has `Project/SKU/Operation/CompletionDate`. We want to prepend `Store`. Build a Project → Store map from the raw tasks loaded at the top of `main()`.

Find the block in `main()` where `data` is fetched (~line 769):

```javascript
    const data = await fetchJson(`${SERVER_URL}/api/optimization-data/latest`);
    console.log(`Loaded ${data.projectTasks.length} tasks`);
```

A few lines later, right after `const baseScore = baseResult.score;`, add this helper block (or inline where the attachments are built, below):

```javascript
    // Build a Project → Store lookup so the completed-ops CSV can include Store.
    // projectTasks rows are { Project, Store, Team, SKU, Operation, ... }.
    const projectToStore = new Map();
    for (const t of data.projectTasks) {
        if (t.Project && !projectToStore.has(t.Project)) projectToStore.set(t.Project, t.Store || '');
    }
```

Actually — putting this inside `main()` right after `baseResult` is captured is cleanest. Insert after `const baseScore = baseResult.score;` (around line 816).

- [ ] **Step 4: Build the two CSVs and push into the attachments array**

Find the existing task-CSV block in `optimizer-cron.js:1029-1048`:

```javascript
    // 3. Task CSV — the DB-filtered task data with the adjusted start date, ready for
    //    upload into the scheduler UI to reproduce any of these runs.
    if (preparedTasks && preparedTasks.length > 0) {
        const taskHeaders = Object.keys(preparedTasks[0]);
        const taskCsvRows = [taskHeaders.join(',')];
        for (const task of preparedTasks) {
            taskCsvRows.push(taskHeaders.map(h => {
                const val = task[h];
                if (val == null) return '';
                const str = String(val);
                return str.includes(',') || str.includes('"') || str.includes('\n')
                    ? `"${str.replace(/"/g, '""')}"` : str;
            }).join(','));
        }
        attachments.push({
            filename: `tasks-${startDateStr}.csv`,
            content: taskCsvRows.join('\n'),
        });
        console.log(`  Task CSV attachment: ${preparedTasks.length} tasks`);
    }
```

**Leave this block alone** — it's the existing task CSV. Task 5 will refactor it onto `toCsv`. In THIS task, just ADD two new attachment blocks immediately before it (`// 3. Task CSV` becomes `// 5. Task CSV`, and we insert 3 and 4):

Insert immediately BEFORE the task CSV block:

```javascript
    // 3. DB-filtered-out CSV — completed ops that the DB filter removed from the baseline's
    //    task list. Enriched with Store (via Project → Store lookup) so Danny can audit
    //    "does Fulcrum agree that these are done?" without cross-referencing Project→Store
    //    elsewhere.
    const completedTasks = baseResult.completedTasks || [];
    if (completedTasks.length > 0) {
        const enriched = completedTasks.map(c => ({
            Store: projectToStore.get(c.Project) || '',
            Project: c.Project,
            SKU: c.SKU,
            Operation: c.Operation,
            CompletionDate: c.CompletionDate,
        }));
        attachments.push({
            filename: `db-filtered-out-${startDateStr}.csv`,
            content: toCsv(enriched, ['Store', 'Project', 'SKU', 'Operation', 'CompletionDate']),
        });
        console.log(`  DB-filtered-out CSV attachment: ${completedTasks.length} completed ops`);
    }

    // 4. Remaining-work-by-store CSV — per-store rollup of the baseline's remaining
    //    tasks, with per-team ops/hours so Danny can see which team is gating each store.
    const remainingWorkByStore = baseResult.remainingWorkByStore || [];
    if (remainingWorkByStore.length > 0) {
        // Sort ascending by due date (same convention as the email comparison table).
        // NO_DUE_DATE rows sink to the bottom — mirrors sortStoresByDueDate in email-report.js.
        const { parseLocalDate } = require('./scoring');
        const sorted = remainingWorkByStore.slice().sort((a, b) => {
            if (!a.dueDate && !b.dueDate) return a.store.localeCompare(b.store);
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            const ta = parseLocalDate(a.dueDate).getTime();
            const tb = parseLocalDate(b.dueDate).getTime();
            if (isNaN(ta) && isNaN(tb)) return 0;
            if (isNaN(ta)) return 1;
            if (isNaN(tb)) return -1;
            return ta - tb;
        });
        const teamCols = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC'];
        // Flatten `teams: { Paint: { ops, hours } }` into flat columns for the CSV.
        const flatRows = sorted.map(r => {
            const flat = {
                Store: r.store,
                ProjectType: r.projectType || '',
                Due: r.dueDate || '',
                'Projected Finish': r.finishDate || '',
                'Lateness Days': r.latenessDays,
                'Total Ops': r.totalOps,
                'Total Hours': r.totalHours,
            };
            for (const t of teamCols) {
                flat[`${t} ops`] = r.teams[t].ops;
                flat[`${t} hrs`] = r.teams[t].hours;
            }
            return flat;
        });
        const columns = [
            'Store', 'ProjectType', 'Due', 'Projected Finish', 'Lateness Days',
            'Total Ops', 'Total Hours',
            ...teamCols.flatMap(t => [`${t} ops`, `${t} hrs`]),
        ];
        attachments.push({
            filename: `remaining-work-by-store-${startDateStr}.csv`,
            content: toCsv(flatRows, columns),
        });
        console.log(`  Remaining-work-by-store CSV attachment: ${remainingWorkByStore.length} stores`);
    }
```

(The final task CSV block below this now becomes "5. Task CSV" in comments but that's cosmetic — leave its comment unchanged to minimize churn.)

- [ ] **Step 5: Syntax check**

```bash
cd scheduler-backend && node --check optimizer-cron.js && echo "syntax OK"
```

- [ ] **Step 6: Run full test suite**

```bash
cd scheduler-backend && npm test
```

Expected: no regressions.

- [ ] **Step 7: Commit**

```bash
git add scheduler-backend/optimizer-cron.js
git commit -m "Attach db-filtered-out and remaining-work-by-store CSVs to cron email"
```

---

## Task 5: Opportunistic cleanup — refactor existing task-CSV onto `toCsv`

**Files:**
- Modify: `scheduler-backend/optimizer-cron.js`

The existing task-CSV block at `optimizer-cron.js:1029-1048` (now relabeled "5" after Task 4's additions) duplicates CSV escaping logic that now lives in `csv-format.js`. While we're in the file, refactor it onto `toCsv`.

- [ ] **Step 1: Replace the block**

Find the task-CSV block (begins `// 3. Task CSV` or similar — adjust if the comment label changed) that ends with `console.log(\`  Task CSV attachment: ${preparedTasks.length} tasks\`);`. Replace with:

```javascript
    // 5. Task CSV — the DB-filtered task data with the adjusted start date, ready for
    //    upload into the scheduler UI to reproduce any of these runs.
    if (preparedTasks && preparedTasks.length > 0) {
        const taskHeaders = Object.keys(preparedTasks[0]);
        attachments.push({
            filename: `tasks-${startDateStr}.csv`,
            content: toCsv(preparedTasks, taskHeaders),
        });
        console.log(`  Task CSV attachment: ${preparedTasks.length} tasks`);
    }
```

Note two behavioral differences from the old code:
- Line endings change from `\n` to `\r\n` (now Excel-canonical; harmless for anyone who was parsing the old output — CRLF is the CSV standard).
- Cells with `\r` are now also quoted (the old code only checked for `\n`). Strict improvement.

- [ ] **Step 2: Syntax check + tests**

```bash
cd scheduler-backend && node --check optimizer-cron.js && npm test
```

- [ ] **Step 3: Commit**

```bash
git add scheduler-backend/optimizer-cron.js
git commit -m "Refactor existing task CSV onto shared toCsv helper"
```

---

## Task 6: End-to-end smoke test

**Files:** no code changes — verification gate.

- [ ] **Step 1: Run full test suite one more time**

```bash
cd scheduler-backend && npm test
```

Expected: all tests pass (previous count + 8 toCsv + 8 store-work-breakdown = previous + 16).

- [ ] **Step 2: Syntax-check all modified files**

```bash
cd scheduler-backend && for f in csv-format.js store-work-breakdown.js server.js optimizer-cron.js; do
    node --check "$f" && echo "OK: $f"
done
```

- [ ] **Step 3: Exercise the full pipeline with a real run**

Option A — trigger the cron in dry-run mode:

```bash
cd scheduler-backend && OPTIMIZER_DRY_RUN=1 OPTIMIZER_ITERATIONS=2 node optimizer-cron.js 2>&1 | tee /tmp/cron-smoke.log
```

Dry-run mode may skip the baseline; check whether the `DRY_RUN` branch at `optimizer-cron.js:803` emits attachments. If it doesn't, skip to Option B.

Option B — trigger a real 1-iteration run locally, or against the production server:

```bash
OPTIMIZER_ITERATIONS=1 node optimizer-cron.js
```

Then check the morning email (or the `/tmp/` attachments folder if you redirected nodemailer) for:
- `db-filtered-out-{date}.csv` attached
- `remaining-work-by-store-{date}.csv` attached
- Both open in Excel/Sheets without errors
- DB-filtered-out CSV has a `Store` column populated (not empty)
- Remaining-work CSV has one row per in-scope store with correct per-team columns

- [ ] **Step 4: Spot-check PCB (the store that motivated this work)**

- Find PCB in `remaining-work-by-store-{date}.csv`. Confirm `Total Ops` matches what Fulcrum shows as remaining.
- Confirm the team breakdown points at the right team (e.g. if PCB has one remaining Assembly op, `Assembly ops = 1` and all other team columns = 0).
- Find PCB rows in `db-filtered-out-{date}.csv`. Confirm the completed ops match Fulcrum's "done" list, and that `CompletionDate` values look sane.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin claude/cron-csv-attachments
gh pr create --title "Cron email: add DB-filtered-out and remaining-work CSVs" --body "$(cat <<'EOF'
## Summary

Two new CSV attachments on the nightly optimizer email so the baseline can be audited against Fulcrum reality:

- **`db-filtered-out-{date}.csv`** — every completed op that the baseline's DB filter removed. Columns: Store, Project, SKU, Operation, CompletionDate (with time-of-day).
- **`remaining-work-by-store-{date}.csv`** — per in-scope store: due date, projected finish, lateness, total ops/hours, and per-team ops/hours. Sorted ascending by due date.

Motivation: 2026-04-21 cron predicted PCB finishing 5/6; ad-hoc run predicted 4/26. PCB has 1 operational step in Fulcrum. These CSVs make discrepancies like that visible from the email without digging through Render logs.

New modules:
- `scheduler-backend/csv-format.js` — CRLF-quoted CSV serializer.
- `scheduler-backend/store-work-breakdown.js` — per-store, per-team rollup.
- Both covered by unit tests.

Also refactors the existing task-CSV attachment onto the shared `toCsv` helper. No changes to `email-report.js` or `/api/send-optimization-report` — the existing attachments pipeline already forwards arbitrary CSVs.

## Test plan

- [x] `npm test` passes in `scheduler-backend/` — all previous tests + 16 new
- [x] Syntax-check (`node --check`) clean on all modified files
- [ ] Trigger a cron run end-to-end; confirm both attachments present, openable in Excel
- [ ] Spot-check PCB in both CSVs — verify the cron's view of completed ops and remaining work matches Fulcrum

Spec: [docs/superpowers/specs/2026-04-21-optimizer-cron-csv-attachments-design.md](docs/superpowers/specs/2026-04-21-optimizer-cron-csv-attachments-design.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

**Spec coverage:**
- [x] Attachment 1 (db-filtered-out) → Tasks 3, 4
- [x] Attachment 2 (remaining-work-by-store) → Tasks 2, 3, 4
- [x] CSV format (CRLF, quoting) → Task 1
- [x] Per-store rollup sorted by due date → Task 4 Step 4
- [x] teamsToIgnore folded into totals → Task 2 test + Task 3 wiring
- [x] TEAM_SORT_ORDER without Hybrid → Task 2 `TEAM_COLUMNS` + Task 4 flat rows
- [x] Lazy/optional attachments (baseline only) → Task 3 opt-in via `returnPreparedTasks`
- [x] email-report + /api/send-optimization-report unchanged → confirmed in plan header

**Placeholder scan:** No TBDs / "similar to" / vague instructions. Every step has code or exact commands.

**Type consistency:**
- `toCsv(rows, columns)` signature — Task 1, used identically in Tasks 4 & 5.
- `computeStoreWorkBreakdown(preparedTasks, storeBreakdown, storeDueDates, teamsToIgnore)` — Task 2, called with same signature in Task 3.
- `remainingWorkByStore[].teams[teamName].{ops, hours}` shape — consistent between Task 2 (produces) and Task 4 (consumes).
- `completedTasks[].{ Project, SKU, Operation, CompletionDate }` — data-prep.js produces, Task 4 consumes.
