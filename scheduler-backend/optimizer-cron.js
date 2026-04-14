/**
 * optimizer-cron.js — LLM-guided overnight schedule optimization.
 *
 * Uses Claude Sonnet 4.6 via tool-use to propose each iteration's parameter set.
 * A fixed baseline runs first; Claude then proposes variations, sees the results,
 * and iterates. After all iterations, Claude writes a narrative summary for the
 * morning email.
 *
 * Env vars:
 *   SERVER_URL           — scheduler API base URL
 *   ANTHROPIC_API_KEY    — required
 *
 * Usage:
 *   node optimizer-cron.js [--iterations 25] [--dry-run] [--horizon 3]
 *
 * --dry-run: calls Claude for proposals but skips schedule runs (for validating
 *            the LLM path cheaply).
 */

const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

// --- Config ---
const SERVER_URL = process.env.SERVER_URL || 'https://production-scheduler-backend-aepw.onrender.com';
// Iteration count: CLI flag wins, then env var, then default.
// Using an env var lets Render dashboard overrides take effect immediately,
// without waiting for render.yaml redeploys.
const MAX_ITERATIONS = parseInt(argOf('--iterations', process.env.OPTIMIZER_ITERATIONS || '25'));
const DEFAULT_HORIZON_MONTHS = parseInt(argOf('--horizon', process.env.OPTIMIZER_HORIZON || '3'));
const DRY_RUN = process.argv.includes('--dry-run');
const MODEL = process.env.OPTIMIZER_MODEL || 'claude-sonnet-4-5';

// Start date offset: 0 = today (daily mode), 3 = today+3 days (deep mode, gives leads prep time).
const START_OFFSET_DAYS = parseInt(process.env.OPTIMIZER_START_OFFSET_DAYS || '0');

// Email recipients — comma-separated list via env var or CLI.
// Defaults to Danny only (no summary recipients) for safe test runs.
const RECIPIENTS_RAW = argOf('--recipients', process.env.OPTIMIZER_RECIPIENTS || 'danny.diaz@theescapegame.com');
const EMAIL_RECIPIENTS = {
    detailed: RECIPIENTS_RAW.split(',').map(e => e.trim()).filter(Boolean),
    summary: [],  // Summary recipients (e.g. Dan Oliver) added once output is validated
};

