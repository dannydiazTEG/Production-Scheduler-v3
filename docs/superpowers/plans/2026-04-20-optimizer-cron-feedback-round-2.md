# Optimizer Cron — Feedback Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply nine tightly-related fixes to the optimizer cron — scoring recalibration (grades, buffer curve in business days, OT curve + baseline OT capture), LLM constraints (horizon lock, team-specific hiring caps, stagger), CNC-specific rules, and email report clarity (sort + OT windows + CNC advisory).

**Architecture:** Pure-function extraction lets us unit-test scoring curves in isolation. Engine gets a new `overtimeHours` output channel computed from the `workHourOverrides` config (fixes the capacity bug where configured OT was invisible to the scorer). Server-side validation in `/api/optimize-run` rejects LLM proposals that violate the new constraints, identified by the existing `NewHire-*` / `Flex-*` naming convention. Tool schema changes on the agent side remove `horizonMonths` as a tunable.

**Tech Stack:** Node.js 22, Express 5, built-in `node --test` runner + `node:assert/strict` (no new deps), existing scheduler-backend files.

**Spec:** [`docs/superpowers/specs/2026-04-20-optimizer-cron-feedback-round-2-design.md`](../specs/2026-04-20-optimizer-cron-feedback-round-2-design.md)

**Pre-verified facts (from code reading during design):**
- `scheduling-engine.js:1253-1255` — OT overrides raise `capacity` (bug confirmed). Fix: compute OT hours separately from the `workHourOverrides` config during the capacity loop.
- `server.js:2700-2779` — validation already identifies LLM-added entries by naming convention (`NewHire-*`, `Flex-*`); we extend that same pattern.
- `optimizer-cron.js:31` — `DEFAULT_HORIZON_MONTHS = parseInt(argOf('--horizon', process.env.OPTIMIZER_HORIZON || '3'))` — currently 3, needs to become 6 and stop flowing from LLM.
- `email-report.js:177-237` — `renderScheduleComparison` builds `storeOrder` from append-order, not sorted. This is the table Danny wants sorted by due date.

---

## Task 1: Set up test infrastructure

**Files:**
- Modify: `scheduler-backend/package.json`
- Create: `scheduler-backend/test/` (directory)

- [ ] **Step 1: Update package.json test script**

Open `scheduler-backend/package.json`. Replace the `scripts.test` line:

```json
"test": "node --test test/"
```

Full scripts block should read:

```json
"scripts": {
    "test": "node --test test/",
    "start": "node server.js"
}
```

- [ ] **Step 2: Create the test directory**

```bash
mkdir -p scheduler-backend/test
```

- [ ] **Step 3: Sanity-check with a trivial test**

Create `scheduler-backend/test/sanity.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');

test('sanity: assert.strict works', () => {
    assert.equal(1 + 1, 2);
});
```

- [ ] **Step 4: Run tests to confirm infrastructure works**

```bash
cd scheduler-backend && npm test
```

Expected: `# pass 1` in output.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/package.json scheduler-backend/test/sanity.test.js
git commit -m "Add node:test infrastructure for scheduler-backend"
```

---

## Task 2: `businessDaysEarly` helper (TDD)

**Files:**
- Modify: `scheduler-backend/scoring.js`
- Create: `scheduler-backend/test/scoring.test.js`

- [ ] **Step 1: Write failing tests**

Create `scheduler-backend/test/scoring.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { businessDaysEarly } = require('../scoring');

test('businessDaysEarly: same day = 0', () => {
    assert.equal(businessDaysEarly('2026-05-01', '2026-05-01'), 0);
});

test('businessDaysEarly: finish 1 weekday before due = +1', () => {
    // Thu finish, Fri due
    assert.equal(businessDaysEarly('2026-05-01', '2026-04-30'), 1);
});

test('businessDaysEarly: skips weekends', () => {
    // Fri 2026-05-01 due, Mon 2026-04-27 finish → Mon, Tue, Wed, Thu = 4 business days early
    assert.equal(businessDaysEarly('2026-05-01', '2026-04-27'), 4);
});

test('businessDaysEarly: finish after due = negative', () => {
    // Fri due, next Mon finish → 1 business day late
    assert.equal(businessDaysEarly('2026-05-01', '2026-05-04'), -1);
});

test('businessDaysEarly: two full weeks early = 10', () => {
    // 2026-05-01 Fri due, 2026-04-17 Fri finish → 10 business days (M,T,W,T,F,M,T,W,T,F)
    assert.equal(businessDaysEarly('2026-05-01', '2026-04-17'), 10);
});

