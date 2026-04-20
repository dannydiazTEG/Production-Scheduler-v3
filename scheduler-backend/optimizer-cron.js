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
const DEFAULT_HORIZON_MONTHS = parseInt(argOf('--horizon', process.env.OPTIMIZER_HORIZON || '6'));
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
- The scoring horizon is fixed at 6 months. You do not propose this — it is locked at the API level. Focus your proposals on tunable parameters (priorityWeights, flex, OT, hires, scheduleParams).
- Keep \`reasoning\` to 2-4 sentences: what you changed and why.
- If the last run was infeasible (NSO/Infill violations), prioritize fixing that — higher NSO multiplier, higher pastDueBase, or raise dueDateNumerator.

## Escalation: Capacity Levers

Priority weights alone cannot fix physical capacity shortages. Use this escalation ladder:

## Escalation Ladder

**Phase 1 — Priority weights (iterations 1-8):** Tune projectTypeMultipliers, dueDateNumerator, pastDue settings, assembly boost, dwell. This is free — no staffing or cost impact.

**Phase 2 — Flex workers (iteration 8+):** Move existing team members between teams. Immediate effect, zero hiring cost. Only use proven flex routes:
- Paint ↔ Scenic (bidirectional, common)
- Carpentry ↔ Assembly (bidirectional, common)
- Tech → Metal (one-way, rare/isolated)
- CNC, Receiving, QC: NO flex (too specialized)
- Max 20% of the source team's headcount can flex out (rounded down)
- Only flex FROM a team with utilization headroom TO a team that's overloaded

**Phase 3 — OT adjustments (iteration 10+):** Modify or remove existing overtime windows, or add new ones.
- Check existing OT windows first — can you shorten/remove any? Removing OT is a WIN worth surfacing.
- Max 9-10 hour days
- Max 1-2 months per continuous window
- 1 month cooldown required between OT windows for the same team (no back-to-back burnout)
- No overlapping windows for the same team

**Phase 4 — Headcount additions (iteration 15+):** Simulate hiring. Last resort.
- Max +3 people above current count per team
- New hires cannot start until 4 weeks after the schedule start date (hiring timeline)
- Use teamMemberChanges with a future start date, not instant headcount bumps

**Phase 5 — Schedule params:** globalBuffer (3-15%, prefer 5%+), maxIdleDays (1-30). DO NOT touch productivityAssumption — it is a fixed business decision (0.85 for schedules, 0.81 for external reporting). Adjust one param at a time.

Always explain which phase you're in and why in your reasoning. If you find a schedule that works WITHOUT overtime, call that out explicitly — that's a major win.`,
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
            flexWorkers: {
                type: 'array',
                description: 'Move existing team members between teams (Phase 2). Immediate effect, no hiring cost. ONLY allowed routes: Paint↔Scenic, Carpentry↔Assembly, Tech→Metal. Max 20% of source team can flex out. Each entry reduces fromTeam by 1 and adds a hybrid worker.',
                items: {
                    type: 'object',
                    properties: {
                        fromTeam: { type: 'string', description: 'Source team losing a member.' },
                        toTeam: { type: 'string', description: 'Destination team gaining flex capacity.' },
                    },
                    required: ['fromTeam', 'toTeam'],
                },
            },
            overtimeChanges: {
                type: 'array',
                description: 'Modify, add, or remove OT windows (Phase 3). You will see existing OT windows in the run history context. Actions: "add" a new window, "remove" an existing one by team+dates, or "modify" to change hours/dates. Max 9-10hr, max 1-2 months continuous, 1 month cooldown between windows for same team. Removing OT is a WIN.',
                items: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['add', 'remove', 'modify'], description: '"add" new window, "remove" existing, "modify" existing.' },
                        team: { type: 'string', description: 'Team name (exact match).' },
                        hours: { type: 'number', minimum: 8, maximum: 10, description: 'Hours per day. 8 = remove OT (normal hours). 9-10 = overtime.' },
                        startDate: { type: 'string', description: 'Start date (YYYY-MM-DD).' },
                        endDate: { type: 'string', description: 'End date (YYYY-MM-DD). Max ~2 months from startDate.' },
                    },
                    required: ['action', 'team'],
                },
            },
            newHires: {
                type: 'array',
                description: 'Simulate hiring (Phase 4, last resort). New person joins a team on a future date. Cannot start until 4 weeks after schedule start date. Max +3 people above current count per team.',
                items: {
                    type: 'object',
                    properties: {
                        team: { type: 'string', description: 'Team to add headcount to.' },
                        count: { type: 'number', minimum: 0.5, maximum: 3, description: 'How many to add (can be fractional).' },
                        startDate: { type: 'string', description: 'Earliest start date (YYYY-MM-DD). Must be ≥4 weeks after schedule start.' },
                    },
                    required: ['team', 'count', 'startDate'],
                },
            },
            taskDateOverrides: {
                type: 'array',
                description: 'Override task-level DueDate for all tasks belonging to a specific store. Use when a store has stale/incorrect task dates creating false urgency (e.g., tasks say 2/11 but real production due is 4/9). Changes ENGINE urgency calculations only — does NOT change store due dates used for SCORING. Use to test de-prioritizing past-due stores or pushing stores forward.',
                items: {
                    type: 'object',
                    properties: {
                        store: { type: 'string', description: 'Store name (matched case-insensitive against task.Store).' },
                        dueDate: { type: 'string', description: 'New DueDate for all tasks in this store (YYYY-MM-DD).' },
                    },
                    required: ['store', 'dueDate'],
                },
            },
            scheduleParams: {
                type: 'object',
                description: 'Override schedule-level parameters (Phase 5). Only change one at a time. DO NOT change productivityAssumption — it is a fixed business decision (0.85 for schedules, 0.81 for stakeholder reporting).',
                properties: {
                    globalBuffer: { type: 'number', minimum: 3, maximum: 15, description: 'Buffer percentage added to all task estimates. Default 6.5%, prefer 5%+. Floor is 3%.' },
                    maxIdleDays: { type: 'integer', minimum: 1, maximum: 30, description: 'Max days idle before dwell boost.' },
                },
            },
            reasoning: {
                type: 'string',
                description: 'Brief rationale (2-4 sentences) for this proposal.',
            },
        },
        required: ['priorityWeights', 'reasoning'],
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