function argOf(flag, fallback) {
    const idx = process.argv.indexOf(flag);
    return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY environment variable is required.');
    process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- System prompt (loaded once from agent-context/) ---
const AGENT_CONTEXT_DIR = path.join(__dirname, 'agent-context');
function readContext(name) {
    return fs.readFileSync(path.join(AGENT_CONTEXT_DIR, name), 'utf8');
}
const SYSTEM_PROMPT = [
    readContext('system.md'),
    readContext('parameter-space.md'),
    readContext('scoring.md'),
    `# Operational Notes for This Run

You are running inside a headless cron job. Each iteration you will be shown the history so far and asked for a single proposal via the \`propose_next_run\` tool.

- Omit priorityWeights fields you don't want to change — they'll fall back to their defaults.
- \`horizonMonths\` controls how far into the future the engine simulates. We are starting at ${DEFAULT_HORIZON_MONTHS} months to get faster iterations and a cleaner signal from near-term stores. Only expand (4, 5, 6...) if scores plateau with clear headroom and you believe broader context would change the answer.
- Keep \`reasoning\` to 2-4 sentences: what you changed and why.
- If the last run was infeasible (NSO/Infill violations), prioritize fixing that — higher NSO multiplier, higher pastDueBase, or raise dueDateNumerator.`,
].join('\n\n---\n\n');

// --- Tool schema ---
const PROPOSE_TOOL = {
    name: 'propose_next_run',
    description: 'Propose the next scheduling engine configuration to test.',
    input_schema: {
        type: 'object',
        properties: {
            priorityWeights: {
                type: 'object',
                description: 'Priority weight overrides. Omit fields you do not want to change. Nested `projectTypeMultipliers` takes {NSO, INFILL, RENO, PC} numbers.',
                properties: {
                    projectTypeMultipliers: {
                        type: 'object',
                        properties: {
                            NSO: { type: 'number', minimum: 1.0, maximum: 3.0 },
                            INFILL: { type: 'number', minimum: 1.0, maximum: 2.5 },
                            RENO: { type: 'number', minimum: 1.0, maximum: 2.0 },
                            PC: { type: 'number', minimum: 0.5, maximum: 1.5 },
                        },
                    },
                    pastDueBase: { type: 'number', minimum: 50, maximum: 500 },
                    pastDueGrowthRate: { type: 'number', minimum: 1.01, maximum: 1.5 },
                    dueDateNumerator: { type: 'number', minimum: 20, maximum: 200 },
                    assemblyLeadBoost: { type: 'number', minimum: 1.0, maximum: 3.0 },
                    assemblyNonLeadHoldback: { type: 'number', minimum: 0.3, maximum: 1.0 },
                    inProgressBoost: { type: 'number', minimum: 1.0, maximum: 20.0 },
                    dwellThresholdDays: { type: 'integer', minimum: 1, maximum: 30 },
                    dwellCap: { type: 'number', minimum: 1.0, maximum: 10.0 },
                },
            },
            horizonMonths: {
                type: 'integer',
                description: 'Months of store due dates to include. Start at 3; only expand if scores plateau.',
                minimum: 3,
                maximum: 12,
            },
            reasoning: {
                type: 'string',
                description: 'Brief rationale (2-4 sentences) for this proposal.',
            },
        },
        required: ['priorityWeights', 'horizonMonths', 'reasoning'],
    },
};

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
    // Handle 503 "already in progress" — wait for the existing job to drain, then submit.
    // This keeps the cron resilient to collisions with UI-triggered runs, the scheduled-task
    // MCP, or leftover runs from earlier in the day.
    let attempts = 0;
    const MAX_BUSY_WAITS = 30; // up to ~30 × 5min = 2.5 hours of patience
    while (attempts < MAX_BUSY_WAITS) {
        const resp = await fetch(`${SERVER_URL}/api/optimize-run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (resp.ok) {
            const { jobId } = await resp.json();
            return pollJob(jobId);
        }

        if (resp.status === 503) {
            const payload = await resp.json().catch(() => ({}));
            if (payload.existingJobId) {
                console.log(`  Server busy (existing job ${payload.existingJobId.slice(0, 8)}...). Waiting for it to finish before retrying.`);
                try {
                    await waitForJobToFinish(payload.existingJobId);
                } catch (e) {
                    console.log(`  Existing job ended (${e.message}). Retrying submission.`);
                }
                attempts += 1;
                await sleep(5000); // brief settle time before retry
                continue;
            }
        }

        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    throw new Error(`Timed out waiting for server to free up after ${MAX_BUSY_WAITS} attempts.`);
}

// Poll a job to terminal state without caring about result shape — used when we're
// just waiting for someone else's job to drain so we can submit our own.
async function waitForJobToFinish(jobId) {
    for (let i = 0; i < 120; i++) {
        await sleep(10000);
        try {
            const resp = await fetch(`${SERVER_URL}/api/schedule/status/${jobId}`);
            if (resp.status === 404) return; // job expired — it's gone, safe to submit
            if (!resp.ok) continue;
            const job = await resp.json();
            if (job.status === 'complete' || job.status === 'error') return;
        } catch (e) {
            // transient polling error — keep trying
        }
    }
    throw new Error(`Gave up waiting for job ${jobId.slice(0, 8)}...`);
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

function runWithConfig(data, priorityWeights, horizonMonths, skipDbFilter = true, preparedTasks = null) {
    // CRITICAL: when preparedTasks is provided (from the baseline's DB-filtered result),
    // use those as the projectTasks input and keep skipDbFilter=true. Otherwise the engine
    // would re-simulate already-completed work on every iteration, breaking feasibility.
    return submitRun({
        projectTasks: preparedTasks || data.projectTasks,
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
        skipDbFilter,
        // Ask server to echo the DB-filtered tasks back once, so we can reuse them.
        returnPreparedTasks: !skipDbFilter,
        priorityWeights: priorityWeights || {},
        horizonMonths,
    });
}

// --- LLM calls ---

function buildHistoryMessage(history, bestScore, bestConfig, iteration) {
    const lines = [];
    lines.push(`## Run state`);
    lines.push(`Iteration ${iteration}/${MAX_ITERATIONS}.`);
    lines.push(``);
    if (bestScore) {
        lines.push(`### Best so far: ${bestScore.compositeScore}/100 (${bestScore.grade}) | feasible: ${bestScore.feasible} | storesInScope: ${bestScore.storesInScope || 'n/a'}`);
        const c = bestScore.categories || {};
        lines.push(`Buffer: ${c.buffer}/${c.bufferMax} | Efficiency: ${c.laborEfficiency}/${c.laborEfficiencyMax} | Cost: ${c.laborCost}/${c.laborCostMax} | Adherence: ${c.adherence}/${c.adherenceMax}`);
        if (bestScore.labor) {
            lines.push(`$${(bestScore.labor.efficiencyPerHour || 0).toFixed(1)}/hr | OT: ${bestScore.labor.overtimeHours || 0}h`);
        }
        if (bestScore.nsoViolations && bestScore.nsoViolations.length > 0) {
            lines.push(`NSO violations: ${bestScore.nsoViolations.length} (${bestScore.nsoViolations.slice(0, 3).map(v => `${v.store} ${v.latenessDays}d late`).join('; ')})`);
        }
        if (bestScore.teamHealth?.peaks?.length > 0) {
            const topPeak = bestScore.teamHealth.peaks[0];
            lines.push(`Top workload peak: ${topPeak.team} @ ${topPeak.workloadRatio}% in ${topPeak.week}`);
        }
    }
    if (bestConfig?.priorityWeights && Object.keys(bestConfig.priorityWeights).length > 0) {
        lines.push(``);
        lines.push(`Best priorityWeights: \`${JSON.stringify(bestConfig.priorityWeights)}\``);
    }
    lines.push(``);
    lines.push(`### History`);
    for (const h of history) {
        const status = h.feasible ? 'ok' : 'INFEASIBLE';
        lines.push(`- ${h.iteration}. ${h.score}/100 [${status}] h=${h.horizonMonths}mo | ${h.paramChanges}`);
        if (h.reasoning) lines.push(`  reasoning: ${h.reasoning}`);
    }
    lines.push(``);
    lines.push(`Call \`propose_next_run\` with your next iteration. Aim to beat ${bestScore?.compositeScore ?? 'baseline'}.`);
    return lines.join('\n');
}

async function proposeNextRun(history, bestScore, bestConfig, iteration) {
    const userMsg = buildHistoryMessage(history, bestScore, bestConfig, iteration);
    const maxAttempts = 2;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const resp = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 2000,
                system: SYSTEM_PROMPT,
                tools: [PROPOSE_TOOL],
                tool_choice: { type: 'tool', name: 'propose_next_run' },
                messages: [{ role: 'user', content: userMsg }],
            });
            const toolUse = resp.content.find(b => b.type === 'tool_use');
            if (!toolUse) throw new Error('Model did not call propose_next_run tool');
            return { proposal: toolUse.input, usage: resp.usage };
        } catch (e) {
            lastErr = e;
            console.log(`  LLM call attempt ${attempt} failed: ${e.message}`);
            if (attempt < maxAttempts) await sleep(2000 * attempt);
        }
    }
    throw lastErr;
}

