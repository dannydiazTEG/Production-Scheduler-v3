/**
 * optimizer-cron.js — Render cron job for overnight schedule optimization.
 *
 * Algorithmic approach: evolutionary parameter tuning.
 * Mutates 1-3 parameters at a time, keeps winners, evolves from the best.
 * No LLM calls needed — pure algorithmic optimization.
 *
 * Env vars required:
 *   SERVER_URL — base URL for the scheduler API (defaults to production)
 *
 * Usage:
 *   node optimizer-cron.js [--iterations 25] [--dry-run] [--top 5]
 */

const fetch = require('node-fetch');

const SERVER_URL = process.env.SERVER_URL || 'https://production-scheduler-backend-aepw.onrender.com';
const MAX_ITERATIONS = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--iterations') || '25');
const TOP_K = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--top') || '5');
const DRY_RUN = process.argv.includes('--dry-run');

// --- Parameter definitions with ranges ---

const PARAM_DEFS = [
    { key: 'projectTypeMultipliers.NSO', path: ['projectTypeMultipliers', 'NSO'], min: 1.0, max: 3.0, default: 1.5, step: 0.1 },
    { key: 'projectTypeMultipliers.INFILL', path: ['projectTypeMultipliers', 'INFILL'], min: 1.0, max: 2.5, default: 1.3, step: 0.1 },
    { key: 'projectTypeMultipliers.RENO', path: ['projectTypeMultipliers', 'RENO'], min: 1.0, max: 2.0, default: 1.15, step: 0.05 },
    { key: 'projectTypeMultipliers.PC', path: ['projectTypeMultipliers', 'PC'], min: 0.5, max: 1.5, default: 1.0, step: 0.1 },
    { key: 'pastDueBase', path: ['pastDueBase'], min: 50, max: 500, default: 100, step: 25 },
    { key: 'pastDueGrowthRate', path: ['pastDueGrowthRate'], min: 1.01, max: 1.5, default: 1.1, step: 0.05 },
    { key: 'dueDateNumerator', path: ['dueDateNumerator'], min: 20, max: 200, default: 60, step: 10 },
    { key: 'assemblyLeadBoost', path: ['assemblyLeadBoost'], min: 1.0, max: 3.0, default: 1.3, step: 0.1 },
    { key: 'assemblyNonLeadHoldback', path: ['assemblyNonLeadHoldback'], min: 0.3, max: 1.0, default: 0.75, step: 0.05 },
    { key: 'inProgressBoost', path: ['inProgressBoost'], min: 1.0, max: 20.0, default: 5.0, step: 1.0 },
    { key: 'dwellThresholdDays', path: ['dwellThresholdDays'], min: 1, max: 30, default: 7, step: 1 },
    { key: 'dwellCap', path: ['dwellCap'], min: 1.0, max: 10.0, default: 3.0, step: 0.5 },
];

// --- API helpers ---

async function fetchJson(url, options) {
    const resp = await fetch(url, options);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return resp.json();
}

