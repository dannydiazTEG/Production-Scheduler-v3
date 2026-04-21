/**
 * store-work-breakdown.js — Per-store rollup of remaining task work.
 *
 * Takes the post-filter task set plus the scoring output's storeBreakdown and
 * produces one row per in-scope store with per-team ops/hours counts. Used to
 * build the "remaining-work-by-store" CSV attached to the cron's nightly
 * email.
 *
 * Why this exists: lets Danny audit "does PCB really have N ops of Paint work
 * left, or is the engine seeing stale task state?" directly from the email
 * attachment, without needing to log into the scheduler UI.
 */

// Match the physical teams that show up in the schedule — `Hybrid` is a meta
// team synthesized by the engine for flex workers and has no CSV column.
const TEAM_COLUMNS = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC'];

function emptyTeamMap() {
    const out = {};
    for (const t of TEAM_COLUMNS) out[t] = { ops: 0, hours: 0 };
    return out;
}

function roundHours(h) {
    return Math.round((h || 0) * 10) / 10;
}

/**
 * @param {Array} preparedTasks - Post-filter task list (each has Store, Team, HoursRemaining)
 * @param {Array} storeBreakdown - scoreResult.storeBreakdown — defines which stores to emit
 * @param {Map}   _storeDueDates - Reserved for future enrichment (unused today; breakdown already has dueDate)
 * @param {Set}   teamsToIgnore - Team names to fold into totals but not column-out (e.g. Unassigned, Print)
 * @returns {Array<Object>} One row per store with per-team counts + hours
 */
function computeStoreWorkBreakdown(preparedTasks, storeBreakdown, _storeDueDates, teamsToIgnore) {
    const ignore = teamsToIgnore || new Set();
    const buckets = new Map();
    for (const s of storeBreakdown) {
        buckets.set(s.store, {
            store: s.store,
            projectType: (s.projectTypes || []).slice().sort().join('/'),
            dueDate: s.dueDate || null,
            finishDate: s.finishDate || null,
            latenessDays: s.latenessDays || 0,
            totalOps: 0,
            totalHours: 0,
            teams: emptyTeamMap(),
        });
    }

    for (const task of (preparedTasks || [])) {
        const bucket = buckets.get(task.Store);
        if (!bucket) continue;
        const hours = parseFloat(task.HoursRemaining) || 0;
        bucket.totalOps += 1;
        bucket.totalHours += hours;
        if (ignore.has(task.Team)) continue;
        if (bucket.teams[task.Team]) {
            bucket.teams[task.Team].ops += 1;
            bucket.teams[task.Team].hours += hours;
        }
    }

    const result = [];
    for (const bucket of buckets.values()) {
        bucket.totalHours = roundHours(bucket.totalHours);
        for (const t of TEAM_COLUMNS) {
            bucket.teams[t].hours = roundHours(bucket.teams[t].hours);
        }
        result.push(bucket);
    }
    return result;
}

module.exports = { computeStoreWorkBreakdown, TEAM_COLUMNS };