async function generateNarrative(history, baseScore, bestScore, bestConfig, elapsedMin) {
    const userMsg = `Summarize this overnight optimization run in a concise markdown report for Danny (production manager).

**Baseline:** ${baseScore.compositeScore}/100 (${baseScore.grade}), feasible=${baseScore.feasible}
**Best:** ${bestScore.compositeScore}/100 (${bestScore.grade}), feasible=${bestScore.feasible}
**Delta:** ${(bestScore.compositeScore - baseScore.compositeScore).toFixed(1)} points
**Iterations:** ${history.length}
**Duration:** ${elapsedMin} min
**Horizon:** ${bestScore.horizonMonths ?? 'full year'} months

**Best priorityWeights:**
\`\`\`json
${JSON.stringify(bestConfig?.priorityWeights || {}, null, 2)}
\`\`\`

**History:**
${history.map(h => `- ${h.iteration}. ${h.score}/100 [${h.feasible ? 'ok' : 'INFEASIBLE'}] h=${h.horizonMonths}mo | ${h.paramChanges}${h.reasoning ? ` | ${h.reasoning}` : ''}`).join('\n')}

Write markdown covering:
1. **What moved** — category-level changes (buffer/efficiency/cost/adherence)
2. **Most impactful changes** — which parameter adjustments helped most
3. **Recommendations** — should we expand the horizon next run? focus on a specific team or parameter? try headcount or OT changes?

Keep it under 400 words. Be concrete and actionable.`;

    try {
        const resp = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 2000,
            system: 'You are summarizing results of an overnight schedule optimization run. Write concisely, professionally, and actionably.',
            messages: [{ role: 'user', content: userMsg }],
        });
        const textBlock = resp.content.find(b => b.type === 'text');
        return { text: textBlock?.text || '(No narrative text returned.)', usage: resp.usage };
    } catch (e) {
        console.log(`Narrative generation failed: ${e.message}`);
        return {
            text: `Optimization ran ${history.length} iterations in ${elapsedMin} min. Baseline ${baseScore.compositeScore} → Best ${bestScore.compositeScore}. (Narrative generation failed: ${e.message})`,
            usage: null,
        };
    }
}

