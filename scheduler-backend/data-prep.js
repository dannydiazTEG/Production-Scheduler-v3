/**
 * data-prep.js — Shared data preparation logic.
 * Extracted from server.js so both the API endpoints and the agent orchestrator
 * can query the database for completed/in-progress operations.
 */

const { formatDate } = require('./scheduling-engine');
const { NOOP_TIMINGS } = require('./timings');
const cache = require('./cache');

/**
 * Query Postgres for completed and in-progress operations, then filter the task list.
 *
 * @param {Array} projectTasks - Raw task objects with Project, SKU, Operation fields
 * @param {Function} updateProgress - Callback: (progress, message) => void
 * @param {Object} pgPool - Postgres connection pool (from db.js)
 * @param {Object} [timings] - Optional timings instance from timings.js
 * @param {Object} [opts]
 * @param {boolean} [opts.fresh] - When true, bypass cache and query the DB.
 *                                 The fresh result is still written back to cache.
 * @returns {{ tasks: Array, logs: string[], completedTasks: Array }}
 */
async function prepareProjectData(projectTasks, updateProgress, pgPool, timings = NOOP_TIMINGS, opts = {}) {
    timings.mark('dataPrep.total.start');
    const logs = [];
    const projectNames = [...new Set(projectTasks.map(p => p['Project']))];
    timings.note('projectCount', projectNames.length);
    timings.note('rawTaskCount', projectTasks.length);

    if (projectNames.length === 0) {
        timings.mark('dataPrep.total.end');
        return { tasks: [], logs: ["No projects were provided to prepare."], completedTasks: [] };
    }

    const fresh = !!opts.fresh;
    let liveCompletedTasks = [];
    let inProgressRows = [];
    let cacheHit = false;

    // --- Try cache first (unless caller requested fresh data) ---
    if (!fresh) {
        const cached = await cache.getCompletedOps(pgPool, projectNames, { timings });
        if (cached) {
            liveCompletedTasks = cached.completedRows;
            inProgressRows = cached.inProgressRows;
            cacheHit = true;
            timings.note('completedOpsCacheHit', true);
            logs.push(`Loaded ${liveCompletedTasks.length} completed ops from cache (refreshed ${cached.refreshedAt.toISOString()}).`);
            updateProgress(10, 'Loaded completed tasks from cache...');
        }
    }

    // --- Cache miss or forced-fresh: query the DB ---
    if (!cacheHit) {
        try {
            if (!pgPool) {
                throw new Error('DATABASE_URL not configured — no database connection available');
            }
            updateProgress(5, 'Querying database for completed tasks...');
            const completedQuery = `
                SELECT job_name, item_reference_name, operation_name, created_at
                FROM raw_fulcrum_job_log
                WHERE log_type = 'OperationRunCompleted'
                AND job_name = ANY($1)
            `;
            const inProgressQuery = `
                WITH latest_events AS (
                    SELECT
                        job_name, item_reference_name, operation_name, log_type,
                        ROW_NUMBER() OVER (
                            PARTITION BY job_name, item_reference_name, operation_name
                            ORDER BY created_at DESC
                        ) as rn
                    FROM raw_fulcrum_job_log
                    WHERE log_type IN ('OperationLaborStarted', 'OperationLaborStopped', 'OperationRunCompleted')
                    AND job_name = ANY($1)
                )
                SELECT job_name, item_reference_name, operation_name
                FROM latest_events
                WHERE rn = 1
                AND log_type IN ('OperationLaborStarted', 'OperationLaborStopped')
            `;
            // Run in parallel — independent queries, saves ~one round-trip on cold cache.
            timings.mark('dataPrep.dbCompletedOps.start');
            const [completedResult, inProgressResult] = await Promise.all([
                pgPool.query(completedQuery, [projectNames]),
                pgPool.query(inProgressQuery, [projectNames]),
            ]);
            timings.mark('dataPrep.dbCompletedOps.end');
            liveCompletedTasks = completedResult.rows;
            inProgressRows = inProgressResult.rows;
            timings.note('dbCompletedOpsRows', liveCompletedTasks.length);
            timings.note('dbInProgressRows', inProgressRows.length);
            timings.note('completedOpsCacheHit', false);
            logs.push(`Found ${liveCompletedTasks.length} completed operations in database.`);
            logs.push(`Found ${inProgressRows.length} in-progress operations (Running/Paused in Fulcrum).`);
            updateProgress(10, 'Processing completed task results...');

            // Fire-and-forget write-back to cache. Errors are logged inside cache.js
            // and do not affect the current request.
            cache.setCompletedOps(pgPool, projectNames, liveCompletedTasks, inProgressRows).catch(() => {});
        } catch (err) {
            logs.push(`Database Error: ${err.message}. Proceeding without live data.`);
            console.error('Database query failed:', err);
            updateProgress(10, 'Database query failed. Skipping completion check...');
            liveCompletedTasks = [];
            inProgressRows = [];
        }
    }

    // --- Build lookup structures (same logic as before; works for cached + fresh) ---
    const completedOperations = new Set();
    const completedTasksForReport = [];
    for (const row of liveCompletedTasks) {
        const key = `${row.job_name}|${row.item_reference_name}|${row.operation_name}`;
        completedOperations.add(key);
        completedTasksForReport.push({
            Project: row.job_name,
            SKU: row.item_reference_name,
            Operation: row.operation_name,
            CompletionDate: formatDate(row.created_at),
        });
    }

    const remainingTasks = projectTasks.filter(task => {
        const operationKey = `${task.Project}|${task.SKU}|${task.Operation}`;
        return !completedOperations.has(operationKey);
    });
    logs.push(`Filtered out ${projectTasks.length - remainingTasks.length} completed operations.`);

    const inProgressOps = new Set();
    for (const row of inProgressRows) {
        inProgressOps.add(`${row.job_name}|${row.item_reference_name}|${row.operation_name}`);
    }
    for (const task of remainingTasks) {
        const key = `${task.Project}|${task.SKU}|${task.Operation}`;
        task.InProgress = inProgressOps.has(key);
    }

    timings.note('filteredTaskCount', remainingTasks.length);
    timings.mark('dataPrep.total.end');
    return { tasks: remainingTasks, logs, completedTasks: completedTasksForReport };
}

module.exports = { prepareProjectData };
