/**
 * scoring.js — Evaluates scheduling engine results against store-level due dates.
 *
 * Scoring is 0-100 composite with weighted categories:
 *   - NSO/Infill Completion Buffer: 40% — optimal = 3-5 days early
 *   - Labor Efficiency: 30% — output value ÷ paid hours, $93/hr baseline
 *   - Labor Cost: 20% — minimize OT at $45.81/hr premium
 *   - Reno/PC Adherence: 10% — up to 14 days flex, sliding penalty
 *
 * NSO gate: Sliding tolerance based on distance from today (capped at 10 days).
 * Infill gate: Must also hit delivery dates (same tolerance logic).
 */

const MAX_NSO_TOLERANCE_DAYS = 10;
const OT_PREMIUM_PER_HOUR = 45.81;
const LABOR_EFFICIENCY_BASELINE = 139.52; // $/hr (TEG target output value per paid hour)

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

function matchStoreName(storeName, storeDueDates) {
    const norm = normalizeStoreName(storeName);
    for (const [key, val] of storeDueDates.entries()) {
        if (normalizeStoreName(key) === norm) return { matched: key, dueDate: val };
    }
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

// --- Date parsing (handles YYYY-MM-DD and M/D/YYYY) ---
function parseLocalDate(str) {
    if (!str) return new Date(NaN);
    const s = String(str).trim();
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]);
    const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (usMatch) return new Date(+usMatch[3], +usMatch[1] - 1, +usMatch[2]);
    return new Date(s);
}

function calendarDays(dateA, dateB) {
    const a = parseLocalDate(dateA);
    const b = parseLocalDate(dateB);
    return Math.round((a - b) / (24 * 60 * 60 * 1000));
}

// --- Horizon filter helper ---
/**
 * Build the set of normalized store names whose due date falls within the horizon window.
 *
 * @param {Map<string, {dueDate: string}>} storeDueDates - from parseDatesCsv()
 * @param {string|Date} startDate - simulation start (params.startDate). Falls back to today.
 * @param {number} horizonMonths - months from startDate; null/undefined returns null (no filter)
 * @returns {Set<string>|null} Set of normalized store names, or null when no filter is active.
 */
function getInHorizonStoreNames(storeDueDates, startDate, horizonMonths) {
    if (horizonMonths == null) return null;
    const base = startDate ? parseLocalDate(startDate) : new Date();
    base.setHours(0, 0, 0, 0);
    const cutoff = new Date(base.getTime());
    cutoff.setMonth(cutoff.getMonth() + Number(horizonMonths));

    const result = new Set();
    for (const [storeName, val] of storeDueDates.entries()) {
        const dueStr = typeof val === 'object' ? val.dueDate : val;
        const due = parseLocalDate(dueStr);
        if (!isNaN(due) && due <= cutoff) {
            result.add(normalizeStoreName(storeName));
        }
    }
    return result;
}

// --- NSO/Infill tolerance ---
function getNsoTolerance(dueDate, today) {
    const now = today ? new Date(today.getTime()) : new Date();
    now.setHours(0, 0, 0, 0);
    const due = parseLocalDate(dueDate);
    const monthsOut = Math.max(0, (due.getFullYear() - now.getFullYear()) * 12 + (due.getMonth() - now.getMonth()));

    let toleranceDays;
    if (monthsOut <= 1) toleranceDays = 0;
    else if (monthsOut <= 3) toleranceDays = 3;
    else if (monthsOut <= 6) toleranceDays = 5;
    else toleranceDays = Math.min(MAX_NSO_TOLERANCE_DAYS, 5 + Math.floor((monthsOut - 6) * 1.5));

    return { toleranceDays, monthsOut };
}

// --- Buffer score curve (for NSO/Infill) ---
// Optimal = 3-5 days early (100%). On due date = 60%. 1-2 early = 80%. 6-10 early = 85%. 10+ = diminishing.
// Late (beyond tolerance) = 0% (hard gate already filters these out).
function bufferScore(daysEarly) {
    if (daysEarly < 0) return 0;       // Late — shouldn't reach here if hard gate passed
    if (daysEarly === 0) return 60;     // On the due date
    if (daysEarly <= 2) return 60 + (daysEarly / 2) * 20;  // 1d=70, 2d=80
    if (daysEarly <= 5) return 80 + ((daysEarly - 2) / 3) * 20;  // 3d=87, 4d=93, 5d=100
    if (daysEarly <= 10) return 100 - ((daysEarly - 5) / 5) * 15;  // 6d=97, 10d=85
    // 10+ days early — diminishing
    return Math.max(60, 85 - (daysEarly - 10) * 1.5);
}