test('businessDaysEarly: across year boundary', () => {
    // 2026-01-05 Mon due, 2025-12-29 Mon finish → M,T,W,T,F = 5 business days
    assert.equal(businessDaysEarly('2026-01-05', '2025-12-29'), 5);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — `businessDaysEarly is not a function`.

- [ ] **Step 3: Implement `businessDaysEarly`**

In `scheduler-backend/scoring.js`, add this function near `calendarDays` (around line 69):

```javascript
/**
 * Count business days (Mon-Fri) between finishDate and dueDate.
 * Returns positive when finishDate is before dueDate (early), negative when late.
 * No holiday calendar — weekdays only.
 */
function businessDaysEarly(dueDate, finishDate) {
    const due = parseLocalDate(dueDate);
    const finish = parseLocalDate(finishDate);
    due.setHours(0, 0, 0, 0);
    finish.setHours(0, 0, 0, 0);

    if (due.getTime() === finish.getTime()) return 0;

    const sign = finish < due ? 1 : -1;
    const [start, end] = finish < due ? [finish, due] : [due, finish];

    let count = 0;
    const cursor = new Date(start.getTime());
    while (cursor < end) {
        cursor.setDate(cursor.getDate() + 1);
        const dow = cursor.getDay();
        if (dow !== 0 && dow !== 6) count++;
    }
    return sign * count;
}
```

Add to the `module.exports` block at the bottom of the file:

```javascript
businessDaysEarly,
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: all 6 `businessDaysEarly` tests pass.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Add businessDaysEarly helper for buffer scoring"
```

---

## Task 3: New `bufferScore` curve (TDD)

**Files:**
- Modify: `scheduler-backend/scoring.js:121-129` (replace `bufferScore`)
- Modify: `scheduler-backend/test/scoring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scheduler-backend/test/scoring.test.js`:

```javascript
const { bufferScore } = require('../scoring');

test('bufferScore: late = 0', () => {
    assert.equal(bufferScore(-1), 0);
    assert.equal(bufferScore(-10), 0);
});

test('bufferScore: on due date = 50', () => {
    assert.equal(bufferScore(0), 50);
});

test('bufferScore: 4 bd early = 80', () => {
    assert.equal(bufferScore(4), 80);
});

test('bufferScore: 10 bd early = peak 100', () => {
    assert.equal(bufferScore(10), 100);
});

test('bufferScore: 15 bd early = 70', () => {
    assert.equal(bufferScore(15), 70);
});

test('bufferScore: 20 bd early = 60', () => {
    // max(40, 70 - (20-15)*2) = max(40, 60) = 60
    assert.equal(bufferScore(20), 60);
});

test('bufferScore: 30 bd early = 40 floor', () => {
    // max(40, 70 - 15*2) = max(40, 40) = 40
    assert.equal(bufferScore(30), 40);
});

test('bufferScore: 100 bd early = 40 floor', () => {
    assert.equal(bufferScore(100), 40);
});

test('bufferScore: 1 bd early between 50 and 80', () => {
    const s = bufferScore(1);
    assert.ok(s > 50 && s < 80, `expected 50 < ${s} < 80`);
});

test('bufferScore: 7 bd early between 80 and 100', () => {
    const s = bufferScore(7);
    assert.ok(s > 80 && s < 100, `expected 80 < ${s} < 100`);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — current `bufferScore` at 0 returns 60 not 50, at 10 returns 85 not 100, etc.

- [ ] **Step 3: Replace `bufferScore` with the new curve**

In `scheduler-backend/scoring.js`, replace lines 118-129 (the current `bufferScore` and its comment) with:

```javascript
// --- Buffer score curve (for NSO/Infill), business days ---
// Late (beyond tolerance) = 0 (hard gate already filters these). On due date = 50.
// 1-4 bd early: 50→80 linear. 5-10 bd early: 80→100 linear (peak at 10).
// 11-15 bd early: 100→70 linear (over-buffered — resources could have gone elsewhere).
// 16+ bd early: max(40, 70 - (d-15)*2) — 40 floor.
function bufferScore(businessDaysEarly) {
    if (businessDaysEarly < 0) return 0;
    if (businessDaysEarly === 0) return 50;
    if (businessDaysEarly <= 4) return 50 + (businessDaysEarly / 4) * 30;       // 1=57.5, 4=80
    if (businessDaysEarly <= 10) return 80 + ((businessDaysEarly - 4) / 6) * 20; // 5=83.3, 10=100
    if (businessDaysEarly <= 15) return 100 - ((businessDaysEarly - 10) / 5) * 30; // 11=94, 15=70
    return Math.max(40, 70 - (businessDaysEarly - 15) * 2);                     // 20=60, 30=40
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: all new `bufferScore` tests pass.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Replace bufferScore with business-day curve peaking at 10 bd"
```

---

## Task 4: New `computeGrade` bands (TDD)

**Files:**
- Modify: `scheduler-backend/scoring.js:531-547` (replace band table in `computeGrade`)
- Modify: `scheduler-backend/test/scoring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scheduler-backend/test/scoring.test.js`:

```javascript
const { computeGrade } = require('../scoring');

function grade(score) {
    return computeGrade({ compositeScore: score, feasible: true, nsoViolations: [] }).grade;
}

test('computeGrade: 97 = A+', () => assert.equal(grade(97), 'A+'));
test('computeGrade: 96 = A', () => assert.equal(grade(96), 'A'));
test('computeGrade: 93 = A', () => assert.equal(grade(93), 'A'));
test('computeGrade: 92 = A-', () => assert.equal(grade(92), 'A-'));
test('computeGrade: 90 = A-', () => assert.equal(grade(90), 'A-'));
test('computeGrade: 89 = B+', () => assert.equal(grade(89), 'B+'));
test('computeGrade: 87 = B+', () => assert.equal(grade(87), 'B+'));
test('computeGrade: 86 = B', () => assert.equal(grade(86), 'B'));
test('computeGrade: 83 = B', () => assert.equal(grade(83), 'B'));
test('computeGrade: 82 = B-', () => assert.equal(grade(82), 'B-'));
test('computeGrade: 80 = B-', () => assert.equal(grade(80), 'B-'));
test('computeGrade: 79 = C+', () => assert.equal(grade(79), 'C+'));
test('computeGrade: 77 = C+', () => assert.equal(grade(77), 'C+'));
test('computeGrade: 76.4 = C', () => assert.equal(grade(76.4), 'C'));
test('computeGrade: 73 = C', () => assert.equal(grade(73), 'C'));
test('computeGrade: 72 = C-', () => assert.equal(grade(72), 'C-'));
test('computeGrade: 70 = C-', () => assert.equal(grade(70), 'C-'));
test('computeGrade: 69 = D', () => assert.equal(grade(69), 'D'));
test('computeGrade: 60 = D', () => assert.equal(grade(60), 'D'));
test('computeGrade: 59 = F', () => assert.equal(grade(59), 'F'));
test('computeGrade: 0 = F', () => assert.equal(grade(0), 'F'));

test('computeGrade: infeasible with 1 violation = D', () => {
    assert.equal(computeGrade({
        compositeScore: 80, feasible: false, nsoViolations: [{ store: 'X' }],
    }).grade, 'D');
});

test('computeGrade: infeasible with 3+ violations = F', () => {
    assert.equal(computeGrade({
        compositeScore: 80, feasible: false,
        nsoViolations: [{ store: 'X' }, { store: 'Y' }, { store: 'Z' }],
    }).grade, 'F');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — current bands put 76.4 at B+ (should be C), 70 at B (should be C-), etc.

- [ ] **Step 3: Replace the band table**

In `scheduler-backend/scoring.js`, replace lines 534-546 (the band logic inside `computeGrade`) with:

```javascript
    if (!feasible) {
        if ((nsoViolations || []).length >= 3) return { grade: 'F', summary: `${nsoViolations.length} NSO/Infill stores exceed tolerance` };
        return { grade: 'D', summary: `${(nsoViolations || []).length} NSO/Infill store(s) exceed tolerance` };
    }

    if (compositeScore >= 97) return { grade: 'A+', summary: 'Excellent — strong buffer, high efficiency' };
    if (compositeScore >= 93) return { grade: 'A', summary: 'Great schedule with comfortable margins' };
    if (compositeScore >= 90) return { grade: 'A-', summary: 'Solid schedule, minor room for improvement' };
    if (compositeScore >= 87) return { grade: 'B+', summary: 'Good schedule, some stores tight on timing' };
    if (compositeScore >= 83) return { grade: 'B', summary: 'Acceptable — moderate efficiency or tight buffer' };
    if (compositeScore >= 80) return { grade: 'B-', summary: 'Below target — review buffer and efficiency' };
    if (compositeScore >= 77) return { grade: 'C+', summary: 'Needs work — buffer tight and OT or efficiency slipping' };
    if (compositeScore >= 73) return { grade: 'C', summary: 'Significant gaps in delivery, efficiency, or OT' };
    if (compositeScore >= 70) return { grade: 'C-', summary: 'Marginal — multiple categories below target' };
    if (compositeScore >= 60) return { grade: 'D', summary: 'Poor — major scheduling issues' };
    return { grade: 'F', summary: 'Failing — rework the plan from the ground up' };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: all grade-band tests pass.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Recalibrate grade bands to standard US academic scale"
```

---

## Task 5: New `laborCostScore` pure function (TDD)

**Files:**
- Modify: `scheduler-backend/scoring.js`
- Modify: `scheduler-backend/test/scoring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scheduler-backend/test/scoring.test.js`:

```javascript
const { laborCostScore } = require('../scoring');

test('laborCostScore: 0 OT = 18 pts', () => {
    assert.equal(laborCostScore(0), 18);
});

test('laborCostScore: 200h OT = 15 pts', () => {
    // 18 * (1 - 200/1200) = 18 * 5/6 = 15
    assert.equal(laborCostScore(200), 15);
});

test('laborCostScore: 600h OT = 9 pts', () => {
    // 18 * (1 - 600/1200) = 9
    assert.equal(laborCostScore(600), 9);
});

test('laborCostScore: 1200h OT = 0 pts', () => {
    assert.equal(laborCostScore(1200), 0);
});

test('laborCostScore: 1500h OT = 0 pts (floored)', () => {
    assert.equal(laborCostScore(1500), 0);
});

test('laborCostScore: negative OT input treated as 0', () => {
    assert.equal(laborCostScore(-50), 18);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — `laborCostScore is not a function`.

- [ ] **Step 3: Add `laborCostScore`**

In `scheduler-backend/scoring.js`, add near the top (after the constants at line 17):

```javascript
/**
 * Labor Cost score (out of 18 pts).
 * Softer curve than the old 18 - (OT/100)*4.5 so realistic OT ranges differentiate:
 *   0h → 18, 200h → 15, 600h → 9, 1200h → 0, 1500h → 0 (floored).
 */
function laborCostScore(overtimeHours) {
    const ot = Math.max(0, overtimeHours || 0);
    return 18 * Math.max(0, 1 - ot / 1200);
}
```

Add `laborCostScore` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: all `laborCostScore` tests pass.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Add laborCostScore pure function for OT penalty curve"
```

---

## Task 6: CNC exclusion from dwell & team-health (TDD)

**Files:**
- Modify: `scheduler-backend/scoring.js:448` (dwell exclusion in `scoreResult`)
- Modify: `scheduler-backend/scoring.js:563` (`EXCLUDED_TEAMS` in `analyzeTeamHealth`)
- Modify: `scheduler-backend/test/scoring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scheduler-backend/test/scoring.test.js`:

```javascript
const { analyzeTeamHealth } = require('../scoring');

test('analyzeTeamHealth: CNC peak is excluded', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 200 }, { name: 'Paint', utilization: 50 }] },
    ];
    const teamWorkload = [
        { week: '2026-05-04', teams: [
            { name: 'CNC', workloadRatio: 400 },
            { name: 'Paint', workloadRatio: 400 },
        ] },
    ];
    const { peaks } = analyzeTeamHealth(teamUtilization, teamWorkload);
    const peakTeams = peaks.map(p => p.team);
    assert.ok(peakTeams.includes('Paint'), 'Paint peak kept');
    assert.ok(!peakTeams.includes('CNC'), 'CNC peak excluded');
});

test('analyzeTeamHealth: CNC valley is excluded', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 60 }] },
        { week: '2026-05-11', teams: [{ name: 'CNC', utilization: 20 }] },
        { week: '2026-05-18', teams: [{ name: 'CNC', utilization: 60 }] },
    ];
    const { valleys } = analyzeTeamHealth(teamUtilization, []);
    assert.equal(valleys.filter(v => v.team === 'CNC').length, 0, 'CNC valleys should be excluded');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — CNC currently appears in peaks/valleys.

- [ ] **Step 3: Add CNC to the exclusion set**

In `scheduler-backend/scoring.js`, change line 563 inside `analyzeTeamHealth`:

```javascript
    const EXCLUDED_TEAMS = new Set(['Receiving', 'QC', 'Hybrid', 'CNC']);
```

Also update the dwell-category averager in `scoreResult` — at around line 448, change:

```javascript
                // Skip Receiving and QC — they're not production-flow relevant
                if (team.name === 'Receiving' || team.name === 'QC') continue;
```

to:

```javascript
                // Skip Receiving, QC, and CNC — not labor-rebalanceable flow problems
                if (team.name === 'Receiving' || team.name === 'QC' || team.name === 'CNC') continue;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: CNC exclusion tests pass; no existing tests regressed.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Exclude CNC from dwell/flow and team-health peaks/valleys"
```

---

## Task 7: CNC weekend-shift advisory flag (TDD)

**Files:**
- Modify: `scheduler-backend/scoring.js` (add helper + surface in `scoreResult` output)
- Modify: `scheduler-backend/test/scoring.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scheduler-backend/test/scoring.test.js`:

```javascript
const { shouldAdviseCncWeekendShift } = require('../scoring');

test('cncAdvisory: triggered when CNC sustained high AND NSO miss', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 95 }] },
        { week: '2026-05-11', teams: [{ name: 'CNC', utilization: 92 }] },
        { week: '2026-05-18', teams: [{ name: 'CNC', utilization: 100 }] },
        { week: '2026-05-25', teams: [{ name: 'CNC', utilization: 91 }] },
    ];
    const nsoViolations = [{ store: 'LATE_STORE' }];
    assert.equal(shouldAdviseCncWeekendShift(teamUtilization, nsoViolations), true);
});