async function submitRun(body) {
    const { jobId } = await fetchJson(`${SERVER_URL}/api/optimize-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return pollJob(jobId);
}

async function pollJob(jobId) {
    for (let i = 0; i < 60; i++) {
        await sleep(10000);
        try {
            const job = await fetchJson(`${SERVER_URL}/api/schedule/status/${jobId}`);
            if (job.status === 'complete') {
                if (!job.result) throw new Error('Job complete but result was null');
                return job.result;
            }
            if (job.status === 'error') throw new Error(job.error || 'Job failed');
            if (job.error === 'Job not found.') throw new Error('Job expired');
        } catch (e) {
            if (e.message.includes('expired') || e.message.includes('not found')) throw e;
            console.log(`  Poll retry: ${e.message}`);
        }
    }
    throw new Error('Timeout waiting for job');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- Mutation logic ---

function getWeightValue(weights, path) {
    let obj = weights;
    for (const key of path) {
        if (!obj || typeof obj !== 'object') return undefined;
        obj = obj[key];
    }
    return obj;
}

function setWeightValue(weights, path, value) {
    let obj = weights;
    for (let i = 0; i < path.length - 1; i++) {
        if (!obj[path[i]]) obj[path[i]] = {};
        obj = obj[path[i]];
    }
    obj[path[path.length - 1]] = value;
}

function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
}

function round(val, step) {
    return Math.round(val / step) * step;
}

/**
 * Create a mutated copy of the current best weights.
 * Mutates 1-3 parameters randomly.
 *
 * @param {Object} currentWeights - Current priority weights
 * @param {number} temperature - Mutation magnitude (0.1 = small, 1.0 = large)
 */
function mutate(currentWeights, temperature = 0.5) {
    const weights = JSON.parse(JSON.stringify(currentWeights));
    const numMutations = 1 + Math.floor(Math.random() * 3); // 1-3 mutations
    const changes = [];

    const shuffled = [...PARAM_DEFS].sort(() => Math.random() - 0.5);

    for (let i = 0; i < numMutations && i < shuffled.length; i++) {
        const param = shuffled[i];
        const current = getWeightValue(weights, param.path) ?? param.default;
        const range = param.max - param.min;

        // Gaussian-like mutation: centered on current value, scaled by temperature
        const delta = (Math.random() - 0.5) * 2 * range * temperature;
        const newVal = round(clamp(current + delta, param.min, param.max), param.step);

        setWeightValue(weights, param.path, newVal);
        changes.push(`${param.key}: ${current}→${newVal}`);
    }

    return { weights, changes };
}

/**
 * Phase 1: Systematic exploration. Test each parameter independently at
 * low and high values to measure individual impact.
 */
function generateExplorationRun(paramIndex) {
    const param = PARAM_DEFS[paramIndex % PARAM_DEFS.length];
    const isHigh = paramIndex >= PARAM_DEFS.length;

    const weights = {};
    const target = isHigh
        ? round(param.default + (param.max - param.default) * 0.6, param.step)
        : round(param.default - (param.default - param.min) * 0.6, param.step);

    setWeightValue(weights, param.path, clamp(target, param.min, param.max));

    return {
        weights,
        changes: [`${param.key}: ${param.default}→${target} (${isHigh ? 'high' : 'low'} explore)`],
    };
}

// --- Main ---

async function main() {
    const startTime = Date.now();
    console.log(`=== TEG Schedule Optimizer (Algorithmic) — ${MAX_ITERATIONS} iterations ===`);
    console.log(`Server: ${SERVER_URL}`);
    console.log(`Time: ${new Date().toISOString()}\n`);

    // 1. Fetch data
    console.log('Fetching latest optimization data...');
    const data = await fetchJson(`${SERVER_URL}/api/optimization-data/latest`);
    console.log(`Loaded ${data.projectTasks.length} tasks\n`);

    // 2. Baseline
    console.log('=== BASELINE ===');
    const baseResult = await submitRun({ ...data, skipDbFilter: false });
    const baseScore = baseResult.score;
    logScore('Baseline', baseScore);

    let bestScore = baseScore.compositeScore;
    let bestWeights = {};
    let bestConfig = baseResult.configUsed;
    let bestScoreObj = baseScore;
    const history = [{ iteration: 0, score: baseScore.compositeScore, feasible: baseScore.feasible, paramChanges: 'baseline' }];

    // Track parameter impact from exploration phase
    const paramImpact = {};

    // 3. Exploration phase: test each parameter individually (first N iterations)
    const explorationRuns = Math.min(MAX_ITERATIONS, PARAM_DEFS.length * 2);
    let iter = 0;

    for (iter = 1; iter <= explorationRuns; iter++) {
        const { weights, changes } = generateExplorationRun(iter - 1);
        const description = changes.join(', ');
        console.log(`\n=== ITER ${iter}/${MAX_ITERATIONS} (explore): ${description} ===`);

        if (DRY_RUN) {
            history.push({ iteration: iter, score: 0, feasible: false, paramChanges: description });
            continue;
        }

        try {
            const result = await runWithWeights(data, weights);
            const s = result.score;
            logScore(`Iter ${iter}`, s);

            // Track impact
            const paramKey = PARAM_DEFS[(iter - 1) % PARAM_DEFS.length].key;
            if (!paramImpact[paramKey]) paramImpact[paramKey] = [];
            paramImpact[paramKey].push({ weights, score: s.compositeScore, feasible: s.feasible });

            if (s.feasible && s.compositeScore > bestScore) {
                console.log(`  *** NEW BEST! ${bestScore} → ${s.compositeScore} ***`);
                bestScore = s.compositeScore;
                bestWeights = weights;
                bestConfig = result.configUsed;
                bestScoreObj = s;
            }

            history.push({ iteration: iter, score: s.compositeScore, feasible: s.feasible, paramChanges: description });
        } catch (e) {
            console.log(`  Error: ${e.message}`);
            history.push({ iteration: iter, score: 0, feasible: false, paramChanges: `ERROR: ${e.message.slice(0, 60)}` });
        }
    }

    // Rank parameters by impact
    console.log('\n=== PARAMETER IMPACT ===');
    const impacts = Object.entries(paramImpact)
        .map(([key, runs]) => {
            const bestRun = runs.filter(r => r.feasible).sort((a, b) => b.score - a.score)[0];
            return { key, bestDelta: bestRun ? bestRun.score - baseScore.compositeScore : -Infinity };
        })
        .sort((a, b) => b.bestDelta - a.bestDelta);

    impacts.forEach(({ key, bestDelta }) => {
        const sign = bestDelta >= 0 ? '+' : '';
        console.log(`  ${key}: ${sign}${bestDelta.toFixed(1)} pts`);
    });

    // 4. Exploitation phase: mutate from the best config
    const temperature = 0.3; // Focused mutations
    for (iter = explorationRuns + 1; iter <= MAX_ITERATIONS; iter++) {
        const { weights, changes } = mutate(bestWeights, temperature);
        const description = changes.join(', ');
        console.log(`\n=== ITER ${iter}/${MAX_ITERATIONS} (exploit): ${description} ===`);

        if (DRY_RUN) {
            history.push({ iteration: iter, score: 0, feasible: false, paramChanges: description });
            continue;
        }

        try {
            const result = await runWithWeights(data, weights);
            const s = result.score;
            logScore(`Iter ${iter}`, s);

            if (s.feasible && s.compositeScore > bestScore) {
                console.log(`  *** NEW BEST! ${bestScore} → ${s.compositeScore} ***`);
                bestScore = s.compositeScore;
                bestWeights = weights;
                bestConfig = result.configUsed;
                bestScoreObj = s;
            }

            history.push({ iteration: iter, score: s.compositeScore, feasible: s.feasible, paramChanges: description });
        } catch (e) {
            console.log(`  Error: ${e.message}`);
            history.push({ iteration: iter, score: 0, feasible: false, paramChanges: `ERROR: ${e.message.slice(0, 60)}` });
        }
    }

    // 5. Report
    const elapsed = Math.round((Date.now() - startTime) / 60000);
    console.log(`\n========================================`);
    console.log(`DONE — ${history.length} runs in ~${elapsed} min`);
    console.log(`Baseline: ${baseScore.compositeScore}/100 (${baseScore.grade})`);
    console.log(`Best:     ${bestScore}/100 (${bestScoreObj.grade})`);
    console.log(`Delta:    ${bestScore > baseScore.compositeScore ? '+' : ''}${(bestScore - baseScore.compositeScore).toFixed(1)} pts`);
    console.log(`========================================\n`);

    // Build strategist notes from algorithmic results
    const topImpacts = impacts.filter(i => i.bestDelta > 0).slice(0, 5);
    const strategistNotes = [
        `Algorithmic optimization ran ${history.length} iterations in ${elapsed} minutes.`,
        `Baseline: ${baseScore.compositeScore}/100 → Best: ${bestScore}/100 (${bestScore > baseScore.compositeScore ? '+' : ''}${(bestScore - baseScore.compositeScore).toFixed(1)} pts improvement).`,
        '',
        topImpacts.length > 0
            ? `Most impactful parameters: ${topImpacts.map(i => `${i.key} (+${i.bestDelta.toFixed(1)})`).join(', ')}.`
            : 'No individual parameter changes improved the score significantly.',
        '',
        `Best weights: ${JSON.stringify(bestWeights, null, 2)}`,
    ].join('\n');

    console.log('Sending report email...');
    try {
        const reportResp = await fetchJson(`${SERVER_URL}/api/send-optimization-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baselineScore: baseScore,
                bestScore: bestScoreObj,
                bestConfig,
                runHistory: history,
                strategistNotes,
                totalIterations: history.length,
                durationMinutes: elapsed,
            }),
        });
        console.log('Report sent:', reportResp.message || 'OK');
    } catch (e) {
        console.error('Failed to send report:', e.message);
    }
}

async function runWithWeights(data, priorityWeights) {
    return submitRun({
        projectTasks: data.projectTasks,
        params: data.params,
        teamDefs: data.teamDefs,
        ptoEntries: data.ptoEntries || [],
        teamMemberChanges: data.teamMemberChanges || [],
        workHourOverrides: data.workHourOverrides || [],
        hybridWorkers: data.hybridWorkers || [],
        efficiencyData: data.efficiencyData || {},
        teamMemberNameMap: data.teamMemberNameMap || {},
        startDateOverrides: data.startDateOverrides || {},
        endDateOverrides: data.endDateOverrides || {},
        storeDueDatesCsv: data.storeDueDatesCsv,
        skipDbFilter: true,
        priorityWeights,
    });
}

function logScore(label, s) {
    console.log(`  ${label}: ${s.compositeScore}/100 (${s.grade}) | Feasible: ${s.feasible}`);
    console.log(`  Buffer: ${s.categories.buffer}/${s.categories.bufferMax} | Eff: ${s.categories.laborEfficiency}/${s.categories.laborEfficiencyMax} | Cost: ${s.categories.laborCost}/${s.categories.laborCostMax} | Adh: ${s.categories.adherence}/${s.categories.adherenceMax}`);
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