// --- Reno/PC adherence curve ---
// On time = 100%. 7 days late = 75%. 14 days late = 50%. Beyond 14 = steep drop.
function renoPcScore(latenessDays) {
    if (latenessDays <= 0) return 100;
    if (latenessDays <= 7) return 100 - (latenessDays / 7) * 25;  // 7d = 75%
    if (latenessDays <= 14) return 75 - ((latenessDays - 7) / 7) * 25;  // 14d = 50%
    return Math.max(0, 50 - (latenessDays - 14) * 5);  // steep drop after 14
}

// --- Parse Dates CSV ---
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

    const result = new Map();
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

// --- Compute QC-based value realization from finalSchedule ---
// Value is realized when a SKU's QC operation completes (not last operation).
// If a SKU has no QC operation, fall back to last operation completion.
function computeValueRealization(finalSchedule, priceMap) {
    // Find last date of QC operation per SKU, or last date of any operation
    const skuData = new Map(); // "Project|SKU" -> { qcDate, lastDate }
    for (const entry of finalSchedule) {
        const key = `${entry.Project}|${entry.SKU}`;
        if (!skuData.has(key)) {
            skuData.set(key, { qcDate: null, lastDate: entry.Date, sku: entry.SKU, project: entry.Project });
        }
        const data = skuData.get(key);
        if (entry.Date > data.lastDate) data.lastDate = entry.Date;
        if ((entry.Team || '').toUpperCase() === 'QC' || (entry.Operation || '').toUpperCase() === 'QC') {
            if (!data.qcDate || entry.Date > data.qcDate) data.qcDate = entry.Date;
        }
    }

    // Build weekly value realization
    let totalValue = 0;
    const weeklyValue = {};
    const skuValues = [];

    for (const [key, data] of skuData.entries()) {
        const completionDate = data.qcDate || data.lastDate;
        const price = priceMap.get(data.sku) || 0;
        totalValue += price;

        if (price > 0) {
            const weekStart = getWeekStart(parseLocalDate(completionDate));
            const weekKey = formatLocalDate(weekStart);
            weeklyValue[weekKey] = (weeklyValue[weekKey] || 0) + price;
        }

        skuValues.push({ key, sku: data.sku, project: data.project, price, completionDate });
    }

    return { totalValue, weeklyValue, skuValues };
}

function getWeekStart(date) {
    const d = new Date(date);
    const day = d.getDay();
    d.setDate(d.getDate() - day);
    return d;
}

function formatLocalDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Score a scheduling engine result.
 *
 * @param {Object} engineResult - Return value of runSchedulingEngine()
 * @param {Map<string, {dueDate: string, projectType: string}>} storeDueDates - From parseDatesCsv()
 * @param {Object} options
 * @param {number} options.standardHoursPerDay - Default 8
 * @param {Date} options.today - Override for testing
 * @param {Map<string, number>} options.priceMap - SKU -> price from raw_fulcrum_price_breaks
 * @returns {Object} Score breakdown (0-100 scale)
 */
