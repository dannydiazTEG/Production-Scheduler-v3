/**
 * scoring.js — Evaluates scheduling engine results against store-level due dates.
 *
 * Hard gate: All NSO stores must hit their production due dates.
 * Primary metric: Total lateness across all store types.
 * Secondary: Overtime hours, utilization evenness, dwell time.
 */

// --- Levenshtein distance for fuzzy store name matching ---
function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => {
        const row = new Array(n + 1);
        row[0] = i;
        return row;
    });
    for (let j = 1; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp[m][n];
}

function normalizeStoreName(name) {
    return (name || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Find the best matching store name from the dates map.
 * Exact normalized match first, then Levenshtein fallback (threshold <= 3).
 */
function matchStoreName(storeName, storeDueDates) {
    const norm = normalizeStoreName(storeName);
    // Exact match
    for (const [key, val] of storeDueDates.entries()) {
        if (normalizeStoreName(key) === norm) return { matched: key, dueDate: val };
    }
    // Fuzzy match
    let bestKey = null, bestDist = Infinity;
    for (const [key, val] of storeDueDates.entries()) {
        const dist = levenshtein(norm, normalizeStoreName(key));
        if (dist < bestDist) { bestDist = dist; bestKey = key; }
    }
    if (bestDist <= 3 && bestKey) {
        return { matched: bestKey, dueDate: storeDueDates.get(bestKey) };
    }
    return null;
}

// --- Calendar day diff ---
function calendarDays(dateA, dateB) {
    const a = new Date(dateA); a.setHours(0, 0, 0, 0);
    const b = new Date(dateB); b.setHours(0, 0, 0, 0);
    return Math.round((a - b) / (24 * 60 * 60 * 1000));
}

/**
 * Parse the Dates CSV text into a Map<storeName, productionDueDate>.
 * Expected columns: Project, Project Type, Production Due Date
 * "Project" in the Dates CSV maps to "Store" in the schedule.
 */
function parseDatesCsv(csvText) {
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) return new Map();

    const headers = lines[0].split(',').map(h => h.trim());
    const projectIdx = headers.findIndex(h => /^project$/i.test(h));
    const typeIdx = headers.findIndex(h => /project\s*type/i.test(h));
    const dueDateIdx = headers.findIndex(h => /production\s*due\s*date/i.test(h));

    if (projectIdx === -1 || dueDateIdx === -1) {
        throw new Error(`Dates CSV missing required columns. Found: ${headers.join(', ')}`);
    }

    const result = new Map(); // storeName -> { dueDate, projectType }
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim());
        const store = cols[projectIdx];
        const dueDate = cols[dueDateIdx];
        const projectType = typeIdx !== -1 ? cols[typeIdx] : '';
        if (store && dueDate) {
            result.set(store, { dueDate, projectType: (projectType || '').toUpperCase() });
        }
    }
    return result;
}

/**
 * Score a scheduling engine result.
 *
 * @param {Object} engineResult - Return value of runSchedulingEngine()
 * @param {Map<string, {dueDate: string, projectType: string}>} storeDueDates - From parseDatesCsv()
 * @param {number} standardHoursPerDay - Default 8
 * @returns {Object} Score breakdown
 */
