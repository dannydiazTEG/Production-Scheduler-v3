# Scoring — How Results Are Evaluated

## Composite Score (0-100, higher = better)

Four weighted categories, each scored independently and summed:

### NSO/Infill Completion Buffer — 40 points max
Each NSO/Infill store is scored individually, then averaged and scaled to 40 points.

**Buffer curve (days early → % of max):**
| Days Early | Score | Why |
|-----------|-------|-----|
| Late | 0% | Hard gate should catch this |
| 0 (on due date) | 60% | On time but no safety margin |
| 1 day | 70% | Minimal buffer |
| 2 days | 80% | Getting comfortable |
| 3 days | 87% | Sweet spot starts |
| 4 days | 93% | Near optimal |
| **5 days** | **100%** | **Optimal — peak score** |
| 6 days | 97% | Slightly pulling work forward |
| 8 days | 91% | Diminishing |
| 10 days | 85% | Pulling too much forward |
| 15 days | 78% | Unnecessarily early |

**This is the biggest lever.** Baseline scores 26.3/40 — moving stores from "on the due date" to "3-5 days early" is the fastest path to improvement.

### Labor Efficiency — 30 points max
`Output Value ÷ Total Paid Hours`. Value is realized when QC completes each SKU, using prices from the database (`raw_fulcrum_price_breaks` table).

- $139.52/hr = 20 out of 30 points (baseline target)
- Every dollar above $139.52 earns proportionally more (asymptotic curve)
- Below $139.52 scales down proportionally
- Baseline measures at $109.67/hr = 25.4/30

### Labor Cost — 20 points max
Minimize overtime hours. OT premium = $45.81/hr.

- 0 overtime hours = 20/20 (full marks)
- Every 100 OT hours drops ~5 points
- Baseline has 0 OT = 20/20

**Tradeoff:** Adding overtime can improve buffer scores (finishing earlier) but costs labor cost points. The optimizer should find the balance.

### Reno/PC Adherence — 10 points max
Non-critical project types can flex up to 14 days late with a sliding penalty.

| Days Late | Score |
|----------|-------|
| 0 (on time) | 100% |
| 7 days | 75% |
| 14 days | 50% |
| 21+ days | Steep drop toward 0% |

Baseline scores 9.7/10.

## Hard Gate: NSO/Infill Feasibility

NSO and Infill stores have a **sliding tolerance** based on distance from today:
| Due Date Distance | Tolerance |
|------------------|-----------|
| 0-1 months | 0 days |
| 2-3 months | 3 days |
| 4-6 months | 5 days |
| 7+ months | Up to 10 days (capped) |

A store that exceeds its tolerance makes the config `feasible: false`. Stores within tolerance are logged as `nsoWarnings` but don't block feasibility.

**Only feasible configurations should be considered as "best."**

## Letter Grades

| Score | Grade |
|-------|-------|
| 90+ | A+ |
| 85-89 | A |
| 80-84 | A- |
| 75-79 | B+ |
| 70-74 | B |
| 65-69 | B- |
| 55-64 | C |
| <55 (feasible) | D |
| Infeasible | D or F |

## Team Health (in response but not scored)

**Workload Peaks:** Teams over 150% capacity in a given week (excluding Receiving & QC). Indicates backlog building up. Example: Paint at 400% means 4x more work assigned than the team can handle that week.

**Utilization Valleys:** Teams below 40% utilization (excluding Receiving & QC). Indicates idle capacity — potential flex or cross-training opportunities.

## Response Shape

```json
{
    "compositeScore": 81.4,
    "grade": "A-",
    "gradeSummary": "Solid schedule, minor room for improvement",
    "feasible": true,
    "onTimeRate": "31/37 (84%)",
    "totalLateness": 24,
    "categories": {
        "buffer": 26.3, "bufferMax": 40,
        "laborEfficiency": 25.4, "laborEfficiencyMax": 30,
        "laborCost": 20, "laborCostMax": 20,
        "adherence": 9.7, "adherenceMax": 10
    },
    "labor": {
        "totalOutputValue": 12500.00,
        "totalPaidHours": 350.0,
        "efficiencyPerHour": 109.67,
        "efficiencyBaseline": 93,
        "overtimeHours": 0,
        "overtimeCost": 0,
        "otPremiumRate": 45.81
    },
    "nsoViolations": [],
    "nsoWarnings": [{"store": "Raleigh NC", "latenessDays": 1, "toleranceDays": 6}],
    "storeBreakdown": [...],
    "teamHealth": { "peaks": [...], "valleys": [...] }
}
```