// --- Helpers ---

function describeProposal(proposal) {
    const parts = [`h=${proposal.horizonMonths}mo`];
    const pw = proposal.priorityWeights || {};
    const flat = flattenWeights(pw);
    if (Object.keys(flat).length === 0) parts.push('(no weight changes)');
    else parts.push(Object.entries(flat).map(([k, v]) => `${k}=${v}`).join(', '));
    return parts.join(' | ');
}

function flattenWeights(obj, prefix = '') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            Object.assign(out, flattenWeights(v, prefix ? `${prefix}.${k}` : k));
        } else {
            out[prefix ? `${prefix}.${k}` : k] = v;
        }
    }
    return out;
}

function logScore(label, s) {
    if (!s) return;
    console.log(`  ${label}: ${s.compositeScore}/100 (${s.grade}) | Feasible: ${s.feasible} | Horizon: ${s.horizonMonths ?? 'full'}mo | InScope: ${s.storesInScope ?? 'n/a'}`);
    if (s.categories) {
        const c = s.categories;
        console.log(`  Buffer: ${c.buffer}/${c.bufferMax} | Eff: ${c.laborEfficiency}/${c.laborEfficiencyMax} | Cost: ${c.laborCost}/${c.laborCostMax} | Adh: ${c.adherence}/${c.adherenceMax}`);
    }
}

function addUsage(acc, usage) {
    if (!usage) return acc;
    acc.inputTokens += usage.input_tokens || 0;
    acc.outputTokens += usage.output_tokens || 0;
    acc.calls += 1;
    return acc;
}

function estimateCost(acc) {
    // Sonnet 4.5 pricing approx: $3/Mtok input, $15/Mtok output.
    const cost = (acc.inputTokens / 1e6) * 3 + (acc.outputTokens / 1e6) * 15;
    return cost;
}

// --- Main ---