// Adaptive poll interval. Runs that hit the result cache return in <1s,
// typical engine runs in 1-5s. Polling every 10s (old behaviour) wasted
// up to 10s per iteration of pure idle time.
const FAST_POLL_MS = 1000;
const STEADY_POLL_MS = 2000;
const FAST_POLL_ATTEMPTS = 10;
// 10 × 1s + 295 × 2s = 600s upper bound — matches server timeout.
const MAX_POLL_ATTEMPTS = 305;
function pollDelayMs(attempt) {
    return attempt < FAST_POLL_ATTEMPTS ? FAST_POLL_MS : STEADY_POLL_MS;
}

// Poll a job to terminal state without caring about result shape — used when we're
// just waiting for someone else's job to drain so we can submit our own.
async function waitForJobToFinish(jobId) {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await sleep(pollDelayMs(i));
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

// --- Capacity change validation ---
// Enforces real-world constraints so the LLM can't propose impossible staffing.

const FLEX_ROUTES = [
    { from: 'Paint', to: 'Scenic' },
    { from: 'Scenic', to: 'Paint' },
    { from: 'Carpentry', to: 'Assembly' },
    { from: 'Assembly', to: 'Carpentry' },
    { from: 'Tech', to: 'Metal' },  // one-way, isolated
];
const FLEX_ROUTE_SET = new Set(FLEX_ROUTES.map(r => `${r.from}→${r.to}`));
const NO_FLEX_TEAMS = new Set(['CNC', 'Receiving', 'QC']);
const FLEX_CAP_PCT = 0.20;
const HIRE_DELAY_DAYS = 28;
const MAX_HIRES_PER_TEAM = 3;
const MAX_OT_WINDOW_DAYS = 62;  // ~2 months
const OT_COOLDOWN_DAYS = 30;

function validateAndCleanProposal(proposal, baseHeadcounts, existingOTWindows, scheduleStartDate) {
    const warnings = [];

    // --- Flex workers ---
    if (proposal.flexWorkers?.length > 0) {
        const hcMap = new Map(baseHeadcounts.map(h => [h.name, h.count]));
        const flexCount = new Map(); // track how many we've flexed from each team

        proposal.flexWorkers = proposal.flexWorkers.filter(fw => {
            const routeKey = `${fw.fromTeam}→${fw.toTeam}`;
            if (!FLEX_ROUTE_SET.has(routeKey)) {
                warnings.push(`Blocked flex ${routeKey} — not an allowed route.`);
                return false;
            }
            const currentHC = hcMap.get(fw.fromTeam) || 0;
            const alreadyFlexed = flexCount.get(fw.fromTeam) || 0;
            const maxFlex = Math.floor(currentHC * FLEX_CAP_PCT);
            if (alreadyFlexed >= maxFlex) {
                warnings.push(`Blocked flex from ${fw.fromTeam} — already at 20% cap (${alreadyFlexed}/${maxFlex}).`);
                return false;
            }
            flexCount.set(fw.fromTeam, alreadyFlexed + 1);
            return true;
        });
    }

    // --- New hires ---
    if (proposal.newHires?.length > 0) {
        const earliest = new Date(scheduleStartDate);
        earliest.setDate(earliest.getDate() + HIRE_DELAY_DAYS);
        const earliestStr = earliest.toISOString().slice(0, 10);

        proposal.newHires = proposal.newHires.filter(hire => {
            if (hire.count > MAX_HIRES_PER_TEAM) {
                hire.count = MAX_HIRES_PER_TEAM;
                warnings.push(`Capped ${hire.team} hire to +${MAX_HIRES_PER_TEAM}.`);
            }
            if (hire.startDate < earliestStr) {
                warnings.push(`Pushed ${hire.team} hire start from ${hire.startDate} to ${earliestStr} (4-week min).`);
                hire.startDate = earliestStr;
            }
            return true;
        });
    }

    // --- Overtime changes ---
    if (proposal.overtimeChanges?.length > 0) {
        proposal.overtimeChanges = proposal.overtimeChanges.filter(ot => {
            if (ot.action === 'remove') return true; // always allow removal

            // Check window duration
            if (ot.startDate && ot.endDate) {
                const start = new Date(ot.startDate);
                const end = new Date(ot.endDate);
                const durationDays = Math.round((end - start) / (24 * 60 * 60 * 1000));
                if (durationDays > MAX_OT_WINDOW_DAYS) {
                    const capped = new Date(start);
                    capped.setDate(capped.getDate() + MAX_OT_WINDOW_DAYS);
                    ot.endDate = capped.toISOString().slice(0, 10);
                    warnings.push(`Capped ${ot.team} OT window to ${MAX_OT_WINDOW_DAYS} days (was ${durationDays}d).`);
                }
            }

            // Check cooldown against existing windows for same team
            if (ot.action === 'add' && ot.startDate) {
                const teamWindows = existingOTWindows.filter(w => w.team === ot.team);
                for (const existing of teamWindows) {
                    const existEnd = new Date(existing.endDate);
                    const newStart = new Date(ot.startDate);
                    const gapDays = Math.round((newStart - existEnd) / (24 * 60 * 60 * 1000));
                    if (gapDays >= 0 && gapDays < OT_COOLDOWN_DAYS) {
                        warnings.push(`Blocked ${ot.team} OT starting ${ot.startDate} — only ${gapDays}d after existing window ends ${existing.endDate} (need ${OT_COOLDOWN_DAYS}d cooldown).`);
                        return false;
                    }
                    // Check overlap
                    const existStart = new Date(existing.startDate);
                    const newEnd = new Date(ot.endDate || ot.startDate);
                    if (newStart <= existEnd && newEnd >= existStart) {
                        warnings.push(`Blocked overlapping ${ot.team} OT window (${ot.startDate}–${ot.endDate}) with existing (${existing.startDate}–${existing.endDate}).`);
                        return false;
                    }
                }
            }
            return true;
        });
    }

    // --- Schedule params ---
    if (proposal.scheduleParams) {
        // productivityAssumption is a fixed business decision — never allow changes
        if (proposal.scheduleParams.productivityAssumption != null) {
            warnings.push(`Blocked productivityAssumption change (${proposal.scheduleParams.productivityAssumption}) — fixed at uploaded value.`);
            delete proposal.scheduleParams.productivityAssumption;
        }
        // globalBuffer: floor at 3%, prefer 5%+
        if (proposal.scheduleParams.globalBuffer != null && proposal.scheduleParams.globalBuffer < 3) {
            warnings.push(`Clamped globalBuffer from ${proposal.scheduleParams.globalBuffer}% to 3% (floor).`);
            proposal.scheduleParams.globalBuffer = 3;
        }
    }

    if (warnings.length > 0) {
        console.log(`  Validation: ${warnings.join(' | ')}`);
    }
    return proposal;
}

async function pollJob(jobId) {
    for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
        await sleep(pollDelayMs(i));
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

function runWithConfig(data, proposal, horizonMonths, skipDbFilter = true, preparedTasks = null) {
    // CRITICAL: when preparedTasks is provided (from the baseline's DB-filtered result),
    // use those as the projectTasks input and keep skipDbFilter=true. Otherwise the engine
    // would re-simulate already-completed work on every iteration, breaking feasibility.

    // Start from the uploaded config, then layer on LLM-proposed changes.
    const params = { ...data.params };
    const teamDefs = JSON.parse(JSON.stringify(data.teamDefs)); // deep copy
    let workHourOverrides = [...(data.workHourOverrides || [])];
    let hybridWorkers = [...(data.hybridWorkers || [])];
    let teamMemberChanges = [...(data.teamMemberChanges || [])];

    // --- Phase 5: Schedule param overrides ---
    if (proposal.scheduleParams) {
        for (const [k, v] of Object.entries(proposal.scheduleParams)) {
            if (v != null) params[k] = v;
        }
    }

    // --- Phase 2: Flex workers ---
    // Each flex entry: reduce fromTeam by 1, add a hybrid worker primary=fromTeam secondary=toTeam
    if (proposal.flexWorkers?.length > 0) {
        const hcMap = new Map((teamDefs.headcounts || []).map(h => [h.name, h]));
        for (let i = 0; i < proposal.flexWorkers.length; i++) {
            const fw = proposal.flexWorkers[i];
            // Reduce source team headcount by 1
            if (hcMap.has(fw.fromTeam)) {
                hcMap.get(fw.fromTeam).count = Math.max(0.5, hcMap.get(fw.fromTeam).count - 1);
            }
            // Add hybrid worker
            hybridWorkers.push({
                name: `Flex-${fw.fromTeam}-${fw.toTeam}-${i + 1}`,
                primaryTeam: fw.fromTeam,
                secondaryTeam: fw.toTeam,
            });
        }
        teamDefs.headcounts = Array.from(hcMap.values());
    }

    // --- Phase 3: Overtime changes (add/remove/modify) ---
    if (proposal.overtimeChanges?.length > 0) {
        for (const ot of proposal.overtimeChanges) {
            if (ot.action === 'remove') {
                // Remove windows matching team (and optionally dates)
                workHourOverrides = workHourOverrides.filter(w => {
                    if (w.team !== ot.team) return true;
                    if (ot.startDate && w.startDate !== ot.startDate) return true;
                    return false; // match — remove it
                });
            } else if (ot.action === 'modify') {
                // Find and update the first matching window for this team
                const idx = workHourOverrides.findIndex(w =>
                    w.team === ot.team && (!ot.startDate || w.startDate === ot.startDate)
                );
                if (idx !== -1) {
                    if (ot.hours != null) workHourOverrides[idx].hours = String(ot.hours);
                    if (ot.endDate) workHourOverrides[idx].endDate = ot.endDate;
                    if (ot.startDate && !workHourOverrides[idx].startDate) workHourOverrides[idx].startDate = ot.startDate;
                }
            } else if (ot.action === 'add') {
                workHourOverrides.push({
                    id: Date.now() + Math.random(),
                    team: ot.team,
                    hours: String(ot.hours),
                    startDate: ot.startDate,
                    endDate: ot.endDate,
                });
            }
        }
    }

    // --- Phase 4: New hires (simulated as team member changes with future start date) ---
    if (proposal.newHires?.length > 0) {
        for (let i = 0; i < proposal.newHires.length; i++) {
            const hire = proposal.newHires[i];
            for (let j = 0; j < Math.ceil(hire.count); j++) {
                teamMemberChanges.push({
                    name: `NewHire-${hire.team}-${i + 1}-${j + 1}`,
                    team: hire.team,
                    date: hire.startDate,
                    type: 'Starts',
                });
            }
        }
    }

    // --- Task date overrides ---
    // Apply store-level DueDate overrides to individual task rows. This changes what
    // the engine sees for urgency (pastDue, dueDateNumerator) without touching the
    // store due dates CSV that scoring uses. Lets the LLM test "what if Fulton's tasks
    // had a 4/9 deadline instead of 2/11" to see if de-prioritizing an already-past-due
    // store unblocks others.
    let tasks = preparedTasks || data.projectTasks;
    if (proposal.taskDateOverrides?.length > 0) {
        // Deep copy tasks so we don't mutate the shared preparedTasks array
        tasks = tasks.map(t => ({ ...t }));
        for (const override of proposal.taskDateOverrides) {
            const storeLower = (override.store || '').toLowerCase().trim();
            let count = 0;
            for (const t of tasks) {
                if ((t.Store || '').toLowerCase().trim() === storeLower) {
                    t.DueDate = override.dueDate;
                    count++;
                }
            }
            if (count > 0) {
                console.log(`  Task date override: ${override.store} → ${override.dueDate} (${count} tasks)`);
            }
        }
    }

    return submitRun({
        projectTasks: tasks,
        params,
        teamDefs,
        ptoEntries: data.ptoEntries || [],
        teamMemberChanges,
        workHourOverrides,
        hybridWorkers,
        efficiencyData: data.efficiencyData || {},
        teamMemberNameMap: data.teamMemberNameMap || {},
        startDateOverrides: data.startDateOverrides || {},
        endDateOverrides: data.endDateOverrides || {},
        storeDueDatesCsv: data.storeDueDatesCsv,
        skipDbFilter,
        returnPreparedTasks: !skipDbFilter,
        priorityWeights: proposal.priorityWeights || {},
        horizonMonths,
    });
}

// --- LLM calls ---

function buildHistoryMessage(history, bestScore, bestConfig, iteration, currentOTWindows, currentHeadcounts) {
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
            lines.push(`Top workload peaks: ${bestScore.teamHealth.peaks.slice(0, 3).map(p => `${p.team} @ ${p.workloadRatio}% (${p.week})`).join(', ')}`);
        }
    }
    if (bestConfig?.priorityWeights && Object.keys(bestConfig.priorityWeights).length > 0) {
        lines.push(``);
        lines.push(`Best priorityWeights: \`${JSON.stringify(bestConfig.priorityWeights)}\``);
    }

    // Show current team headcounts so the LLM knows what it's working with
    if (currentHeadcounts?.length > 0) {
        lines.push(``);
        lines.push(`### Current headcounts`);
        lines.push(currentHeadcounts.map(h => `${h.name}: ${h.count}`).join(' | '));
    }

    // Show existing OT windows so the LLM can modify/remove them intelligently
    if (currentOTWindows?.length > 0) {
        lines.push(``);
        lines.push(`### Existing OT windows (from uploaded config)`);
        for (const w of currentOTWindows) {
            lines.push(`- ${w.team}: ${w.hours}h/day (${w.startDate} → ${w.endDate})`);
        }
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

async function proposeNextRun(history, bestScore, bestConfig, iteration, currentOTWindows, currentHeadcounts) {
    const userMsg = buildHistoryMessage(history, bestScore, bestConfig, iteration, currentOTWindows, currentHeadcounts);
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
    const parts = [`h=${DEFAULT_HORIZON_MONTHS}mo`];
    const pw = proposal.priorityWeights || {};
    const flat = flattenWeights(pw);
    if (Object.keys(flat).length > 0) parts.push(Object.entries(flat).map(([k, v]) => `${k}=${v}`).join(', '));
    if (proposal.flexWorkers?.length > 0) {
        parts.push('Flex: ' + proposal.flexWorkers.map(f => `${f.fromTeam}→${f.toTeam}`).join(', '));
    }
    if (proposal.overtimeChanges?.length > 0) {
        parts.push('OT: ' + proposal.overtimeChanges.map(o => {
            if (o.action === 'remove') return `remove ${o.team}`;
            if (o.action === 'modify') return `mod ${o.team} ${o.hours || ''}h`;
            return `add ${o.team} ${o.hours}h`;
        }).join(', '));
    }
    if (proposal.newHires?.length > 0) {
        parts.push('Hire: ' + proposal.newHires.map(h => `+${h.count} ${h.team} @${h.startDate}`).join(', '));
    }
    if (proposal.taskDateOverrides?.length > 0) {
        parts.push('Dates: ' + proposal.taskDateOverrides.map(d => `${d.store}→${d.dueDate}`).join(', '));
    }
    if (proposal.scheduleParams) {
        const sp = Object.entries(proposal.scheduleParams).filter(([, v]) => v != null);
        if (sp.length > 0) parts.push(sp.map(([k, v]) => `${k}=${v}`).join(', '));
    }
    if (parts.length === 1) parts.push('(no changes)');
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

    // 1.5 Clear the completed-ops cache so every iteration sees a single
    // consistent DB snapshot. Run results are left intact — if last night's run
    // already produced the same (tasks + weights), we skip that iteration outright.
    try {
        const refreshResp = await fetch(`${SERVER_URL}/api/cache/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'completed_ops' }),
        });
        if (refreshResp.ok) {
            const r = await refreshResp.json();
            console.log(`Cache pre-warm: cleared ${r.invalidated ?? 0} completed-ops rows, gc'd ${r.gcRemoved ?? 0} expired.\n`);
        } else {
            console.log(`Cache pre-warm skipped (HTTP ${refreshResp.status}).\n`);
        }
    } catch (e) {
        console.log(`Cache pre-warm skipped: ${e.message}\n`);
    }

    // 2. Baseline: default weights, fixed horizon, run DB-filter once to get a
    // reusable task set for subsequent iterations.
    console.log(`=== BASELINE (default weights, horizon=${DEFAULT_HORIZON_MONTHS}mo) ===`);
    let baseResult;
    let preparedTasks = null;
    if (DRY_RUN) {
        console.log('  (dry-run: skipping baseline schedule run)');
        baseResult = { score: { compositeScore: 0, grade: 'N/A', feasible: true, categories: {}, horizonMonths: DEFAULT_HORIZON_MONTHS, storesInScope: 0 }, configUsed: { priorityWeights: {} } };
    } else {
        baseResult = await runWithConfig(data, { priorityWeights: {} }, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ false);
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

    // Rolling counters — surfaced in final summary.
    const iterStats = { llmMs: 0, runMs: 0, cacheHits: 0 };

    // 3. Iterate with LLM
    for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
        const iterStart = Date.now();
        console.log(`\n=== ITER ${iter}/${MAX_ITERATIONS} ===`);

        let proposal;
        let proposalUsage;
        const currentOTWindows = data.workHourOverrides || [];
        const currentHeadcounts = data.teamDefs?.headcounts || [];
        const llmStart = Date.now();
        try {
            const r = await proposeNextRun(history, bestScore, bestConfig, iter, currentOTWindows, currentHeadcounts);
            proposal = r.proposal;
            proposalUsage = r.usage;
            addUsage(tokenAcc, proposalUsage);

            // Validate and enforce real-world constraints before running
            proposal = validateAndCleanProposal(proposal, currentHeadcounts, currentOTWindows, startDateStr);

            const llmMs = Date.now() - llmStart;
            iterStats.llmMs += llmMs;
            console.log(`  LLM proposal (${llmMs}ms): ${describeProposal(proposal)}`);
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
                horizonMonths: DEFAULT_HORIZON_MONTHS,
                paramChanges: describeProposal(proposal),
                reasoning: proposal.reasoning,
            });
            continue;
        }

        const runStart = Date.now();
        try {
            // Pass the baseline's DB-filtered task set so every iteration sees the
            // same ground truth as the baseline did.
            const result = await runWithConfig(data, proposal, DEFAULT_HORIZON_MONTHS, /* skipDbFilter */ true, preparedTasks);
            const runMs = Date.now() - runStart;
            iterStats.runMs += runMs;
            const cacheHit = result.fromCache === true;
            if (cacheHit) iterStats.cacheHits += 1;
            const s = result.score;
            logScore(`Iter ${iter}`, s);
            console.log(`  Run ${cacheHit ? 'served from cache' : 'completed'} in ${runMs}ms | iter total ${Date.now() - iterStart}ms`);

            if (s.feasible && s.compositeScore > bestScore.compositeScore) {
                console.log(`  *** NEW BEST! ${bestScore.compositeScore} → ${s.compositeScore} ***`);
                bestScore = s;
                bestConfig = result.configUsed;
            }

            history.push({
                iteration: iter,
                score: s.compositeScore,
                feasible: s.feasible,
                horizonMonths: DEFAULT_HORIZON_MONTHS,
                paramChanges: describeProposal(proposal),
                reasoning: proposal.reasoning,
                priorityWeights: proposal.priorityWeights || {},
                flexWorkers: proposal.flexWorkers || [],
                overtimeChanges: proposal.overtimeChanges || [],
                newHires: proposal.newHires || [],
                taskDateOverrides: proposal.taskDateOverrides || [],
                scheduleParams: proposal.scheduleParams || null,
                storeBreakdown: s.storeBreakdown || [],
                categories: s.categories || null,
                cacheHit,
                runMs,
            });
        } catch (e) {
            console.log(`  Run error: ${e.message}`);
            history.push({
                iteration: iter,
                score: 0,
                feasible: false,
                horizonMonths: DEFAULT_HORIZON_MONTHS,
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
    if (!DRY_RUN && MAX_ITERATIONS > 0) {
        const avgLlm = (iterStats.llmMs / MAX_ITERATIONS).toFixed(0);
        const avgRun = (iterStats.runMs / MAX_ITERATIONS).toFixed(0);
        console.log(`Timing:    avg LLM ${avgLlm}ms/iter, avg run ${avgRun}ms/iter | result-cache hits: ${iterStats.cacheHits}/${MAX_ITERATIONS}`);
    }
    console.log(`========================================\n`);

    // 5. Email report
    if (DRY_RUN) {
        console.log('Dry-run: skipping email report.');
        return;
    }

    // Build the top-N feasible runs so the email can show a schedule comparison
    // across multiple strong candidates, not just the winner. These carry their
    // full storeBreakdown so the report can render Store | Due | Baseline | #1 | #2 | #3.
    // Include top runs regardless of feasibility — infeasible runs still show useful
    // store-by-store finish dates for debugging why stores are late. Sort feasible first,
    // then by score descending, so the comparison table leads with the best viable options.
    const TOP_N = 3;
    const topRuns = history
        .filter(h => h.iteration > 0 && Array.isArray(h.storeBreakdown) && h.storeBreakdown.length > 0)
        .sort((a, b) => (b.feasible - a.feasible) || (b.score - a.score))
        .slice(0, TOP_N)
        .map(h => ({
            iteration: h.iteration,
            score: h.score,
            horizonMonths: h.horizonMonths,
            paramChanges: h.paramChanges,
            priorityWeights: h.priorityWeights,
            flexWorkers: h.flexWorkers,
            overtimeChanges: h.overtimeChanges,
            newHires: h.newHires,
            taskDateOverrides: h.taskDateOverrides,
            scheduleParams: h.scheduleParams,
            storeBreakdown: h.storeBreakdown,
            categories: h.categories,
        }));

    // --- Build email attachments ---
    const attachments = [];

    // 1. Comparison CSV — one row per store per feasible run, for spreadsheet analysis.
    // Include all scored runs (feasible or not) in the comparison CSV — infeasible runs
    // are still useful for understanding what's blocking stores.
    const scoredRuns = history.filter(h => h.iteration > 0 && h.storeBreakdown?.length > 0);
    if (scoredRuns.length > 0) {
        const csvRows = ['Run,Score,Feasible,Horizon,Parameters,Store,Types,Due Date,Finish Date,Variance Days,Early Days,NSO Status'];
        for (const run of scoredRuns) {
            for (const s of run.storeBreakdown) {
                csvRows.push([
                    run.iteration, run.score, run.feasible ? 'Yes' : 'No', run.horizonMonths,
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
        console.log(`  CSV attachment: ${scoredRuns.length} runs × ${scoredRuns[0]?.storeBreakdown?.length || 0} stores`);
    }

    // 2. Config JSONs for top runs — the exact settings needed to reproduce each candidate.
    //    Includes priorityWeights, headcount changes, OT windows, and schedule params
    //    so Danny can load any winner directly into the scheduler UI.
    for (const run of topRuns.slice(0, 5)) {
        attachments.push({
            filename: `config-run-${run.iteration}-score-${run.score}.json`,
            content: JSON.stringify({
                iteration: run.iteration,
                score: run.score,
                horizonMonths: run.horizonMonths,
                priorityWeights: run.priorityWeights || {},
                flexWorkers: run.flexWorkers || [],
                overtimeChanges: run.overtimeChanges || [],
                newHires: run.newHires || [],
                taskDateOverrides: run.taskDateOverrides || [],
                scheduleParams: run.scheduleParams || null,
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