test('cncAdvisory: not triggered when no NSO miss', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 95 }] },
        { week: '2026-05-11', teams: [{ name: 'CNC', utilization: 95 }] },
        { week: '2026-05-18', teams: [{ name: 'CNC', utilization: 95 }] },
        { week: '2026-05-25', teams: [{ name: 'CNC', utilization: 95 }] },
    ];
    assert.equal(shouldAdviseCncWeekendShift(teamUtilization, []), false);
});

test('cncAdvisory: not triggered when CNC below 90', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 80 }] },
        { week: '2026-05-11', teams: [{ name: 'CNC', utilization: 80 }] },
    ];
    assert.equal(shouldAdviseCncWeekendShift(teamUtilization, [{ store: 'X' }]), false);
});

test('cncAdvisory: needs at least 3 sustained weeks', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 95 }] },
        { week: '2026-05-11', teams: [{ name: 'CNC', utilization: 95 }] },
    ];
    assert.equal(shouldAdviseCncWeekendShift(teamUtilization, [{ store: 'X' }]), false);
});
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL — `shouldAdviseCncWeekendShift is not a function`.

- [ ] **Step 3: Implement the advisory helper and surface it**

In `scheduler-backend/scoring.js`, add near `analyzeTeamHealth`:

```javascript
/**
 * CNC weekend-shift advisory: true when CNC runs >= 90% utilization for at
 * least 3 weeks AND the schedule has at least one NSO/Infill miss.
 * Not an LLM lever — surfaced in the email report for human review.
 */
function shouldAdviseCncWeekendShift(teamUtilization, nsoViolations) {
    if (!nsoViolations || nsoViolations.length === 0) return false;
    let sustained = 0;
    for (const weekData of (teamUtilization || [])) {
        const cnc = (weekData.teams || []).find(t => t.name === 'CNC');
        if (cnc && (cnc.utilization || 0) >= 90) {
            sustained++;
            if (sustained >= 3) return true;
        } else {
            sustained = 0;
        }
    }
    return false;
}
```

Inside `scoreResult`, just before `result.grade = gradeData.grade;` (around line 522), add:

```javascript
    result.cncWeekendShiftAdvisory = shouldAdviseCncWeekendShift(teamUtilization, nsoViolations);
```

Add `shouldAdviseCncWeekendShift` to `module.exports`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: advisory tests pass.

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Add CNC weekend-shift advisory to scoring output"
```

---

## Task 8: Engine — compute `overtimeHours` from `workHourOverrides` (TDD)

**Files:**
- Create: `scheduler-backend/overtime-calc.js` (extracted pure function)
- Modify: `scheduler-backend/scheduling-engine.js` (call the helper, expose `overtimeHours` and `overtimeBreakdown` on engineResult)
- Create: `scheduler-backend/test/overtime-calc.test.js`

Rationale for extraction: computing OT inside `scheduling-engine.js` without a dedicated helper makes it untestable in isolation. A pure function taking `(workHourOverrides, params, ptoMap, teamDefs, holidayList, teamMemberChanges)` is trivial to test.

- [ ] **Step 1: Write failing tests**

Create `scheduler-backend/test/overtime-calc.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOvertimeHours } = require('../overtime-calc');

const emptyPto = {};
const noHolidays = new Set();
const noChanges = [];

test('computeOvertimeHours: single window, 10h/day, 2 people, 5 weekdays', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-08', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    // 5 weekdays × 2 people × (10-8) = 20 OT hours
    assert.equal(result.totalHours, 20);
    assert.equal(result.breakdown.length, 1);
    assert.equal(result.breakdown[0].team, 'Paint');
    assert.equal(result.breakdown[0].hours, 20);
    assert.equal(result.breakdown[0].source, 'config');
});

test('computeOvertimeHours: 9h/day = 1h OT per person per day', () => {
    const overrides = [
        { team: 'Assembly', hours: 9, startDate: '2026-05-04', endDate: '2026-05-04', source: 'llm' },
    ];
    const teamDefs = { headcounts: [{ name: 'Assembly', count: 3 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 3);  // 1 day × 3 people × 1h
});

test('computeOvertimeHours: skips weekends', () => {
    const overrides = [
        // Sat-Sun-Mon — only Mon counts
        { team: 'Paint', hours: 10, startDate: '2026-05-02', endDate: '2026-05-04', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 1 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-02' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 2);  // Mon only × 1 × 2h OT
});

test('computeOvertimeHours: skips holidays', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-06', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 1 }] };
    const holidays = new Set(['2026-05-05']);
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, holidays, noChanges);
    assert.equal(result.totalHours, 4);  // Mon + Wed only × 1 × 2h
});

test('computeOvertimeHours: accounts for PTO', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    const pto = { '2026-05-04': new Set(['Paint1']) };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, pto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 2);  // 1 day × 1 effective × 2h
});

