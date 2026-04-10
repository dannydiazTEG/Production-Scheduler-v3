# API Reference — Agent Tools

Base URL: Set via environment (e.g., `https://your-app.onrender.com`)

## GET /api/optimization-data/latest

Fetch the most recent uploaded optimization data, pre-parsed and ready to use.

**Response (200):**
```json
{
    "projectTasks": [...],          // Parsed task objects
    "params": { "startDate": "2026-04-10", "hoursPerDay": 8, ... },
    "teamDefs": { "headcounts": [...], "mapping": [...] },
    "ptoEntries": [],
    "teamMemberChanges": [],
    "workHourOverrides": [],
    "hybridWorkers": [],
    "efficiencyData": {},
    "teamMemberNameMap": {},
    "startDateOverrides": {},
    "endDateOverrides": {},
    "storeDueDatesCsv": "Project,Project Type,Production Due Date\nDenver,NSO,2026-07-10\n...",
    "uploadedAt": "2026-04-10T15:30:00Z"
}
```

## POST /api/optimize-run

Run a single schedule with the given configuration and score the result.

**Request body:**
```json
{
    "projectTasks": [...],
    "params": { "startDate": "2026-04-10", "hoursPerDay": 8, "productivityAssumption": 0.85, "globalBuffer": 6.5, "maxIdleDays": 5, "teamsToIgnore": "", "holidays": "" },
    "teamDefs": { "headcounts": [{"name": "Receiving", "count": 2}, ...], "mapping": [{"operation": "Kitting", "team": "Receiving"}, ...] },
    "ptoEntries": [],
    "teamMemberChanges": [],
    "workHourOverrides": [],
    "hybridWorkers": [],
    "efficiencyData": {},
    "teamMemberNameMap": {},
    "startDateOverrides": {},
    "endDateOverrides": {},
    "priorityWeights": { "pastDueBase": 150 },
    "storeDueDatesCsv": "...",
    "skipDbFilter": false
}
```

**Key fields:**
- `priorityWeights` — Override any of the default priority weights. Omitted fields use defaults. See parameter-space.md.
- `storeDueDatesCsv` — Raw CSV text with store due dates. **Required for scoring.** Pass through from the data endpoint unchanged.
- `skipDbFilter` — Set `true` after the first run to reuse prepared tasks and save ~30s. The first run should be `false` to filter completed operations from the database.

**Response (202):**
```json
{ "jobId": "abc-123-..." }
```

## GET /api/schedule/status/{jobId}

Poll for job completion. Call every 10-15 seconds.

**Response when running (200):**
```json
{
    "type": "optimize-run",
    "status": "running",
    "progress": 45,
    "message": "Running scheduling engine...",
    "step": "simulating"
}
```

**Response when complete (200):**
```json
{
    "type": "optimize-run",
    "status": "complete",
    "progress": 100,
    "message": "Score: 4250.5 | Feasible: true | Lateness: 4d",
    "step": "done",
    "result": {
        "score": {
            "score": 4250.5,
            "feasible": true,
            "totalLateness": 4,
            "nsoViolations": [],
            "overtimeHours": 120.5,
            "utilizationStdDev": 0.1234,
            "dwellDays": 180,
            "storeBreakdown": [
                { "store": "San Antonio", "finishDate": "2026-07-20", "dueDate": "2026-07-18", "latenessDays": 2, "isNso": false, "status": "LATE" },
                { "store": "Denver", "finishDate": "2026-07-10", "dueDate": "2026-07-10", "latenessDays": 0, "isNso": true, "status": "ON_TIME" }
            ]
        },
        "projectSummary": [...],
        "teamUtilization": [
            { "week": "2026-04-06", "teams": [{ "name": "Assembly", "worked": "120.0", "capacity": "120.0", "utilization": 100 }, ...] }
        ],
        "weeklyOutput": [{ "week": "2026-04-06", "totalValue": 5000, "totalHoursWorked": 350 }],
        "projectedCompletion": "2026-08-15",
        "projectTypeMap": { "Denver NSO": "NSO", "San Antonio INFILL": "INFILL" },
        "configUsed": {
            "params": {...},
            "priorityWeights": {...},
            "headcounts": [...],
            "workHourOverrides": [...],
            "teamMemberChanges": [...],
            "hybridWorkers": [...]
        },
        "logs": ["Last 30 log lines..."]
    }
}
```

**Response on error (200):**
```json
{
    "status": "error",
    "error": "Optimization run failed: ..."
}
```

## POST /api/send-optimization-report

Send the final optimization report via email.

**Request body:**
```json
{
    "baselineScore": { "score": 15000, "feasible": false, "totalLateness": 12, ... },
    "bestScore": { "score": 2500, "feasible": true, "totalLateness": 2, ... },
    "bestConfig": { "params": {...}, "priorityWeights": {...}, "headcounts": [...] },
    "runHistory": [
        { "iteration": 1, "score": 15000, "feasible": false, "paramChanges": "baseline" },
        { "iteration": 2, "score": 12000, "feasible": false, "paramChanges": "increased Assembly headcount to 5" }
    ],
    "strategistNotes": "The primary bottleneck was Assembly. Increasing headcount from 3 to 5 and adding 2h OT for CNC during June resolved all NSO deadlines...",
    "totalIterations": 65,
    "durationMinutes": 140
}
```

**Response (200):**
```json
{ "success": true, "message": "Report sent to 2 recipients." }
```

## Typical Agent Session Flow

```
1. GET  /api/optimization-data/latest          → Get base data
2. POST /api/optimize-run (baseline, skipDbFilter=false)  → Get baseline score  
3. GET  /api/schedule/status/{jobId}           → Poll until complete
4. POST /api/optimize-run (mutation 1, skipDbFilter=true) → Try first change
5. GET  /api/schedule/status/{jobId}           → Poll
   ... repeat 50-75 times ...
N. POST /api/send-optimization-report          → Send results email
```

## Error Handling

| HTTP Status | Meaning | Action |
|-------------|---------|--------|
| 202 | Job accepted | Poll status endpoint |
| 400 | Bad request (missing fields) | Fix request body |
| 404 | Job not found | Job expired (>5 min) or wrong ID |
| 503 | Server overloaded | Wait 30s and retry |