function scoreResult(engineResult, storeDueDates, options = {}) {
    const {
        standardHoursPerDay = 8,
        today,
        priceMap = new Map(),
        inHorizonStores = null,  // Set<normalizedStoreName>|null — when set, scoring is restricted to these stores
        horizonMonths = null,
    } = options;

    const { finalSchedule, projectSummary, teamUtilization, weeklyOutput, teamWorkload } = engineResult;

    if (engineResult.error) {
        return {
            compositeScore: 0,
            grade: 'F',
            gradeSummary: `Engine error: ${engineResult.error}`,
            feasible: false,
            categories: { buffer: 0, laborEfficiency: 0, laborCost: 0, adherence: 0 },
            nsoViolations: [{ store: 'ENGINE_ERROR', reason: engineResult.error }],
            nsoWarnings: [],
            storeBreakdown: [],
            labor: {},
            teamHealth: { valleys: [], peaks: [] },
        };
    }

    // --- Build ProjectType lookup from finalSchedule ---
    const projectTypeMap = new Map();
    for (const entry of finalSchedule) {
        if (entry.ProjectType && !projectTypeMap.has(entry.Project)) {
            projectTypeMap.set(entry.Project, entry.ProjectType.toUpperCase());
        }
    }

    // --- Build store finish map ---
    const storeFinishMap = new Map();
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
    const nsoWarnings = [];
    const storeBreakdown = [];
    let nsoWithinTolerance = 0;

    // Separate stores by type for category scoring
    const nsoInfillStores = [];
    const renoPcStores = [];

    for (const [store, data] of storeFinishMap.entries()) {
        const match = matchStoreName(store, storeDueDates);
        if (!match) {
            storeBreakdown.push({
                store, projectTypes: Array.from(data.projectTypes),
                finishDate: data.maxFinishDate, dueDate: null, latenessDays: 0, status: 'NO_DUE_DATE',
            });
            continue;
        }
        // Horizon filter: skip stores outside the scoring window (if one is set)
        if (inHorizonStores && !inHorizonStores.has(normalizeStoreName(match.matched))) {
            continue;
        }

        const dueDateEntry = match.dueDate;
        const dueDate = typeof dueDateEntry === 'object' ? dueDateEntry.dueDate : dueDateEntry;
        const datesCsvType = (typeof dueDateEntry === 'object' ? dueDateEntry.projectType : '') || '';
        const isNso = data.projectTypes.has('NSO') || datesCsvType === 'NSO';
        const isInfill = data.projectTypes.has('INFILL') || datesCsvType === 'INFILL';
        const isHardGate = isNso || isInfill;

        const latenessDays = Math.max(0, calendarDays(data.maxFinishDate, dueDate));
        const daysEarly = Math.max(0, calendarDays(dueDate, data.maxFinishDate));

        // Tolerance for NSO/Infill
        let toleranceDays = 0, monthsOut = 0, nsoStatus = null;
        if (isHardGate) {
            const tol = getNsoTolerance(dueDate, today);
            toleranceDays = tol.toleranceDays;
            monthsOut = tol.monthsOut;

            if (latenessDays > 0 && latenessDays <= toleranceDays) {
                nsoStatus = 'WITHIN_TOLERANCE';
                nsoWithinTolerance++;
                nsoWarnings.push({ store, dueDate, finishDate: data.maxFinishDate, latenessDays, toleranceDays, monthsOut });
            } else if (latenessDays > toleranceDays && latenessDays > 0) {
                nsoStatus = 'EXCEEDS_TOLERANCE';
                nsoViolations.push({ store, dueDate, finishDate: data.maxFinishDate, latenessDays, toleranceDays, monthsOut });
            }

            // Buffer score for this store
            const effectiveDaysEarly = latenessDays > 0 ? -latenessDays : daysEarly;
            nsoInfillStores.push({ store, daysEarly: effectiveDaysEarly, bufferPts: bufferScore(effectiveDaysEarly) });
        } else {
            // Reno/PC
            renoPcStores.push({ store, latenessDays, adherencePts: renoPcScore(latenessDays) });
        }

        const status = latenessDays > 0 ? 'LATE' : 'ON_TIME';
        storeBreakdown.push({
            store, matchedStore: match.matched,
            projectTypes: Array.from(data.projectTypes),
            finishDate: data.maxFinishDate, dueDate,
            latenessDays, daysEarly: latenessDays > 0 ? 0 : daysEarly,
            isNso, isInfill, isHardGate,
            toleranceDays: isHardGate ? toleranceDays : undefined,
            monthsOut: isHardGate ? monthsOut : undefined,
            nsoStatus, status,
        });
    }

    const feasible = nsoViolations.length === 0;

    // =================================================================
    // CATEGORY 1: NSO/Infill Completion Buffer (40 points)
    // =================================================================
    let bufferPoints = 0;
    if (nsoInfillStores.length > 0) {
        const avgBuffer = nsoInfillStores.reduce((s, st) => s + st.bufferPts, 0) / nsoInfillStores.length;
        bufferPoints = (avgBuffer / 100) * 40; // Scale to 40-point category
    } else {
        bufferPoints = 40; // No NSO/Infill stores = full marks (nothing to miss)
    }

    // =================================================================
    // CATEGORY 2: Labor Efficiency (30 points)
    // Output Value ÷ Total Paid Hours. $93/hr = 20 out of 30. Higher = more.
    // =================================================================
    let laborEffPoints = 0;
    let laborEfficiency = 0;
    let totalOutputValue = 0;
    let totalPaidHours = 0;

    // Use QC-based value realization if price map available
    if (priceMap.size > 0) {
        const valueData = computeValueRealization(finalSchedule, priceMap);
        totalOutputValue = valueData.totalValue;
    } else {
        // Fall back to engine's weeklyOutput values
        totalOutputValue = (weeklyOutput || []).reduce((s, w) => s + (w.totalValue || 0), 0);
    }
    totalPaidHours = (weeklyOutput || []).reduce((s, w) => s + (w.totalHoursWorked || 0), 0);

    if (totalPaidHours > 0) {
        laborEfficiency = totalOutputValue / totalPaidHours;
        // $93/hr = 20/30 points. Linear scale, no ceiling but asymptotic above baseline.
        if (laborEfficiency >= LABOR_EFFICIENCY_BASELINE) {
            // Above baseline: 20 + up to 10 bonus points (asymptotic)
            const aboveRatio = (laborEfficiency - LABOR_EFFICIENCY_BASELINE) / LABOR_EFFICIENCY_BASELINE;
            laborEffPoints = 20 + Math.min(10, aboveRatio * 30);
        } else {
            // Below baseline: scale down proportionally from 20
            laborEffPoints = Math.max(0, (laborEfficiency / LABOR_EFFICIENCY_BASELINE) * 20);
        }
    }

    // =================================================================
    // CATEGORY 3: Labor Cost (20 points)
    // Minimize OT. Zero OT = full marks. OT premium = $45.81/hr.
    // =================================================================
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
    // Score: 0 OT = 20 points. More OT = fewer points.
    // Every 100 OT hours drops ~5 points.
    let laborCostPoints = Math.max(0, 20 - (overtimeHours / 100) * 5);

    // =================================================================
    // CATEGORY 4: Reno/PC Adherence (10 points)
    // =================================================================
    let adherencePoints = 0;
    if (renoPcStores.length > 0) {
        const avgAdherence = renoPcStores.reduce((s, st) => s + st.adherencePts, 0) / renoPcStores.length;
        adherencePoints = (avgAdherence / 100) * 10;
    } else {
        adherencePoints = 10; // No Reno/PC stores = full marks
    }

    // =================================================================
    // COMPOSITE SCORE (0-100)
    // =================================================================
    const compositeScore = Number((bufferPoints + laborEffPoints + laborCostPoints + adherencePoints).toFixed(1));

    // --- Team health analysis ---
    const teamHealth = analyzeTeamHealth(teamUtilization, teamWorkload);

    // --- On-time rate ---
    const scoredStores = storeBreakdown.filter(s => s.status !== 'NO_DUE_DATE');
    const onTimeStores = scoredStores.filter(s => s.status === 'ON_TIME');
    const onTimeRate = scoredStores.length > 0
        ? `${onTimeStores.length}/${scoredStores.length} (${Math.round(onTimeStores.length / scoredStores.length * 100)}%)`
        : 'N/A';

    // --- Total lateness (for backward compat and reporting) ---
    const totalLateness = storeBreakdown.reduce((s, st) => s + (st.latenessDays || 0), 0);

    // --- Grade ---
    const scoredStoreCount = storeBreakdown.filter(s => s.status !== 'NO_DUE_DATE').length;
    const result = {
        compositeScore,
        feasible,
        onTimeRate,
        totalLateness,
        horizonMonths,
        storesInScope: scoredStoreCount,

        categories: {
            buffer: Number(bufferPoints.toFixed(1)),
            bufferMax: 40,
            laborEfficiency: Number(laborEffPoints.toFixed(1)),
            laborEfficiencyMax: 30,
            laborCost: Number(laborCostPoints.toFixed(1)),
            laborCostMax: 20,
            adherence: Number(adherencePoints.toFixed(1)),
            adherenceMax: 10,
        },

        labor: {
            totalOutputValue: Number(totalOutputValue.toFixed(2)),
            totalPaidHours: Number(totalPaidHours.toFixed(1)),
            efficiencyPerHour: Number(laborEfficiency.toFixed(2)),
            efficiencyBaseline: LABOR_EFFICIENCY_BASELINE,
            overtimeHours: Number(overtimeHours.toFixed(1)),
            overtimeCost: Number(overtimeCost.toFixed(2)),
            otPremiumRate: OT_PREMIUM_PER_HOUR,
        },

        nsoViolations,
        nsoWarnings,
        nsoWithinTolerance,
        nsoToleranceNote: `NSO/Infill tolerance: sliding scale up to ${MAX_NSO_TOLERANCE_DAYS} days based on distance from today.`,

        storeBreakdown: storeBreakdown.sort((a, b) => (b.latenessDays || 0) - (a.latenessDays || 0)),
        teamHealth,
    };

    // --- Letter grade ---
    const gradeData = computeGrade(result);
    result.grade = gradeData.grade;
    result.gradeSummary = gradeData.summary;

    return result;
}

