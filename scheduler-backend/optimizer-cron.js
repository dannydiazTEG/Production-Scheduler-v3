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
const MAX_ITERATIONS = parseInt(argOf('--iterations', '25'));
const DEFAULT_HORIZON_MONTHS = parseInt(argOf('--horizon', '3'));
const DRY_RUN = process.argv.includes('--dry-run');
const MODEL = process.env.OPTIMIZER_MODEL || 'claude-sonnet-4-5';

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

function runWithConfig(data, priorityWeights, horizonMonths, skipDbFilter = true) {
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
        skipDbFilter,
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
    console.log(`Time: ${new Date().toISOString()}\n`);

    const tokenAcc = { inputTokens: 0, outputTokens: 0, calls: 0 };

    // 1. Fetch data
    console.log('Fetching latest optimization data...');
    const data = await fetchJson(`${SERVER_URL}/api/optimization-data/latest`);
    console.log(`Loaded ${data.projectTasks.length} tasks\n`);

    // 2. Baseline: default weights, fixed horizon
    console.log(`=== BASELINE (default weights, horizon=${DEFAULT_HORIZON_MONTHS}mo) ===`);
    let baseResult;
    if (DRY_RUN) {
        console.log('  (dry-run: skipping baseline schedule run)');
        baseResult = { score: { compositeScore: 0, grade: 'N/A', feasible: true, categories: {}, horizonMonths: DEFAULT_HORIZON_MONTHS, storesInScope: 0 }, configUsed: { priorityWeights: {} } };
    } else {
        baseResult = await runWithConfig(data, {}, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ false);
        logScore('Baseline', baseResult.score);
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
            const result = await runWithConfig(data, proposal.priorityWeights, proposal.horizonMonths);
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

    console.log('Sending report email...');
    try {
        const reportResp = await fetchJson(`${SERVER_URL}/api/send-optimization-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baselineScore: baseScore,
                bestScore,
                bestConfig,
                runHistory: history,
                strategistNotes: narrativeResult.text,
                totalIterations: history.length,
                durationMinutes: elapsed,
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