function scoreResult(engineResult, storeDueDates, standardHoursPerDay = 8) {
    const { finalSchedule, projectSummary, teamUtilization, weeklyOutput } = engineResult;

    if (engineResult.error) {
        return {
            score: Infinity,
            feasible: false,
            totalLateness: Infinity,
            nsoViolations: [{ store: 'ENGINE_ERROR', reason: engineResult.error }],
            overtimeHours: 0,
            utilizationStdDev: 0,
            dwellDays: 0,
            storeBreakdown: [],
        };
    }

    // --- Build ProjectType lookup from finalSchedule ---
    const projectTypeMap = new Map(); // Project -> ProjectType
    for (const entry of finalSchedule) {
        if (entry.ProjectType && !projectTypeMap.has(entry.Project)) {
            projectTypeMap.set(entry.Project, entry.ProjectType.toUpperCase());
        }
    }

    // --- Build store -> { maxFinishDate, projectType } from projectSummary ---
    // projectSummary has { Project, Store, StartDate, FinishDate, DueDate }
    const storeFinishMap = new Map(); // storeName -> { maxFinishDate, projectTypes }
    for (const p of projectSummary) {
        const store = p.Store;
        const finishDate = p.FinishDate;
        const pType = projectTypeMap.get(p.Project) || '';

        if (!storeFinishMap.has(store)) {
            storeFinishMap.set(store, { maxFinishDate: finishDate, projectTypes: new Set() });
        } else {
            const existing = storeFinishMap.get(store);
            if (finishDate > existing.maxFinishDate) existing.maxFinishDate = finishDate;
        }
        if (pType) storeFinishMap.get(store).projectTypes.add(pType);
    }

    // --- Score each store ---
    const nsoViolations = [];
    const storeBreakdown = [];
    let totalLateness = 0;

    for (const [store, data] of storeFinishMap.entries()) {
        const match = matchStoreName(store, storeDueDates);
        if (!match) {
            // Store not in Dates CSV — skip scoring (can't evaluate)
            storeBreakdown.push({
                store,
                projectTypes: Array.from(data.projectTypes),
                finishDate: data.maxFinishDate,
                dueDate: null,
                latenessDays: 0,
                status: 'NO_DUE_DATE',
            });
            continue;
        }

        const dueDateEntry = match.dueDate; // { dueDate: 'YYYY-MM-DD', projectType: 'NSO' }
        const dueDate = typeof dueDateEntry === 'object' ? dueDateEntry.dueDate : dueDateEntry;
        const datesCsvType = (typeof dueDateEntry === 'object' ? dueDateEntry.projectType : '') || '';
        const isNso = data.projectTypes.has('NSO') || datesCsvType === 'NSO';

        const latenessDays = Math.max(0, calendarDays(data.maxFinishDate, dueDate));
        totalLateness += latenessDays;

        const status = latenessDays > 0 ? 'LATE' : 'ON_TIME';
        storeBreakdown.push({
            store,
            matchedStore: match.matched,
            projectTypes: Array.from(data.projectTypes),
            finishDate: data.maxFinishDate,
            dueDate,
            latenessDays,
            isNso,
            status,
        });

        if (isNso && latenessDays > 0) {
            nsoViolations.push({
                store,
                dueDate,
                finishDate: data.maxFinishDate,
                latenessDays,
            });
        }
    }

    const feasible = nsoViolations.length === 0;

    // --- Overtime hours ---
    // teamUtilization: [{ week, teams: [{ name, worked, capacity, utilization }] }]
    let overtimeHours = 0;
    for (const weekData of teamUtilization) {
        for (const team of weekData.teams) {
            const worked = parseFloat(team.worked) || 0;
            const capacity = parseFloat(team.capacity) || 0;
            if (worked > capacity && capacity > 0) {
                overtimeHours += worked - capacity;
            }
        }
    }

    // --- Utilization evenness (StdDev of team average utilizations) ---
    const teamUtilAverages = new Map(); // teamName -> { totalUtil, weekCount }
    for (const weekData of teamUtilization) {
        for (const team of weekData.teams) {
            if (team.name === 'Hybrid') continue; // Exclude hybrid pseudo-team
            const util = (team.utilization || 0) / 100; // Convert from % to 0-1
            if (!teamUtilAverages.has(team.name)) {
                teamUtilAverages.set(team.name, { totalUtil: 0, weekCount: 0 });
            }
            const avg = teamUtilAverages.get(team.name);
            avg.totalUtil += util;
            avg.weekCount += 1;
        }
    }
    const avgUtils = [];
    for (const [, data] of teamUtilAverages.entries()) {
        if (data.weekCount > 0) avgUtils.push(data.totalUtil / data.weekCount);
    }
    let utilizationStdDev = 0;
    if (avgUtils.length > 1) {
        const mean = avgUtils.reduce((s, v) => s + v, 0) / avgUtils.length;
        const variance = avgUtils.reduce((s, v) => s + (v - mean) ** 2, 0) / avgUtils.length;
        utilizationStdDev = Math.sqrt(variance);
    }

    // --- Dwell time (gaps between consecutive operations per SKU) ---
    // Group finalSchedule by Project+SKU, find completion date per operation
    const skuOps = new Map(); // "Project|SKU" -> [{ order, lastDate }]
    for (const entry of finalSchedule) {
        const key = `${entry.Project}|${entry.SKU}`;
        if (!skuOps.has(key)) skuOps.set(key, new Map());
        const ops = skuOps.get(key);
        const order = parseInt(entry.Order) || 0;
        const date = entry.Date;
        if (!ops.has(order) || date > ops.get(order)) {
            ops.set(order, date); // Last date this operation was worked on
        }
    }

    let totalDwellDays = 0;
    for (const [, ops] of skuOps.entries()) {
        const sorted = Array.from(ops.entries()).sort((a, b) => a[0] - b[0]);
        for (let i = 1; i < sorted.length; i++) {
            const prevFinish = sorted[i - 1][1]; // Last work date of previous op
            const nextStart = sorted[i][1]; // First work date of next op (approximation — using last date)
            // For a more precise gap, we'd need the first date of the next op
            // But since we track last date, the gap is conservative
            const gap = calendarDays(nextStart, prevFinish);
            if (gap > 1) { // More than 1 day gap between consecutive ops
                totalDwellDays += gap - 1; // Subtract the transition day
            }
        }
    }

    // --- Composite score (lower = better) ---
    const score = (totalLateness * 1000) + (overtimeHours * 1.0) + (utilizationStdDev * 10) + (totalDwellDays * 0.5);

    return {
        score: Number(score.toFixed(2)),
        feasible,
        totalLateness,
        nsoViolations,
        overtimeHours: Number(overtimeHours.toFixed(1)),
        utilizationStdDev: Number(utilizationStdDev.toFixed(4)),
        dwellDays: Number(totalDwellDays.toFixed(0)),
        storeBreakdown: storeBreakdown.sort((a, b) => (b.latenessDays || 0) - (a.latenessDays || 0)),
    };
}

/**
 * Extract a lightweight ProjectType map from finalSchedule.
 * Call this before trimming the result to preserve type info for reports.
 */
function extractProjectTypeMap(finalSchedule) {
    const map = {};
    for (const entry of finalSchedule) {
        if (entry.ProjectType && !map[entry.Project]) {
            map[entry.Project] = entry.ProjectType;
        }
    }
    return map;
}

/**
 * Trim heavy fields from engine result to save memory.
 * Keeps only what's needed for scoring comparisons and reports.
 */
function trimEngineResult(engineResult) {
    return {
        projectSummary: engineResult.projectSummary,
        teamUtilization: engineResult.teamUtilization,
        weeklyOutput: engineResult.weeklyOutput,
        recommendations: engineResult.recommendations,
        projectedCompletion: engineResult.projectedCompletion,
        logs: (engineResult.logs || []).slice(-50), // Keep last 50 log lines
        error: engineResult.error,
    };
}

module.exports = {
    scoreResult,
    parseDatesCsv,
    extractProjectTypeMap,
    trimEngineResult,
    matchStoreName,
    calendarDays,
};
