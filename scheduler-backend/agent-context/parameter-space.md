# Parameter Space — What You Can Tune

## 1. Priority Weights (`priorityWeights`)

These control how the engine prioritizes tasks. Pass as `priorityWeights` in the request body. Any field omitted uses the default.

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `projectTypeMultipliers.NSO` | 1.5 | 1.0-3.0 | Higher = NSO tasks scheduled earlier. Critical for meeting NSO deadlines. |
| `projectTypeMultipliers.INFILL` | 1.3 | 1.0-2.5 | INFILL priority relative to other types |
| `projectTypeMultipliers.RENO` | 1.15 | 1.0-2.0 | RENO priority |
| `projectTypeMultipliers.PC` | 1.0 | 0.5-1.5 | PC (Production Continuation) — lowest priority |
| `pastDueBase` | 100 | 50-500 | Base multiplier when a task is past due. Higher = more aggressive catch-up |
| `pastDueGrowthRate` | 1.1 | 1.01-1.5 | Exponential growth per day past due. 1.1 = 10% increase per day |
| `dueDateNumerator` | 60 | 20-200 | Urgency curve for on-time tasks: `1 + (N / (daysUntilDue + 1))`. Higher = more aggressive pre-due-date scheduling |
| `assemblyLeadBoost` | 1.3 | 1.0-3.0 | Priority boost for the lead SKU's pre-assembly operations |
| `assemblyNonLeadHoldback` | 0.75 | 0.3-1.0 | Priority reduction for non-lead SKUs (saves assembly capacity) |
| `inProgressBoost` | 5.0 | 1.0-20.0 | Multiplier for tasks that are currently running/paused in Fulcrum |
| `pastDueLinearThreshold` | 30 | 10-60 | Days past due before exponential growth switches to linear |
| `dwellThresholdDays` | 7 | 1-30 | Days of idle time before dwell boost kicks in |
| `dwellCap` | 3.0 | 1.0-10.0 | Maximum dwell time multiplier |

**Assembly tiers** (advanced — change with caution):
```json
"assemblyImpactTiers": [
    { "threshold": 15, "multiplier": 3 },   // >=15h assembly = 3x priority
    { "threshold": 8, "multiplier": 2 },    // >=8h assembly = 2x
    { "threshold": 0, "multiplier": 1 }     // <8h = no boost
]
```

## 2. Team Headcounts (`teamDefs.headcounts`)

Array of `{ name, count }` objects. `count` can be fractional (e.g., 2.5 means 2 full-time + 1 half-time).

**Current defaults** (from typical config):
| Team | Default Count | Reasonable Range |
|------|--------------|------------------|
| Receiving | 2 | 1-4 |
| CNC | 3 | 1-5 |
| Metal | 2 | 1-4 |
| Scenic | 3 | 1-5 |
| Paint | 2 | 1-4 |
| Carpentry | 4 | 2-6 |
| Assembly | 3 | 2-6 |
| Tech | 2 | 1-4 |
| QC | 1 | 1-3 |

**Impact:** More headcount = faster throughput but higher cost. Reducing bottleneck team headcount below load causes lateness. Adding headcount to a non-bottleneck team has no effect.

## 3. Work Hour Overrides / Overtime (`workHourOverrides`)

Array of `{ team, hours, startDate, endDate }`. Default is 8 hours/day. Set hours > 8 for overtime.

Example: `{ "team": "Assembly", "hours": 10, "startDate": "2026-05-01", "endDate": "2026-06-30" }`

**Impact:** Targeted overtime for bottleneck teams during crunch periods can dramatically reduce lateness. But it increases the overtimeHours metric in scoring.

## 4. Schedule Parameters (`params`)

| Parameter | Default | Range | Effect |
|-----------|---------|-------|--------|
| `productivityAssumption` | 0.85 | 0.60-0.95 | Fraction of hours actually productive. Lower = more conservative (safer) |
| `globalBuffer` | 6.5 (%) | 0-20 | Buffer percentage added to all task estimates |
| `maxIdleDays` | 5 | 1-30 | Maximum days a task can sit idle before dwell priority boost. Lower = more aggressive reshuffling |
| `hoursPerDay` | 8 | 6-10 | Standard work hours per day |

## 5. Team Member Changes (`teamMemberChanges`)

Array of `{ name, team, date, type }` where type is "Starts" or "Leaves".

Use to model future hires: `{ "name": "NewHire1", "team": "Assembly", "date": "2026-05-15", "type": "Starts" }`

**Impact:** Adding a future hire to a bottleneck team can reduce lateness at the cost of delayed effect (only helps after the start date).

## 6. Hybrid Workers (`hybridWorkers`)

Array of `{ name, primaryTeam, secondaryTeam }`. These workers split time between teams.

**Impact:** Can help balance utilization between overloaded and underloaded teams.

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

## Tuning Strategy

1. **Start with priority weights** — they're the cheapest to change and have immediate effect
2. **Then headcounts** — find the true bottleneck team(s) by looking at utilization data
3. **Then overtime** — targeted OT for the bottleneck team(s) during critical periods
4. **Then params** — productivityAssumption and globalBuffer trade safety margin vs throughput
5. **Horizon expansion** — only once you're converging near a ceiling at 3mo
6. **Last: teamMemberChanges and hybridWorkers** — model staffing scenarios