async function main() {
    const startTime = Date.now();
    console.log(`=== TEG Schedule Optimizer (LLM-guided) ===`);
    console.log(`Model: ${MODEL}`);
    console.log(`Server: ${SERVER_URL}`);
    console.log(`Iterations: ${MAX_ITERATIONS} | Default horizon: ${DEFAULT_HORIZON_MONTHS}mo | Dry-run: ${DRY_RUN}`);
    console.log(`Email recipients: ${EMAIL_RECIPIENTS.detailed.join(', ') || '(none)'}`);
    console.log(`Time: ${new Date().toISOString()}\n`);

    const tokenAcc = { inputTokens: 0, outputTokens: 0, calls: 0 };

    // 1. Fetch data
    console.log('Fetching latest optimization data...');
    const data = await fetchJson(`${SERVER_URL}/api/optimization-data/latest`);
    console.log(`Loaded ${data.projectTasks.length} tasks`);

    // Start date: today + offset (0 for daily runs, 3+ for deep runs where leads need prep time).
    const startDate = new Date();
    startDate.setDate(startDate.getDate() + START_OFFSET_DAYS);
    const startDateStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
    data.params.startDate = startDateStr;
    console.log(`Start date: ${startDateStr}${START_OFFSET_DAYS > 0 ? ` (+${START_OFFSET_DAYS} days offset for lead prep)` : ' (today)'}\n`);

    // 2. Baseline: default weights, fixed horizon, run DB-filter once to get a
    // reusable task set for subsequent iterations.
    console.log(`=== BASELINE (default weights, horizon=${DEFAULT_HORIZON_MONTHS}mo) ===`);
    let baseResult;
    let preparedTasks = null;
    if (DRY_RUN) {
        console.log('  (dry-run: skipping baseline schedule run)');
        baseResult = { score: { compositeScore: 0, grade: 'N/A', feasible: true, categories: {}, horizonMonths: DEFAULT_HORIZON_MONTHS, storesInScope: 0 }, configUsed: { priorityWeights: {} } };
    } else {
        baseResult = await runWithConfig(data, {}, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ false);
        logScore('Baseline', baseResult.score);
        preparedTasks = baseResult.preparedTasks || null;
        if (preparedTasks) {
            console.log(`  Captured ${preparedTasks.length} DB-filtered tasks for reuse across iterations.`);
        } else {
            console.log(`  WARNING: server did not return preparedTasks. Subsequent runs may not match baseline.`);
        }
    }
    const baseScore = baseResult.score;

    let bestScore = baseScore;
    let bestConfig = baseResult.configUsed;
    const history = [{
        iteration: 0,
        score: baseScore.compositeScore,
        feasible: baseScore.feasible,
        horizonMonths: DEFAULT_HORIZON_MONTHS,
        paramChanges: 'baseline (defaults)',
        reasoning: 'fixed baseline',
    }];

    // 3. Iterate with LLM
    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        console.log(`\n=== ITER ${iter}/${MAX_ITERATIONS} ===`);

        let proposal;
        let proposalUsage;
        try {
            const r = await proposeNextRun(history, bestScore, bestConfig, iter);
            proposal = r.proposal;
            proposalUsage = r.usage;
            addUsage(tokenAcc, proposalUsage);
            console.log(`  LLM proposal: ${describeProposal(proposal)}`);
            console.log(`  Reasoning: ${proposal.reasoning}`);
        } catch (e) {
            console.log(`  LLM proposal failed (${e.message}). Falling back to current best weights unchanged.`);
            proposal = {
                priorityWeights: bestConfig?.priorityWeights || {},
                horizonMonths: DEFAULT_HORIZON_MONTHS,
                reasoning: `FALLBACK (LLM error: ${e.message.slice(0, 80)})`,
            };
        }

        if (DRY_RUN) {
            history.push({
                iteration: iter,
                score: 0,
                feasible: false,
                horizonMonths: proposal.horizonMonths,
                paramChanges: describeProposal(proposal),
                reasoning: proposal.reasoning,
            });
            continue;
        }

        try {
            // Pass the baseline's DB-filtered task set so every iteration sees the
            // same ground truth as the baseline did.
            const result = await runWithConfig(data, proposal.priorityWeights, proposal.horizonMonths, /* skipDbFilter */ true, preparedTasks);
            const s = result.score;
            logScore(`Iter ${iter}`, s);

            if (s.feasible && s.compositeScore > bestScore.compositeScore) {
                console.log(`  *** NEW BEST! ${bestScore.compositeScore} → ${s.compositeScore} ***`);
                bestScore = s;
                bestConfig = result.configUsed;
            }

            history.push({
                iteration: iter,
                score: s.compositeScore,
                feasible: s.feasible,
                horizonMonths: proposal.horizonMonths,
                paramChanges: describeProposal(proposal),
                reasoning: proposal.reasoning,
                priorityWeights: proposal.priorityWeights || {},
                // Keep the per-store breakdown so we can build a top-3 comparison
                // table in the email report at the end of the run.
                storeBreakdown: s.storeBreakdown || [],
                categories: s.categories || null,
            });
        } catch (e) {
            console.log(`  Run error: ${e.message}`);
            history.push({
                iteration: iter,
                score: 0,
                feasible: false,
                horizonMonths: proposal.horizonMonths,
                paramChanges: `ERROR: ${e.message.slice(0, 80)}`,
                reasoning: proposal.reasoning,
            });
        }
    }

    // 4. Narrative
    const elapsed = Math.round((Date.now() - startTime) / 60000);
    console.log(`\n=== Generating narrative ===`);
    const narrativeResult = DRY_RUN
        ? { text: '(dry-run — narrative skipped)', usage: null }
        : await generateNarrative(history, baseScore, bestScore, bestConfig, elapsed);
    addUsage(tokenAcc, narrativeResult.usage);

    console.log(`\n========================================`);
    console.log(`DONE — ${history.length} runs in ~${elapsed} min`);
    console.log(`Baseline: ${baseScore.compositeScore}/100 (${baseScore.grade})`);
    console.log(`Best:     ${bestScore.compositeScore}/100 (${bestScore.grade})`);
    console.log(`Delta:    ${bestScore.compositeScore > baseScore.compositeScore ? '+' : ''}${(bestScore.compositeScore - baseScore.compositeScore).toFixed(1)} pts`);
    console.log(`LLM calls: ${tokenAcc.calls} | Tokens: ${tokenAcc.inputTokens} in, ${tokenAcc.outputTokens} out | Est cost: $${estimateCost(tokenAcc).toFixed(3)}`);
    console.log(`========================================\n`);

    // 5. Email report
    if (DRY_RUN) {
        console.log('Dry-run: skipping email report.');
        return;
    }

    // Build the top-N feasible runs so the email can show a schedule comparison
    // across multiple strong candidates, not just the winner. These carry their
    // full storeBreakdown so the report can render Store | Due | Baseline | #1 | #2 | #3.
    const TOP_N = 3;
    const topRuns = history
        .filter(h => h.feasible && h.iteration > 0 && Array.isArray(h.storeBreakdown) && h.storeBreakdown.length > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_N)
        .map(h => ({
            iteration: h.iteration,
            score: h.score,
            horizonMonths: h.horizonMonths,
            paramChanges: h.paramChanges,
            priorityWeights: h.priorityWeights,
            storeBreakdown: h.storeBreakdown,
            categories: h.categories,
        }));

    // --- Build email attachments ---
    const attachments = [];

    // 1. Comparison CSV — one row per store per feasible run, for spreadsheet analysis.
    const feasibleRuns = history.filter(h => h.feasible && h.iteration > 0 && h.storeBreakdown?.length > 0);
    if (feasibleRuns.length > 0) {
        const csvRows = ['Run,Score,Horizon,Parameters,Store,Types,Due Date,Finish Date,Variance Days,Early Days,NSO Status'];
        for (const run of feasibleRuns) {
            for (const s of run.storeBreakdown) {
                csvRows.push([
                    run.iteration, run.score, run.horizonMonths,
                    `"${(run.paramChanges || '').replace(/"/g, '""')}"`,
                    `"${(s.store || '').replace(/"/g, '""')}"`,
                    `"${(s.projectTypes || []).join(', ')}"`,
                    s.dueDate || '', s.finishDate || '',
                    s.latenessDays || 0, s.daysEarly || 0,
                    s.nsoStatus || s.status || '',
                ].join(','));
            }
        }
        attachments.push({
            filename: `schedule-comparison-${startDateStr}.csv`,
            content: csvRows.join('\n'),
        });
        console.log(`  CSV attachment: ${feasibleRuns.length} feasible runs × ${feasibleRuns[0]?.storeBreakdown?.length || 0} stores`);
    }

    // 2. Config JSONs for top runs — the exact settings needed to reproduce each candidate.
    for (const run of topRuns.slice(0, 5)) {
        attachments.push({
            filename: `config-run-${run.iteration}-score-${run.score}.json`,
            content: JSON.stringify({
                iteration: run.iteration,
                score: run.score,
                horizonMonths: run.horizonMonths,
                priorityWeights: run.priorityWeights || {},
                categories: run.categories || {},
            }, null, 2),
        });
    }

    // 3. Task CSV — the DB-filtered task data with the adjusted start date, ready for
    //    upload into the scheduler UI to reproduce any of these runs.
    if (preparedTasks && preparedTasks.length > 0) {
        const taskHeaders = Object.keys(preparedTasks[0]);
        const taskCsvRows = [taskHeaders.join(',')];
        for (const task of preparedTasks) {
            taskCsvRows.push(taskHeaders.map(h => {
                const val = task[h];
                if (val == null) return '';
                const str = String(val);
                return str.includes(',') || str.includes('"') || str.includes('\n')
                    ? `"${str.replace(/"/g, '""')}"` : str;
            }).join(','));
        }
        attachments.push({
            filename: `tasks-${startDateStr}.csv`,
            content: taskCsvRows.join('\n'),
        });
        console.log(`  Task CSV attachment: ${preparedTasks.length} tasks`);
    }

    console.log(`Sending report email (${topRuns.length} top runs, ${attachments.length} attachments)...`);
    try {
        // Strip storeBreakdown from the full history to keep the email payload small —
        // topRuns already carries the breakdowns we care about.
        const compactHistory = history.map(({ storeBreakdown, ...rest }) => rest);
        const reportResp = await fetchJson(`${SERVER_URL}/api/send-optimization-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baselineScore: baseScore,
                bestScore,
                bestConfig,
                runHistory: compactHistory,
                topRuns,
                strategistNotes: narrativeResult.text,
                totalIterations: history.length,
                durationMinutes: elapsed,
                recipients: EMAIL_RECIPIENTS,
                attachments,
            }),
        });
        console.log('Report sent:', reportResp.message || 'OK');
    } catch (e) {
        console.error('Failed to send report:', e.message);
    }
}

main().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
