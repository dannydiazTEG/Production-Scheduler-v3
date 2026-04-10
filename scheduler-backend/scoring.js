/**
 * scoring.js — Evaluates scheduling engine results against store-level due dates.
 *
 * NSO gate: NSO stores get a sliding tolerance based on distance from today.
 *   - 0-1 months out: 0 days tolerance
 *   - 2-3 months out: 3 days
 *   - 4-6 months out: 5 days
 *   - 7+ months out: up to 10 days (capped)
 * Primary metric: Total lateness across all store types.
 * Secondary: Overtime hours, dwell time.
 */

const MAX_NSO_TOLERANCE_DAYS = 10;

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
// Handles mixed date formats (YYYY-MM-DD and M/D/YYYY) by parsing to local date parts.
function parseLocalDate(str) {
    if (!str) return new Date(NaN);
    const s = String(str).trim();
    // ISO format: YYYY-MM-DD — parse as local, not UTC
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    // M/D/YYYY format
    const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) return new Date(+usMatch[3], +usMatch[1] - 1, +usMatch[2]);
    // Fallback
    return new Date(s);
}

function calendarDays(dateA, dateB) {
    const a = parseLocalDate(dateA);
    const b = parseLocalDate(dateB);
    return Math.round((a - b) / (24 * 60 * 60 * 1000));
}

/**
 * Calculate NSO tolerance based on how far the due date is from today.
 * Further out = more tolerance, capped at MAX_NSO_TOLERANCE_DAYS.
 *
 * @param {string} dueDate - Due date string (YYYY-MM-DD or M/D/YYYY)
 * @param {Date} [today] - Override for testing
 * @returns {{ toleranceDays: number, monthsOut: number }}
 */
function getNsoTolerance(dueDate, today) {
    const now = today ? new Date(today.getTime()) : new Date();
    now.setHours(0, 0, 0, 0);
    const due = parseLocalDate(dueDate);

    const monthsOut = Math.max(0, (due.getFullYear() - now.getFullYear()) * 12 + (due.getMonth() - now.getMonth()));

    let toleranceDays;
    if (monthsOut <= 1) {
        toleranceDays = 0;
    } else if (monthsOut <= 3) {
        toleranceDays = 3;
    } else if (monthsOut <= 6) {
        toleranceDays = 5;
    } else {
        // 7+ months: scale up to cap. ~1.4 days per month beyond 6, capped at MAX.
        toleranceDays = Math.min(MAX_NSO_TOLERANCE_DAYS, 5 + Math.floor((monthsOut - 6) * 1.5));
    }

    return { toleranceDays, monthsOut };
}

/**
 * Compute a human-readable grade from a score result.
 * Returns a letter grade (A+ through F) and a one-line summary.
 */
function computeGrade(scoreData) {
    const { feasible, totalLateness, nsoViolations, overtimeHours, nsoWithinTolerance } = scoreData;

    // Hard fail: NSO violations beyond tolerance
    if (!feasible) {
        if (nsoViolations.length >= 3) return { grade: 'F', summary: `${nsoViolations.length} NSO stores exceed tolerance` };
        if (totalLateness > 20) return { grade: 'D', summary: `NSO violations + ${totalLateness} total days late` };
        return { grade: 'D+', summary: `${nsoViolations.length} NSO store(s) exceed tolerance` };
    }

    // Feasible — grade based on overall lateness
    if (totalLateness === 0) {
        if (overtimeHours === 0) return { grade: 'A+', summary: 'All stores on time, no overtime' };
        return { grade: 'A', summary: 'All stores on time' };
    }
    if (totalLateness <= 5) {
        const withinNote = (nsoWithinTolerance || 0) > 0 ? `, ${nsoWithinTolerance} NSO within tolerance` : '';
        return { grade: 'A-', summary: `${totalLateness}d total lateness${withinNote}` };
    }
    if (totalLateness <= 15) {
        return { grade: 'B+', summary: `${totalLateness}d total lateness across non-critical stores` };
    }
    if (totalLateness <= 30) {
        return { grade: 'B', summary: `${totalLateness}d total lateness` };
    }
    if (totalLateness <= 50) {
        return { grade: 'B-', summary: `${totalLateness}d total lateness — room for improvement` };
    }
    return { grade: 'C', summary: `${totalLateness}d total lateness — significant delays` };
}

/**
 * Extract utilization valleys and workload ratio peaks from engine results.
 * Excludes Receiving, QC, and Hybrid teams.
 *
 * @param {Array} teamUtilization - [{ week, teams: [{ name, worked, capacity, utilization }] }]
 * @param {Array} teamWorkload - [{ week, teams: [{ name, workloadRatio }] }]
 * @returns {{ valleys: Array, peaks: Array }}
 */