/**
 * Compute letter grade from composite score.
 */
function computeGrade(scoreData) {
    const { compositeScore, feasible, nsoViolations } = scoreData;

    if (!feasible) {
        if ((nsoViolations || []).length >= 3) return { grade: 'F', summary: `${nsoViolations.length} NSO/Infill stores exceed tolerance` };
        return { grade: 'D', summary: `${(nsoViolations || []).length} NSO/Infill store(s) exceed tolerance` };
    }

    if (compositeScore >= 90) return { grade: 'A+', summary: 'Excellent — strong buffer, high efficiency' };
    if (compositeScore >= 85) return { grade: 'A', summary: 'Great schedule with comfortable margins' };
    if (compositeScore >= 80) return { grade: 'A-', summary: 'Solid schedule, minor room for improvement' };
    if (compositeScore >= 75) return { grade: 'B+', summary: 'Good schedule, some stores tight on timing' };
    if (compositeScore >= 70) return { grade: 'B', summary: 'Acceptable with moderate lateness' };
    if (compositeScore >= 65) return { grade: 'B-', summary: 'Below target — review buffer and efficiency' };
    if (compositeScore >= 55) return { grade: 'C', summary: 'Needs work — significant gaps in delivery or efficiency' };
    return { grade: 'D', summary: 'Poor — major scheduling issues' };
}

