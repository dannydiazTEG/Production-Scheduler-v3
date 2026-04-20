# Scoring — How Results Are Evaluated

## Composite Score (0-100, higher = better)

Four weighted categories, each scored independently and summed:

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

### Labor Efficiency — 30 points max
`Output Value ÷ Total Paid Hours`. Value is realized when QC completes each SKU, using prices from the database (`raw_fulcrum_price_breaks` table).

- $139.52/hr = 20 out of 30 points (baseline target)
- Every dollar above $139.52 earns proportionally more (asymptotic curve)
- Below $139.52 scales down proportionally
- Baseline measures at $109.67/hr = 25.4/30

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