function analyzeTeamHealth(teamUtilization, teamWorkload) {
    const EXCLUDED_TEAMS = new Set(['Receiving', 'QC', 'Hybrid']);
    const VALLEY_THRESHOLD = 40;  // Utilization below 40% = valley
    const PEAK_THRESHOLD = 150;   // Workload ratio above 150% = overloaded

    // Find utilization valleys
    const valleys = [];
    for (const weekData of (teamUtilization || [])) {
        for (const team of weekData.teams) {
            if (EXCLUDED_TEAMS.has(team.name)) continue;
            const util = team.utilization || 0;
            if (util > 0 && util < VALLEY_THRESHOLD) {
                valleys.push({ week: weekData.week, team: team.name, utilization: util });
            }
        }
    }

    // Find workload ratio peaks
    const peaks = [];
    for (const weekData of (teamWorkload || [])) {
        for (const team of weekData.teams) {
            if (EXCLUDED_TEAMS.has(team.name)) continue;
            if (team.workloadRatio > PEAK_THRESHOLD) {
                peaks.push({ week: weekData.week, team: team.name, workloadRatio: Math.round(team.workloadRatio) });
            }
        }
    }

    // Sort peaks by severity (highest ratio first), valleys by lowest util
    peaks.sort((a, b) => b.workloadRatio - a.workloadRatio);
    valleys.sort((a, b) => a.utilization - b.utilization);

    return { valleys, peaks };
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
function scoreResult(engineResult, storeDueDates, standardHoursPerDay = 8, today) {
    const { finalSchedule, projectSummary, teamUtilization, weeklyOutput, teamWorkload } = engineResult;

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
    const nsoViolations = [];  // Stores that exceed tolerance
    const nsoWarnings = [];    // NSO stores late but within tolerance
    const storeBreakdown = [];
    let totalLateness = 0;
    let nsoWithinTolerance = 0;

    for (const [store, data] of storeFinishMap.entries()) {
        const match = matchStoreName(store, storeDueDates);
        if (!match) {
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

        const dueDateEntry = match.dueDate;
        const dueDate = typeof dueDateEntry === 'object' ? dueDateEntry.dueDate : dueDateEntry;
        const datesCsvType = (typeof dueDateEntry === 'object' ? dueDateEntry.projectType : '') || '';
        const isNso = data.projectTypes.has('NSO') || datesCsvType === 'NSO';

        const latenessDays = Math.max(0, calendarDays(data.maxFinishDate, dueDate));
        totalLateness += latenessDays;

        // NSO tolerance: sliding scale based on distance, capped at 10 days
        let toleranceDays = 0;
        let monthsOut = 0;
        let nsoStatus = null;
        if (isNso) {
            const tol = getNsoTolerance(dueDate, today);
            toleranceDays = tol.toleranceDays;
            monthsOut = tol.monthsOut;

            if (latenessDays > 0 && latenessDays <= toleranceDays) {
                nsoStatus = 'WITHIN_TOLERANCE';
                nsoWithinTolerance++;
                nsoWarnings.push({
                    store, dueDate, finishDate: data.maxFinishDate,
                    latenessDays, toleranceDays, monthsOut,
                });
            } else if (latenessDays > toleranceDays && latenessDays > 0) {
                nsoStatus = 'EXCEEDS_TOLERANCE';
                nsoViolations.push({
                    store, dueDate, finishDate: data.maxFinishDate,
                    latenessDays, toleranceDays, monthsOut,
                });
            }
        }

        const status = latenessDays > 0 ? 'LATE' : 'ON_TIME';
        storeBreakdown.push({
            store,
            matchedStore: match.matched,
            projectTypes: Array.from(data.projectTypes),
            finishDate: data.maxFinishDate,
            dueDate,
            latenessDays,
            isNso,
            toleranceDays: isNso ? toleranceDays : undefined,
            monthsOut: isNso ? monthsOut : undefined,
            nsoStatus,
            status,
        });
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
    // Used internally by optimizer. Not shown directly in reports.
    const score = (totalLateness * 1000) + (overtimeHours * 1.0) + (totalDwellDays * 0.5);

    // --- Team health analysis ---
    const teamHealth = analyzeTeamHealth(teamUtilization, teamWorkload);

    // --- Build result ---
    const result = {
        score: Number(score.toFixed(2)),
        feasible,
        totalLateness,
        nsoViolations,
        nsoWarnings,
        nsoWithinTolerance,
        nsoToleranceNote: `NSO tolerance: sliding scale up to ${MAX_NSO_TOLERANCE_DAYS} days based on distance from today. Stores further out get more tolerance.`,
        overtimeHours: Number(overtimeHours.toFixed(1)),
        dwellDays: Number(totalDwellDays.toFixed(0)),
        storeBreakdown: storeBreakdown.sort((a, b) => (b.latenessDays || 0) - (a.latenessDays || 0)),
        teamHealth,
    };

    // --- Human-readable grade ---
    const gradeData = computeGrade(result);
    result.grade = gradeData.grade;
    result.gradeSummary = gradeData.summary;

    // --- Report-friendly metrics ---
    const totalStores = storeBreakdown.filter(s => s.status !== 'NO_DUE_DATE').length;
    const onTimeStores = storeBreakdown.filter(s => s.status === 'ON_TIME').length;
    result.onTimeRate = totalStores > 0 ? `${onTimeStores}/${totalStores} (${Math.round(onTimeStores / totalStores * 100)}%)` : 'N/A';

    return result;
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
        teamWorkload: engineResult.teamWorkload,
        weeklyOutput: engineResult.weeklyOutput,
        recommendations: engineResult.recommendations,
        projectedCompletion: engineResult.projectedCompletion,
        logs: (engineResult.logs || []).slice(-50),
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
    getNsoTolerance,
    analyzeTeamHealth,
    computeGrade,
    MAX_NSO_TOLERANCE_DAYS,
};