/**
 * Analyze utilization valleys and workload peaks.
 */
function analyzeTeamHealth(teamUtilization, teamWorkload) {
    const EXCLUDED_TEAMS = new Set(['Receiving', 'QC', 'Hybrid']);
    const VALLEY_THRESHOLD = 40;
    const PEAK_THRESHOLD = 150;

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

    const peaks = [];
    for (const weekData of (teamWorkload || [])) {
        for (const team of weekData.teams) {
            if (EXCLUDED_TEAMS.has(team.name)) continue;
            if (team.workloadRatio > PEAK_THRESHOLD) {
                peaks.push({ week: weekData.week, team: team.name, workloadRatio: Math.round(team.workloadRatio) });
            }
        }
    }

    peaks.sort((a, b) => b.workloadRatio - a.workloadRatio);
    valleys.sort((a, b) => a.utilization - b.utilization);

    return { valleys, peaks };
}

// --- Utility exports ---

function extractProjectTypeMap(finalSchedule) {
    const map = {};
    for (const entry of finalSchedule) {
        if (entry.ProjectType && !map[entry.Project]) {
            map[entry.Project] = entry.ProjectType;
        }
    }
    return map;
}

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
    normalizeStoreName,
    parseLocalDate,
    getInHorizonStoreNames,
    calendarDays,
    getNsoTolerance,
    analyzeTeamHealth,
    computeGrade,
    bufferScore,
    renoPcScore,
    computeValueRealization,
    MAX_NSO_TOLERANCE_DAYS,
    OT_PREMIUM_PER_HOUR,
    LABOR_EFFICIENCY_BASELINE,
};