test('computeOvertimeHours: overrides with hours <= standard are ignored', () => {
    const overrides = [
        { team: 'Paint', hours: 8, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
        { team: 'Paint', hours: 7, startDate: '2026-05-05', endDate: '2026-05-05', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 0);
});

test('computeOvertimeHours: splits breakdown by team', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
        { team: 'Assembly', hours: 9, startDate: '2026-05-04', endDate: '2026-05-04', source: 'llm' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 1 }, { name: 'Assembly', count: 1 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 3);  // 2 + 1
    assert.equal(result.breakdown.length, 2);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Create `overtime-calc.js`**

```javascript
/**
 * overtime-calc.js — Compute overtime hours from config/LLM work-hour overrides.
 *
 * Why this exists: scheduling-engine.js treats OT windows by raising the day's
 * per-worker hours, which raises `capacity`. That means scoring can't see
 * configured OT via `worked - capacity`. This helper totals OT directly from
 * the override windows, independent of what the engine ran.
 *
 * An OT hour = (override.hours - standardHoursPerDay) per working headcount
 * per day within the window, excluding weekends, holidays, and PTO.
 */

function parseDate(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return new Date(s);
}

function formatDate(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}

/**
 * @param {Array} workHourOverrides - [{ team, hours, startDate, endDate, source? }]
 * @param {Object} params - must include hoursPerDay (standard)
 * @param {Object} ptoMap - { 'YYYY-MM-DD': Set<memberName> }
 * @param {Object} teamDefs - { headcounts: [{ name, count }] }
 * @param {Set<string>} holidayList - holiday dates as 'YYYY-MM-DD'
 * @param {Array} teamMemberChanges - [{ team, name, date, type }]
 * @returns {{ totalHours: number, breakdown: Array<{ team, hours, startDate, endDate, source }> }}
 */
function computeOvertimeHours(workHourOverrides, params, ptoMap, teamDefs, holidayList, teamMemberChanges) {
    const standardHours = parseFloat(params.hoursPerDay) || 8;
    const headcountByTeam = new Map((teamDefs.headcounts || []).map(h => [h.name, h.count || 0]));
    const breakdown = [];
    let totalHours = 0;

    for (const ot of (workHourOverrides || [])) {
        const otHours = parseFloat(ot.hours);
        if (!isFinite(otHours) || otHours <= standardHours) continue;

        const premiumPerPersonPerDay = otHours - standardHours;
        const start = parseDate(ot.startDate);
        const end = parseDate(ot.endDate || ot.startDate);
        let windowHours = 0;

        const baseHC = Math.floor(headcountByTeam.get(ot.team) || 0);
        const cursor = new Date(start.getTime());
        while (cursor <= end) {
            const dayStr = formatDate(cursor);
            const dow = cursor.getDay();
            if (dow !== 0 && dow !== 6 && !holidayList.has(dayStr)) {
                // Synthesize team roster for this day (same pattern as scheduling-engine.js:1258-1261)
                const roster = new Set();
                for (let h = 0; h < baseHC; h++) {
                    roster.add(`${ot.team.replace(/\s/g, '')}${h + 1}`);
                }
                for (const c of (teamMemberChanges || [])) {
                    if (c.team === ot.team && dayStr >= c.date) {
                        if (c.type === 'Starts') roster.add(c.name);
                        else roster.delete(c.name);
                    }
                }
                const ptoSet = ptoMap[dayStr] || new Set();
                const workingCount = [...roster].filter(m => !ptoSet.has(m)).length;
                windowHours += workingCount * premiumPerPersonPerDay;
            }
            cursor.setDate(cursor.getDate() + 1);
        }

        totalHours += windowHours;
        breakdown.push({
            team: ot.team,
            hours: Number(windowHours.toFixed(1)),
            startDate: ot.startDate,
            endDate: ot.endDate || ot.startDate,
            hoursPerDay: otHours,
            source: ot.source || 'unknown',
        });
    }

    return { totalHours: Number(totalHours.toFixed(1)), breakdown };
}

module.exports = { computeOvertimeHours };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: all 7 `computeOvertimeHours` tests pass.

- [ ] **Step 5: Wire engine to compute and expose OT hours**

In `scheduler-backend/scheduling-engine.js`, near the top imports add:

```javascript
const { computeOvertimeHours } = require('./overtime-calc');
```

Find the `return` statement at the end of `runSchedulingEngine` (search for `projectSummary,` or `teamUtilization,` in the final return object). Before the return, compute OT:

```javascript
    const otData = computeOvertimeHours(
        workHourOverrides || [],
        params,
        ptoMap,
        teamDefs,
        holidayList,
        teamMemberChanges || [],
    );
```

Add to the returned object:

```javascript
        overtimeHours: otData.totalHours,
        overtimeBreakdown: otData.breakdown,
```

Note: `workHourOverrides` and `teamMemberChanges` are already function parameters of `runSchedulingEngine`. `ptoMap`, `holidayList`, and `params` already exist as locals — verify their names match before hitting save. If the variable for holidays is named differently (e.g. `holidays` not `holidayList`), use the actual name.

- [ ] **Step 6: Commit**

```bash
git add scheduler-backend/overtime-calc.js scheduler-backend/scheduling-engine.js scheduler-backend/test/overtime-calc.test.js
git commit -m "Compute OT hours from workHourOverrides, expose on engineResult"
```

---

## Task 9: Wire scoring to use `engineResult.overtimeHours` + business days + new curves

**Files:**
- Modify: `scheduler-backend/scoring.js:232-526` (the body of `scoreResult`)

- [ ] **Step 1: Update `scoreResult` to use new helpers**

In `scheduler-backend/scoring.js`:

**1a.** In the destructure at line 241, add `overtimeHours: engineOvertimeHours` and `overtimeBreakdown`:

```javascript
    const { finalSchedule, projectSummary, teamUtilization, weeklyOutput, teamWorkload, overtimeHours: engineOvertimeHours, overtimeBreakdown } = engineResult;
```

**1b.** In the buffer computation (around lines 313-334), replace the `calendarDays` usage with `businessDaysEarly`:

Find:

```javascript
        const latenessDays = Math.max(0, calendarDays(data.maxFinishDate, dueDate));
        const daysEarly = Math.max(0, calendarDays(dueDate, data.maxFinishDate));
```

Replace with:

```javascript
        const latenessDays = Math.max(0, calendarDays(data.maxFinishDate, dueDate));  // still calendar days for tolerance gating
        const bdEarly = businessDaysEarly(dueDate, data.maxFinishDate);  // business days for buffer scoring
        const daysEarly = Math.max(0, bdEarly);
```

Find (lines 332-334):

```javascript
            // Buffer score for this store
            const effectiveDaysEarly = latenessDays > 0 ? -latenessDays : daysEarly;
            nsoInfillStores.push({ store, daysEarly: effectiveDaysEarly, bufferPts: bufferScore(effectiveDaysEarly) });
```

Replace with:

```javascript
            // Buffer score for this store (business days)
            const effectiveBdEarly = latenessDays > 0 ? -Math.abs(bdEarly || 1) : bdEarly;
            nsoInfillStores.push({ store, daysEarly: effectiveBdEarly, bufferPts: bufferScore(effectiveBdEarly) });
```

**1c.** Replace the Labor Cost computation. Find (around lines 402-416):

```javascript
    let overtimeHours = 0;
    for (const weekData of (teamUtilization || [])) {
        for (const team of weekData.teams) {
            const worked = parseFloat(team.worked) || 0;
            const capacity = parseFloat(team.capacity) || 0;
            if (worked > capacity && capacity > 0) {
                overtimeHours += worked - capacity;
            }
        }
    }
    const overtimeCost = overtimeHours * OT_PREMIUM_PER_HOUR;
    const baselineLaborCost = totalPaidHours * standardHoursPerDay; // Rough baseline
    // Score: 0 OT = 18 points. More OT = fewer points.
    // Every 100 OT hours drops ~4.5 points.
    let laborCostPoints = Math.max(0, 18 - (overtimeHours / 100) * 4.5);
```

Replace with:

```javascript
    // OT hours come from the engine's overtime-calc pass, which reads workHourOverrides
    // directly (configured OT + LLM-proposed OT). Legacy fallback to spillover detection
    // in case engineResult lacks the field (old cached results).
    let overtimeHours = Number(engineOvertimeHours || 0);
    if (!overtimeHours) {
        for (const weekData of (teamUtilization || [])) {
            for (const team of weekData.teams) {
                const worked = parseFloat(team.worked) || 0;
                const capacity = parseFloat(team.capacity) || 0;
                if (worked > capacity && capacity > 0) overtimeHours += worked - capacity;
            }
        }
    }
    const overtimeCost = overtimeHours * OT_PREMIUM_PER_HOUR;
    const laborCostPoints = laborCostScore(overtimeHours);
```

**1d.** Add `overtimeBreakdown` to the result object (around line 501, in the `labor` block):

```javascript
        labor: {
            totalOutputValue: Number(totalOutputValue.toFixed(2)),
            totalPaidHours: Number(totalPaidHours.toFixed(1)),
            efficiencyPerHour: Number(laborEfficiency.toFixed(2)),
            efficiencyBaseline: LABOR_EFFICIENCY_BASELINE,
            overtimeHours: Number(overtimeHours.toFixed(1)),
            overtimeCost: Number(overtimeCost.toFixed(2)),
            overtimeBreakdown: overtimeBreakdown || [],
            otPremiumRate: OT_PREMIUM_PER_HOUR,
        },
```

- [ ] **Step 2: Add an integration test for the new scoring wiring**

Append to `scheduler-backend/test/scoring.test.js`:

```javascript
const { scoreResult } = require('../scoring');

test('scoreResult: laborCostPoints uses engineResult.overtimeHours', () => {
    const engineResult = {
        finalSchedule: [],
        projectSummary: [],
        teamUtilization: [],
        teamWorkload: [],
        weeklyOutput: [{ totalValue: 0, totalHoursWorked: 100 }],
        overtimeHours: 600,  // should yield 9 pts via laborCostScore
        overtimeBreakdown: [{ team: 'Paint', hours: 600, source: 'config' }],
    };
    const result = scoreResult(engineResult, new Map(), { today: new Date('2026-05-01') });
    assert.equal(result.categories.laborCost, 9);
    assert.equal(result.labor.overtimeHours, 600);
    assert.equal(result.labor.overtimeBreakdown[0].team, 'Paint');
});

test('scoreResult: falls back to worked-capacity spillover when engineOvertimeHours missing', () => {
    const engineResult = {
        finalSchedule: [],
        projectSummary: [],
        teamUtilization: [
            { week: '2026-05-04', teams: [{ name: 'Paint', worked: '150', capacity: '100', utilization: 150 }] },
        ],
        teamWorkload: [],
        weeklyOutput: [{ totalValue: 0, totalHoursWorked: 100 }],
        // overtimeHours missing
    };
    const result = scoreResult(engineResult, new Map(), { today: new Date('2026-05-01') });
    assert.equal(result.labor.overtimeHours, 50);
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: integration tests pass, no regressions.

- [ ] **Step 4: Commit**

```bash
git add scheduler-backend/scoring.js scheduler-backend/test/scoring.test.js
git commit -m "Wire scoring to engine OT channel; use business days for buffer"
```

---

## Task 10: Extract `/api/optimize-run` validation to a pure module (TDD)

**Files:**
- Create: `scheduler-backend/optimize-run-validation.js`
- Modify: `scheduler-backend/server.js:2700-2779` (call the new module, keep backward-compatible behavior)
- Create: `scheduler-backend/test/optimize-run-validation.test.js`

Rationale: the current validation block in `server.js` is inline inside a 70-line `app.post` handler. Extracting it makes the new rules (horizon lock, hire caps, stagger) testable without spinning up express.

- [ ] **Step 1: Write tests for the existing behavior FIRST (preserve contract)**

Create `scheduler-backend/test/optimize-run-validation.test.js`:

```javascript
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOptimizeRunProposal } = require('../optimize-run-validation');

const baseTeamDefs = { headcounts: [
    { name: 'Paint', count: 8 }, { name: 'Scenic', count: 6 },
    { name: 'Carpentry', count: 10 }, { name: 'Assembly', count: 8 },
    { name: 'Tech', count: 5 }, { name: 'Metal', count: 3 },
    { name: 'CNC', count: 4 }, { name: 'Receiving', count: 4 }, { name: 'QC', count: 3 },
    { name: 'Kitting', count: 2 },
] };
const baseParams = { startDate: '2026-05-04' };

function body(overrides = {}) {
    return {
        params: baseParams,
        teamDefs: baseTeamDefs,
        horizonMonths: 6,
        ...overrides,
    };
}

test('preserves: bad flex route rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        hybridWorkers: [{ name: 'Flex-Paint-Tech-1', primaryTeam: 'Paint', secondaryTeam: 'Tech' }],
    }));
    assert.ok(errors.some(e => e.includes('Invalid flex route')));
});

test('preserves: OT >10h rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        workHourOverrides: [{ team: 'Paint', hours: 11, startDate: '2026-05-04', endDate: '2026-05-08' }],
    }));
    assert.ok(errors.some(e => e.includes('exceeds max 10h')));
});

test('preserves: +3 hire cap per team', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Paint-2', team: 'Paint', date: '2026-06-15' },
            { type: 'Starts', name: 'NewHire-Paint-3', team: 'Paint', date: '2026-06-29' },
            { type: 'Starts', name: 'NewHire-Paint-4', team: 'Paint', date: '2026-07-13' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('Too many hires')));
});
```

- [ ] **Step 2: Run to verify failure (module missing)**

```bash
cd scheduler-backend && npm test
```

Expected: FAIL — `optimize-run-validation` module missing.

- [ ] **Step 3: Create the module (extract existing logic verbatim)**

Create `scheduler-backend/optimize-run-validation.js`:

```javascript
/**
 * optimize-run-validation.js — Pure validation logic for /api/optimize-run.
 *
 * Only flags LLM-added entries (identified by naming convention: NewHire-*, Flex-*).
 * Pre-existing entries from uploaded configs use human names and are left alone.
 */

const ALLOWED_FLEX_ROUTES = new Set([
    'Paint→Scenic', 'Scenic→Paint',
    'Carpentry→Assembly', 'Assembly→Carpentry',
    'Tech→Metal',
]);
const NO_FLEX_TEAMS = new Set(['CNC', 'Receiving', 'QC']);
const LOCKED_HORIZON_MONTHS = 6;
const CNC_MAX_TOTAL = 5;
const KITTING_MAX_ADD = 1;
const METAL_MAX_ADD = 0;
const HIRE_STAGGER_DAYS = 14;
const HIRE_EARLIEST_OFFSET_DAYS = 28;

function validateOptimizeRunProposal(body) {
    const errors = [];
    const {
        params, teamDefs,
        hybridWorkers, workHourOverrides, teamMemberChanges,
        horizonMonths,
    } = body || {};

    // --- Horizon lock ---
    if (horizonMonths != null && Number(horizonMonths) !== LOCKED_HORIZON_MONTHS) {
        errors.push(`horizonMonths must be ${LOCKED_HORIZON_MONTHS} (received ${horizonMonths}). Horizon is locked.`);
    }

    const baseHC = new Map(((teamDefs && teamDefs.headcounts) || []).map(h => [h.name, h.count]));

    // --- Flex workers (preserve existing rules) ---
    if (hybridWorkers && hybridWorkers.length > 0) {
        const flexFromCount = new Map();
        for (const hw of hybridWorkers) {
            if (!hw.name || !hw.name.startsWith('Flex-')) continue;
            const route = `${hw.primaryTeam}→${hw.secondaryTeam}`;
            if (!ALLOWED_FLEX_ROUTES.has(route)) {
                errors.push(`Invalid flex route: ${route}. Allowed: Paint↔Scenic, Carpentry↔Assembly, Tech→Metal.`);
            }
            if (NO_FLEX_TEAMS.has(hw.primaryTeam)) {
                errors.push(`Cannot flex from ${hw.primaryTeam} — too specialized.`);
            }
            const count = (flexFromCount.get(hw.primaryTeam) || 0) + 1;
            flexFromCount.set(hw.primaryTeam, count);
            const teamHC = baseHC.get(hw.primaryTeam) || 0;
            const maxFlex = Math.floor(teamHC * 0.20);
            if (count > maxFlex) {
                errors.push(`Too many flex from ${hw.primaryTeam}: ${count} exceeds 20% cap (${maxFlex} max of ${teamHC}).`);
            }
        }
    }

    // --- OT windows (preserve existing hours cap) ---
    if (workHourOverrides && workHourOverrides.length > 0) {
        for (const ot of workHourOverrides) {
            const hours = parseFloat(ot.hours);
            if (hours > 10) errors.push(`OT window for ${ot.team}: ${hours}h/day exceeds max 10h.`);
        }
    }

    // --- Hire caps + stagger ---
    if (teamMemberChanges && teamMemberChanges.length > 0) {
        const scheduleStart = (params && params.startDate) ? new Date(params.startDate) : new Date();
        const earliestHire = new Date(scheduleStart);
        earliestHire.setDate(earliestHire.getDate() + HIRE_EARLIEST_OFFSET_DAYS);
        const earliestHireStr = earliestHire.toISOString().slice(0, 10);

        const hiresByTeam = new Map();
        const addedCountByTeam = new Map();
        for (const change of teamMemberChanges) {
            if (change.type !== 'Starts' || !change.name || !change.name.startsWith('NewHire')) continue;
            const team = change.team;
            const count = (hiresByTeam.get(team) || []);
            count.push(change);
            hiresByTeam.set(team, count);
            addedCountByTeam.set(team, (addedCountByTeam.get(team) || 0) + 1);

            if (change.date && new Date(change.date) < earliestHire) {
                errors.push(`Hire for ${team} starts ${change.date}, before earliest allowed ${earliestHireStr} (28d after schedule start).`);
            }
        }

        for (const [team, hires] of hiresByTeam.entries()) {
            // Per-team cap (general: +3; Metal: 0; Kitting: 1; CNC: total <=5)
            const added = hires.length;
            if (team === 'Metal' && added > METAL_MAX_ADD) {
                errors.push(`Metal cannot hire (Tech hybrid covers). Proposal adds ${added}.`);
            } else if (team === 'Kitting' && added > KITTING_MAX_ADD) {
                errors.push(`Kitting limited to +${KITTING_MAX_ADD} hire with strong justification. Proposal adds ${added}.`);
            } else if (team === 'CNC') {
                const baseCnc = baseHC.get('CNC') || 0;
                if (baseCnc + added > CNC_MAX_TOTAL) {
                    errors.push(`CNC headcount cap: ${baseCnc} baseline + ${added} hires > ${CNC_MAX_TOTAL}. Request weekend shift instead.`);
                }
            } else if (added > 3) {
                errors.push(`Too many hires for ${team}: ${added} exceeds max +3.`);
            }

            // Stagger: same-team hires must be >=14 days apart
            const dates = hires
                .map(h => h.date)
                .filter(Boolean)
                .map(d => new Date(d))
                .sort((a, b) => a - b);
            for (let i = 1; i < dates.length; i++) {
                const diffDays = Math.floor((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
                if (diffDays < HIRE_STAGGER_DAYS) {
                    errors.push(`Same-team hires on ${team} must be staggered >=${HIRE_STAGGER_DAYS} days. Got ${diffDays}d between ${dates[i - 1].toISOString().slice(0,10)} and ${dates[i].toISOString().slice(0,10)}.`);
                }
            }
        }
    }

    return errors;
}

module.exports = {
    validateOptimizeRunProposal,
    ALLOWED_FLEX_ROUTES,
    LOCKED_HORIZON_MONTHS,
    CNC_MAX_TOTAL,
    KITTING_MAX_ADD,
    METAL_MAX_ADD,
    HIRE_STAGGER_DAYS,
};
```

- [ ] **Step 4: Run tests to verify backward-compat tests pass**

```bash
cd scheduler-backend && npm test
```

Expected: the 3 preservation tests pass.

- [ ] **Step 5: Wire server.js to call the module (but don't change behavior yet)**

In `scheduler-backend/server.js`, at the top with other requires (around line 1-20), add:

```javascript
const { validateOptimizeRunProposal } = require('./optimize-run-validation');
```

Replace the block at lines 2705-2779 (the validation block inside `app.post('/api/optimize-run', ...)`) with:

```javascript
    const validationErrors = validateOptimizeRunProposal(req.body);

    // productivityAssumption intentionally NOT validated at the API level (see optimizer-cron).

    if (validationErrors.length > 0) {
        jobs[jobId].status = 'error';
        jobs[jobId].error = `Validation failed: ${validationErrors.join(' | ')}`;
        return res.status(400).json({ error: jobs[jobId].error, validationErrors });
    }
```

- [ ] **Step 6: Run tests to confirm no regressions**

```bash
cd scheduler-backend && npm test
```

Expected: all tests still pass.

- [ ] **Step 7: Commit**

```bash
git add scheduler-backend/optimize-run-validation.js scheduler-backend/server.js scheduler-backend/test/optimize-run-validation.test.js
git commit -m "Extract /api/optimize-run validation into pure module"
```

---

## Task 11: Add horizon-lock, hire-caps, and stagger tests (TDD for the new rules)

**Files:**
- Modify: `scheduler-backend/test/optimize-run-validation.test.js`

The `validateOptimizeRunProposal` already enforces the new rules (written in Task 10's module). This task adds the explicit tests for them — verifying the rules work.

- [ ] **Step 1: Append failing tests**

Add to `scheduler-backend/test/optimize-run-validation.test.js`:

```javascript
// --- New rules ---

test('horizon lock: rejects 3 months', () => {
    const errors = validateOptimizeRunProposal(body({ horizonMonths: 3 }));
    assert.ok(errors.some(e => e.includes('horizonMonths must be 6')));
});

test('horizon lock: accepts 6 months', () => {
    const errors = validateOptimizeRunProposal(body({ horizonMonths: 6 }));
    assert.ok(!errors.some(e => e.includes('horizonMonths')));
});

test('horizon lock: accepts missing (null) — optimizer-cron will set it', () => {
    const errors = validateOptimizeRunProposal(body({ horizonMonths: null }));
    assert.ok(!errors.some(e => e.includes('horizonMonths')));
});

test('Metal hire rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Metal-1', team: 'Metal', date: '2026-06-01' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('Metal cannot hire')));
});

test('Kitting: +1 accepted', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Kitting-1', team: 'Kitting', date: '2026-06-01' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('Kitting')));
});

test('Kitting: +2 rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Kitting-1', team: 'Kitting', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Kitting-2', team: 'Kitting', date: '2026-06-15' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('Kitting limited')));
});

test('CNC: baseline 4 + 1 hire = 5 total, accepted', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-CNC-1', team: 'CNC', date: '2026-06-01' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('CNC')));
});

test('CNC: baseline 4 + 2 hires = 6 total, rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-CNC-1', team: 'CNC', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-CNC-2', team: 'CNC', date: '2026-06-15' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('CNC headcount cap')));
});

test('stagger: same-team hires <14 days apart rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Paint-2', team: 'Paint', date: '2026-06-10' },  // 9 days
        ],
    }));
    assert.ok(errors.some(e => e.includes('staggered')));
});

test('stagger: same-team hires >=14 days apart accepted', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Paint-2', team: 'Paint', date: '2026-06-15' },  // 14 days
            { type: 'Starts', name: 'NewHire-Paint-3', team: 'Paint', date: '2026-06-29' },  // 14 days
        ],
    }));
    assert.ok(!errors.some(e => e.includes('staggered')));
});

test('stagger: cross-team hires on same day are fine', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Assembly-1', team: 'Assembly', date: '2026-06-01' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('staggered')));
});
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
cd scheduler-backend && npm test
```

Expected: all new rule tests pass (the rules are already implemented in Task 10's module — this task just asserts they work).

- [ ] **Step 3: Commit**

```bash
git add scheduler-backend/test/optimize-run-validation.test.js
git commit -m "Add tests for horizon lock, hire caps, and stagger rules"
```

---

## Task 12: optimizer-cron — remove horizon from LLM schema, force DEFAULT_HORIZON_MONTHS=6

**Files:**
- Modify: `scheduler-backend/optimizer-cron.js:31` (DEFAULT_HORIZON_MONTHS)
- Modify: `scheduler-backend/optimizer-cron.js:139-144` (tool schema `horizonMonths` property)
- Modify: `scheduler-backend/optimizer-cron.js:210` (required array)

- [ ] **Step 1: Update the default horizon**

Change line 31:

```javascript
const DEFAULT_HORIZON_MONTHS = parseInt(argOf('--horizon', process.env.OPTIMIZER_HORIZON || '6'));
```

- [ ] **Step 2: Remove horizonMonths from the tool schema**

Delete lines 139-144 (the entire `horizonMonths:` block in `properties`).

Change line 210 (the `required` array):

```javascript
        required: ['priorityWeights', 'reasoning'],
```

- [ ] **Step 3: Ensure optimizer-cron always sends horizonMonths=6 to /api/optimize-run**

The runWithConfig caller currently uses `proposal.horizonMonths` (line 885). Since we just removed it from the schema, `proposal.horizonMonths` will be undefined — update `runWithConfig` callers to pass `DEFAULT_HORIZON_MONTHS` explicitly.

Find line 885:

```javascript
            const result = await runWithConfig(data, proposal, proposal.horizonMonths, /* skipDbFilter */ true, preparedTasks);
```

Replace with:

```javascript
            const result = await runWithConfig(data, proposal, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ true, preparedTasks);
```

Also scan the rest of the file for other references to `proposal.horizonMonths` (several in logging — lines 874, 904, 924, 1022). Replace each with `DEFAULT_HORIZON_MONTHS`.

Use this to find them:

```bash
grep -n 'proposal.horizonMonths' scheduler-backend/optimizer-cron.js
```

For each match, swap `proposal.horizonMonths` → `DEFAULT_HORIZON_MONTHS`.

- [ ] **Step 4: Update the system-prompt snippet that describes horizonMonths**

Find line 72 (the template string that tells the LLM about `horizonMonths`):

```javascript
- \`horizonMonths\` controls how far into the future the engine simulates. We are starting at ${DEFAULT_HORIZON_MONTHS} months to get faster iterations and a cleaner signal from near-term stores. Only expand (4, 5, 6...) if scores plateau with clear headroom and you believe broader context would change the answer.
```

Replace with:

```javascript
- The scoring horizon is fixed at 6 months. You do not propose this — it is locked at the API level. Focus your proposals on tunable parameters (priorityWeights, flex, OT, hires, scheduleParams).
```

- [ ] **Step 5: Smoke-test — start the service locally and verify the tool schema is accepted by the Anthropic API**

Not a unit test; a manual check. Boot the cron in dry-run mode if available, or just `require` the module in a REPL:

```bash
cd scheduler-backend && node -e "const cron = require('./optimizer-cron'); console.log(Object.keys(cron));"
```

Expected: no parse error; module loads.

- [ ] **Step 6: Commit**

```bash
git add scheduler-backend/optimizer-cron.js
git commit -m "Lock optimizer horizon at 6 months; remove from LLM tool schema"
```

---

## Task 13: Agent-context markdown updates

**Files:**
- Modify: `scheduler-backend/agent-context/parameter-space.md`
- Modify: `scheduler-backend/agent-context/scoring.md`
- Modify: `scheduler-backend/agent-context/system.md`

- [ ] **Step 1: Read each file to understand current structure**

```bash
cat scheduler-backend/agent-context/parameter-space.md
cat scheduler-backend/agent-context/scoring.md
cat scheduler-backend/agent-context/system.md
```

These are markdown read by the managed agent. Preserve formatting; make targeted edits.

- [ ] **Step 2: Update `parameter-space.md`**

Remove any section describing `horizonMonths` as a tunable. Add a new section:

```markdown
## Locked parameters (DO NOT propose)

- **horizonMonths**: fixed at 6. The scoring window covers 6 months of stores. You cannot change this.
- **productivityAssumption**: fixed business decision (see system.md).
- **globalBuffer**: floor 3%, default 6.5% (see system.md).

## Hiring caps (per-team)

| Team | Max additional hires |
|------|---------------------|
| Metal | 0 (Tech hybrid covers) |
| Kitting | 1, with strong justification |
| CNC | Total headcount capped at 5; request weekend shift instead if more needed |
| Other teams | +3 |

Each same-team hire must be staggered by at least 14 days. First hire's earliest start is schedule_start + 28 days; hire 2 at +42 days; hire 3 at +56 days.

## CNC workload

CNC dwell/flow is excluded from scoring (the bottleneck is physical — 2 machines × 2 shifts M-F — not labor rebalancing). If CNC is sustained above 90% utilization with NSO/Infill misses, the email report will surface a "consider weekend shift" advisory for human review.
```

- [ ] **Step 3: Update `scoring.md`**

Replace the existing buffer curve section with:

```markdown
## Buffer score (40 pts, NSO/Infill only)

Measured in **business days** (Mon-Fri, no holiday calendar) between the store's scheduled finish and its store-level production due date.

| Business days early | Score |
|---------------------|-------|
| Late (beyond tolerance) | 0 (hard gate) |
| 0 (on due date) | 50 |
| 1-4 | 50 → 80 linear |
| 5-10 | 80 → 100 linear (peak at 10) |
| 11-15 | 100 → 70 linear |
| 16+ | max(40, 70 − (d − 15) × 2) |

Target the 5-10 bd zone. Finishing more than 15 bd early wastes capacity that could have been used on other stores.
```

Replace the grade-band section with:

```markdown
## Grade bands

Standard US academic scale.

| Grade | Composite score |
|-------|-----------------|
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

Infeasible schedules (>= 1 NSO/Infill violation beyond tolerance) cap at D; 3+ violations = F.
```

Replace the OT penalty section (or add if absent):

```markdown
## Labor Cost (18 pts) — OT penalty

All OT counts — both configured OT windows and LLM-added OT.

laborCostScore(OT_hours) = 18 × max(0, 1 − OT_hours / 1200)

| OT hours | Score |
|----------|-------|
| 0 | 18 |
| 200 | 15 |
| 600 | 9 |
| 1200+ | 0 |

Eliminating an existing OT window is a score WIN, not a no-op.
```

- [ ] **Step 4: Update `system.md`**

Find the existing guidance about OT (or add if absent). Ensure it contains:

```markdown
## OT policy

All overtime hours — both pre-existing config OT and your additions — count as a penalty. Your goal is to **reduce** OT hours where possible. Removing or shortening an existing OT window is a legitimate score improvement; prefer it over adding new OT.

Constraints:
- Max 10 hours/day for any OT window
- Max continuous OT window: 1-2 months
- Mandatory 1-month cooldown between OT windows for the same team (enforced by the engine; visible in reports)
```

- [ ] **Step 5: Commit**

```bash
git add scheduler-backend/agent-context/
git commit -m "Update agent context: locked horizon, new curves, hire caps, OT directive"
```

---

## Task 14: Email report — sort store comparison by due date

**Files:**
- Modify: `scheduler-backend/email-report.js:177-217` (`renderScheduleComparison`)

- [ ] **Step 1: Read current sort logic**

The relevant block is at `scheduler-backend/email-report.js:182-186`:

```javascript
    const storeOrder = [];
    const seen = new Set();
    const addStores = (arr) => { for (const s of arr || []) { if (!seen.has(s.store)) { seen.add(s.store); storeOrder.push(s.store); } } };
    addStores(baseline);
    for (const r of runs) addStores(r.storeBreakdown);
```

Currently: append order. We need to sort `storeOrder` by due date ascending, `NO_DUE_DATE` to bottom.

- [ ] **Step 2: Replace the store-ordering logic**

At `scheduler-backend/email-report.js:182-186`, replace with:

```javascript
    // Collect all stores (once each) and the best-known due date for each.
    const dueDateByStore = new Map();
    const addStores = (arr) => {
        for (const s of (arr || [])) {
            if (s.store && !dueDateByStore.has(s.store)) {
                dueDateByStore.set(s.store, s.dueDate || null);
            }
        }
    };
    addStores(baseline);
    for (const r of runs) addStores(r.storeBreakdown);

    // Sort ascending by due date. Stores with no due date go to the bottom.
    const storeOrder = [...dueDateByStore.keys()].sort((a, b) => {
        const da = dueDateByStore.get(a);
        const db = dueDateByStore.get(b);
        if (!da && !db) return a.localeCompare(b);
        if (!da) return 1;   // a has no due date → bottom
        if (!db) return -1;  // b has no due date → bottom
        return String(da).localeCompare(String(db));  // ISO dates sort lexicographically
    });
```

Note: ISO date strings (YYYY-MM-DD) sort correctly via `localeCompare`. The engine and scoring emit ISO-formatted dates consistently; the `formatDateUS` helper only runs at render time.

- [ ] **Step 3: Manual verification — render a sample**

Create a throwaway script to verify the sort:

```bash
cat > /tmp/verify-sort.js <<'EOF'
const { renderScheduleComparison } = require('/Users/dannydiaz/production-scheduler-v2/.claude/worktrees/flamboyant-hamilton-521587/scheduler-backend/email-report');
const baseline = [
    { store: 'Philly', dueDate: '2026-06-15', latenessDays: 0 },
    { store: 'Dallas', dueDate: '2026-05-01', latenessDays: 0 },
    { store: 'Nashville', dueDate: null, status: 'NO_DUE_DATE', latenessDays: 0 },
    { store: 'Boston', dueDate: '2026-05-20', latenessDays: 0 },
];
const html = renderScheduleComparison(baseline, { compositeScore: 80 }, []);
// storeOrder should be: Dallas, Boston, Philly, Nashville
const idx = s => html.indexOf(s);
console.log('Dallas first:', idx('Dallas') < idx('Boston'));
console.log('Boston before Philly:', idx('Boston') < idx('Philly'));
console.log('Philly before Nashville:', idx('Philly') < idx('Nashville'));
EOF
node /tmp/verify-sort.js
rm /tmp/verify-sort.js
```

Expected: all three lines print `true`.

Note: this test requires at least one run in the `topRuns` arg to render. If the function returns empty-string when `topRuns.length === 0`, pass a stub: `renderScheduleComparison(baseline, { compositeScore: 80 }, [{ iteration: 1, score: 80, storeBreakdown: [], paramChanges: '' }])`.

- [ ] **Step 4: Commit**

```bash
git add scheduler-backend/email-report.js
git commit -m "Sort store comparison table by due date (NO_DUE_DATE rows to bottom)"
```

---

## Task 15: Email report — OT window section

**Files:**
- Modify: `scheduler-backend/email-report.js` (add new `renderOvertimeSection` function)
- Modify: `scheduler-backend/email-report.js` (call it inside the main report render — same place that calls `renderScheduleComparison`)

- [ ] **Step 1: Add the new render function**

In `scheduler-backend/email-report.js`, add (anywhere after `renderScheduleComparison`, before `renderParamDiff`):

```javascript
/**
 * Render the per-run OT breakdown section.
 *
 * Expects `bestScore.labor.overtimeBreakdown` — produced by scoring.js from
 * engineResult.overtimeBreakdown. Each entry: { team, hours, startDate, endDate,
 * hoursPerDay, source: 'config' | 'llm' | 'both' }.
 */
function renderOvertimeSection(bestScore, baselineOtBreakdown) {
    const bestBreakdown = (bestScore && bestScore.labor && bestScore.labor.overtimeBreakdown) || [];
    const totalOt = (bestScore && bestScore.labor && bestScore.labor.overtimeHours) || 0;

    if (bestBreakdown.length === 0 && (baselineOtBreakdown || []).length === 0) {
        return `<h3 style="color: #1e293b; margin-top: 24px;">Overtime</h3>
                <p style="color: #475569; font-size: 13px;">No OT windows in best run. ✅</p>`;
    }

    // Build a source map: key = team|startDate|endDate → source
    const baselineKeys = new Set(
        (baselineOtBreakdown || []).map(b => `${b.team}|${b.startDate}|${b.endDate}`)
    );

    const rows = bestBreakdown.map(w => {
        const key = `${w.team}|${w.startDate}|${w.endDate}`;
        const source = baselineKeys.has(key) ? 'config' : 'llm';
        const sourceBadge = source === 'config'
            ? '<span style="background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 11px;">config</span>'
            : '<span style="background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-size: 11px;">llm</span>';
        return `<tr>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px;">${escapeHtml(w.team)}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px;">${formatDateUS(w.startDate)} → ${formatDateUS(w.endDate)}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px; text-align: right;">${w.hoursPerDay ?? '?'}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px; text-align: right;">${w.hours}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px;">${sourceBadge}</td>
        </tr>`;
    }).join('');

    const violations = findCooldownViolations(bestBreakdown);
    const violationHtml = violations.length === 0 ? '' : `
        <div style="margin-top: 8px; padding: 8px 12px; background: #fef2f2; border-left: 3px solid #ef4444; font-size: 13px; color: #7f1d1d;">
            ${violations.map(v => `⚠ ${escapeHtml(v)}`).join('<br>')}
        </div>`;

    return `
    <h3 style="color: #1e293b; margin-top: 24px;">Overtime — Best Run</h3>
    <p style="color: #64748b; font-size: 13px; margin: 0 0 8px;">Total: <strong>${totalOt.toFixed(1)}h</strong></p>
    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
            <tr style="background: #f1f5f9;">
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Team</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Window</th>
                <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #cbd5e1;">Hrs/day</th>
                <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #cbd5e1;">Total OT hrs</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Source</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>
    ${violationHtml}`;
}

/**
 * Flag teams with back-to-back OT windows <1 month apart.
 * Returns an array of human-readable strings.
 */
function findCooldownViolations(breakdown) {
    const byTeam = new Map();
    for (const w of breakdown) {
        if (!byTeam.has(w.team)) byTeam.set(w.team, []);
        byTeam.get(w.team).push(w);
    }
    const violations = [];
    const parseIso = s => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
    for (const [team, windows] of byTeam.entries()) {
        const sorted = windows
            .map(w => ({ ...w, start: parseIso(w.startDate), end: parseIso(w.endDate) }))
            .filter(w => w.start && w.end)
            .sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
            const gapDays = Math.floor((sorted[i].start - sorted[i - 1].end) / (1000 * 60 * 60 * 24));
            if (gapDays < 30) {
                violations.push(`${team}: OT windows ${sorted[i - 1].startDate}→${sorted[i - 1].endDate} and ${sorted[i].startDate}→${sorted[i].endDate} — gap is ${gapDays}d (needs ≥30d).`);
            }
        }
    }
    return violations;
}
```

- [ ] **Step 2: Call `renderOvertimeSection` from the main report renderer**

Find the main renderer function (search for `renderScheduleComparison(` — there should be a call in the main report HTML assembler, around line 339):

```javascript
            html += renderScheduleComparison(baselineScore?.storeBreakdown, baselineScore, topRuns);
```

Immediately after this line, add:

```javascript
            html += renderOvertimeSection(bestScore, baselineScore?.labor?.overtimeBreakdown);
```

If the variable name `bestScore` differs in that scope, use whatever the current scope's "best run score" variable is (search a few lines up — likely `best` or `bestScore`).

- [ ] **Step 3: Manual verification — render with a fixture**

```bash
cat > /tmp/verify-ot.js <<'EOF'
const { renderOvertimeSection } = require('/Users/dannydiaz/production-scheduler-v2/.claude/worktrees/flamboyant-hamilton-521587/scheduler-backend/email-report') || {};
// If renderOvertimeSection isn't exported, the test can't run this way — that's fine, skip to running a local require hack. For now just assert the function is visible.
EOF
rm /tmp/verify-ot.js
```

Since `email-report.js` does not currently have formal exports, manual QA is limited. Accept a visual check during implementation: run `npm run start` and trigger an optimizer run (or use a cached result) to see the email HTML. Alternative: add `renderOvertimeSection` to module.exports temporarily for testing.

Low-friction path: at the bottom of `email-report.js`, ensure the module exports both `renderOvertimeSection` and `findCooldownViolations` so they can be unit-tested later. If there's no `module.exports` block, skip — the function just needs to be reachable from the main render call.

- [ ] **Step 4: Commit**

```bash
git add scheduler-backend/email-report.js
git commit -m "Add OT breakdown section to email report with source split and cooldown flags"
```

---

## Task 16: Email report — CNC weekend-shift advisory

**Files:**
- Modify: `scheduler-backend/email-report.js` (add advisory callout)

- [ ] **Step 1: Add the advisory render**

In `scheduler-backend/email-report.js`, find the main renderer (the same scope where `renderScheduleComparison` is called). Immediately before the schedule comparison is rendered, add:

```javascript
            if (bestScore && bestScore.cncWeekendShiftAdvisory) {
                html += `
                <div style="margin: 16px 0; padding: 12px 16px; background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 4px;">
                    <strong style="color: #1e40af;">💡 CNC Weekend-Shift Advisory</strong><br>
                    <span style="color: #334155; font-size: 13px;">
                        CNC is running at sustained high utilization and NSO/Infill dates are slipping.
                        The optimizer cannot open a weekend shift — this requires a human decision.
                        Consider authorizing a Sat-Sun CNC shift if the schedule still shows misses.
                    </span>
                </div>`;
            }
```

If `bestScore` is named differently in the scope, use the local name.

- [ ] **Step 2: Manual verification**

Force-set `bestScore.cncWeekendShiftAdvisory = true` temporarily in a local run (or add a test fixture). Confirm the callout renders. Revert the test hack.

- [ ] **Step 3: Commit**

```bash
git add scheduler-backend/email-report.js
git commit -m "Add CNC weekend-shift advisory callout to email report"
```

---

## Task 17: optimizer-cron — plumb baseline OT breakdown to email report

**Files:**
- Modify: `scheduler-backend/optimizer-cron.js` (pass baseline score's labor.overtimeBreakdown through to the email report)

Rationale: `renderOvertimeSection` takes `baselineOtBreakdown` to decide which OT windows are config vs LLM-added. That comes from the baseline score's `labor.overtimeBreakdown`. Most of the plumbing is already in place (scoring emits it in Task 9); this task confirms it flows to the email renderer.

- [ ] **Step 1: Find where the email report is invoked**

```bash
grep -n "sendReport\|send-optimization-report\|email-report\|generateReport" scheduler-backend/optimizer-cron.js
```

- [ ] **Step 2: Ensure baseline score is passed into the email payload**

Inspect the call site. The email renderer reads `baselineScore.labor.overtimeBreakdown`; as long as the whole `baselineScore` object is passed through, no code change is needed. If it's being trimmed, include `labor.overtimeBreakdown` in the pass-through.

If there's no trimming happening — skip this task; the data already flows. Confirm by reviewing the email send code path.

- [ ] **Step 3 (conditional): If trimming is happening, preserve `labor.overtimeBreakdown`**

If the code does something like `{ compositeScore, grade, categories }` when assembling the email payload, change it to include `labor: { ...score.labor }` or pass the full score object.

- [ ] **Step 4: Commit if a change was needed**

```bash
git add scheduler-backend/optimizer-cron.js
git commit -m "Pass baseline OT breakdown through to email report"
```

If no change was needed, skip the commit for this task.

---

## Task 18: End-to-end smoke test

**Files:** no code changes — this is a verification gate.

- [ ] **Step 1: Run the full test suite**

```bash
cd scheduler-backend && npm test
```

Expected: all tests pass (sanity + 6 businessDaysEarly + 10 bufferScore + ~22 computeGrade + 6 laborCostScore + 2 CNC exclusion + 4 cncAdvisory + 7 overtime-calc + 13 optimize-run-validation + 2 scoreResult integration).

Total expected: ~70 test assertions across ~7 test files.

- [ ] **Step 2: Start the server and issue a dry-run optimizer run**

```bash
cd scheduler-backend && npm start
```

In a second terminal, trigger the cron or send a manual `/api/optimize-run` with a known config. Confirm:
- Proposal that includes `horizonMonths: 3` is rejected
- Proposal hiring Metal is rejected
- Proposal with Kitting +2 is rejected
- Proposal with Paint hires 10 days apart is rejected
- Clean proposal runs to completion
- Email report renders with new OT section + due-date sorted comparison table

- [ ] **Step 3: Compare one real run pre/post**

Keep a pre-change optimizer run result on hand. Run the same config post-change and compare:
- Composite score likely drops (OT now penalized correctly, grade bands harsher)
- Grade should shift one band lower in most cases
- Best-run OT hours should show in the breakdown section

Direction of movement is more important than absolute values — confirm scores moved as predicted.

- [ ] **Step 4: Final commit if any tweaks were needed during smoke test**

```bash
git status
# if anything modified:
git commit -am "Tweaks from smoke test"
```

- [ ] **Step 5: Push and open PR**

```bash
git push -u origin claude/flamboyant-hamilton-521587
gh pr create --title "Optimizer cron feedback round 2" --body "$(cat <<'EOF'
## Summary
Nine tightly-related fixes to the optimizer cron from a working session with Dan:
- Grade bands recalibrated to standard US academic scale (76.4 → C, was B+)
- Buffer curve moved to business days with peak at 10 bd early; >15 bd now penalized
- OT curve softened to `18 × (1 − h/1200)` and now captures configured OT (was invisible)
- Horizon hard-locked at 6 months
- Hiring: Metal 0, Kitting ≤1, CNC total ≤5, same-team 14-day stagger
- CNC excluded from dwell/flow scoring; weekend-shift advisory surfaced in report
- Email report: store comparison sorted by due date; OT window breakdown with source split + cooldown flags

## Test plan
- [ ] `npm test` passes in scheduler-backend/ (all unit tests)
- [ ] Dry-run optimizer with known config — verify validation rejects Metal hire, Kitting+2, horizon=3, stagger<14d
- [ ] Inspect email report from a full run — confirm sorted table, OT section, advisory callout when applicable
- [ ] Pre/post comparison on same config — confirm score and grade moved in expected direction

See spec: [docs/superpowers/specs/2026-04-20-optimizer-cron-feedback-round-2-design.md](docs/superpowers/specs/2026-04-20-optimizer-cron-feedback-round-2-design.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review checklist

After finishing all tasks, verify:

**Spec coverage:**
- [x] §1 Horizon lock → Tasks 10, 12
- [x] §2 OT curve + baseline capture → Tasks 5, 8, 9
- [x] §3 CNC dwell exclusion → Task 6
- [x] §4 CNC hire cap + advisory → Tasks 7, 10, 16
- [x] §5 Grade bands → Task 4
- [x] §6 Buffer curve (business days) → Tasks 2, 3, 9
- [x] §7 Hiring constraints → Tasks 10, 11
- [x] §8 Store table sort → Task 14
- [x] §9 OT window clarity → Tasks 15, 17

**Placeholder scan:**
- No TBD / TODO / "implement later" left
- Every step has complete code or exact commands
- Exact file paths used throughout

**Type consistency:**
- `businessDaysEarly(dueDate, finishDate)` — same signature in Tasks 2 and 9
- `laborCostScore(overtimeHours)` — same in Tasks 5 and 9
- `shouldAdviseCncWeekendShift(teamUtilization, nsoViolations)` — same in Tasks 7 and usage
- `computeOvertimeHours(overrides, params, ptoMap, teamDefs, holidays, changes)` — same in Tasks 8 and 9
- `validateOptimizeRunProposal(body)` — same in Tasks 10, 11, and server.js wiring
