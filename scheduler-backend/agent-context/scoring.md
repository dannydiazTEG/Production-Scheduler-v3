# Scoring — How Results Are Evaluated

## Composite Score Formula

```
score = (totalLateness * 1000) + (overtimeHours * 1.0) + (utilizationStdDev * 10) + (dwellDays * 0.5)
```

**Lower is better.** A score of 0 means: zero days late anywhere, zero overtime, perfectly balanced teams, zero idle dwell time.

## Score Breakdown

### `totalLateness` (weight: 1000x)
- Sum of days late across ALL stores (not just NSO)
- Measured against **store-level production due dates** from the Dates CSV
- Each store's "finish date" is the latest operation completion date across all projects for that store
- A store that finishes 5 days late contributes 5 to totalLateness
- **This dominates the score** — reducing lateness by 1 day saves 1000 points

### `feasible` (hard gate)
- `true` if ALL NSO stores finish on or before their production due date
- `false` if ANY NSO store is late — the configuration should be discarded
- Non-NSO stores (INFILL, RENO, PC) can be late without breaking feasibility
- **Only feasible configurations should be considered as "best"**

### `nsoViolations` (detail for infeasible configs)
- Array of `{ store, dueDate, finishDate, latenessDays }` for each NSO store that missed its deadline
- Use this to understand which NSO stores are hardest to satisfy
- A config might fix 3 out of 4 NSO violations — that's progress even if infeasible

### `overtimeHours` (weight: 1.0x)
- Total hours where team worked > capacity in any given week
- Driven by `workHourOverrides` setting hours > standard
- 100 overtime hours adds 100 to the score
- **Only matters as a tiebreaker** when lateness is similar

### `utilizationStdDev` (weight: 10x)
- Standard deviation of average team utilization across all weeks
- Measures how evenly work is distributed across teams
- A StdDev of 0.15 (15 percentage points) adds 1.5 to the score
- **Indicates bottleneck imbalance** — if one team is at 95% while another is at 30%, the StdDev is high
- Useful signal for where to add headcount or shift work

### `dwellDays` (weight: 0.5x)
- Total calendar days items sat idle between consecutive operations
- Computed from gaps in the finalSchedule (operation N finishes on day X, operation N+1 starts on day Y, gap = Y - X - 1)
- 200 dwell days adds 100 to the score
- **Indicates coordination issues** — upstream teams finishing faster than downstream can absorb

## `storeBreakdown` Array

Each entry:
```json
{
    "store": "Denver",
    "matchedStore": "Denver",      // Matched name from Dates CSV
    "projectTypes": ["NSO"],
    "finishDate": "2026-07-15",
    "dueDate": "2026-07-10",
    "latenessDays": 5,
    "isNso": true,
    "status": "LATE"
}
```

Sorted by latenessDays descending — the worst stores are first. Use this to identify which stores to focus on.

## Interpreting Results

| Score Range | Meaning |
|-------------|---------|
| 0 | Perfect — all on-time, no OT, balanced, no dwell |
| 1-999 | Excellent — no lateness, minor secondary issues |
| 1000-5000 | Good but late — 1-5 total store-days of lateness |
| 5000-20000 | Significant lateness — 5-20 store-days late |
| 20000+ | Major issues — widespread lateness |
| Infinity | Engine error — check `engineError` field |

## Common Patterns

- **Score drops from 15000 to 5000 by adjusting one team's headcount** → that team was the bottleneck
- **Score barely changes despite big parameter swings** → those parameters don't affect the binding constraint
- **Feasibility flips from false to true** → you found the threshold for the hardest NSO store
- **overtimeHours increases but totalLateness drops** → OT is "buying" on-time delivery (intended tradeoff)
- **utilizationStdDev decreases but score increases** → you balanced teams but at the cost of throughput
