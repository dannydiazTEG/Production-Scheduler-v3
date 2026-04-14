/**
 * data-prep.js — Shared data preparation logic.
 * Extracted from server.js so both the API endpoints and the agent orchestrator
 * can query the database for completed/in-progress operations.
 */

const { formatDate } = require('./scheduling-engine');
const { NOOP_TIMINGS } = require('./timings');

/**
 * Query Postgres for completed and in-progress operations, then filter the task list.
 *
 * @param {Array} projectTasks - Raw task objects with Project, SKU, Operation fields
 * @param {Function} updateProgress - Callback: (progress, message) => void
 * @param {Object} pgPool - Postgres connection pool (from db.js)
 * @param {Object} [timings] - Optional timings instance from timings.js
 * @returns {{ tasks: Array, logs: string[], completedTasks: Array }}
 */
async function prepareProjectData(projectTasks, updateProgress, pgPool, timings = NOOP_TIMINGS) {
    timings.mark('dataPrep.total.start');
    const logs = [];
    const projectNames = [...new Set(projectTasks.map(p => p['Project']))];
    timings.note('projectCount', projectNames.length);
    timings.note('rawTaskCount', projectTasks.length);

    if (projectNames.length === 0) {
        timings.mark('dataPrep.total.end');
        return { tasks: [], logs: ["No projects were provided to prepare."], completedTasks: [] };
    }

    let completedOperations = new Set();
    let completedTasksForReport = [];

    let liveCompletedTasks = [];
    try {
        if (!pgPool) {
            throw new Error('DATABASE_URL not configured — no database connection available');
        }
        updateProgress(5, 'Querying database for completed tasks...');
        const query = `
            SELECT job_name, item_reference_name, operation_name, created_at
            FROM raw_fulcrum_job_log
            WHERE log_type = 'OperationRunCompleted'
            AND job_name = ANY($1)
        `;

        timings.mark('dataPrep.dbCompletedOps.start');
        const result = await pgPool.query(query, [projectNames]);
        timings.mark('dataPrep.dbCompletedOps.end');
        liveCompletedTasks = result.rows;
        timings.note('dbCompletedOpsRows', liveCompletedTasks.length);

        logs.push(`Found ${liveCompletedTasks.length} completed operations in database.`);
        updateProgress(10, 'Processing completed task results...');

    } catch (err) {
        logs.push(`Database Error: ${err.message}. Proceeding without live data.`);
        console.error('Database query failed:', err);
        updateProgress(10, 'Database query failed. Skipping completion check...');
        liveCompletedTasks = [];
    }

    liveCompletedTasks.forEach(row => {
        const key = `${row.job_name}|${row.item_reference_name}|${row.operation_name}`;
        completedOperations.add(key);
        completedTasksForReport.push({
            Project: row.job_name,
            SKU: row.item_reference_name,
            Operation: row.operation_name,
            CompletionDate: formatDate(row.created_at)
        });
    });

    const remainingTasks = projectTasks.filter(task => {
        const operationKey = `${task.Project}|${task.SKU}|${task.Operation}`;
        return !completedOperations.has(operationKey);
    });

    logs.push(`Filtered out ${projectTasks.length - remainingTasks.length} completed operations.`);

    // Query for in-progress operations (Running or Paused in Fulcrum)
    let inProgressOps = new Set();
    try {
        if (pgPool) {
            const ipQuery = `
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
            timings.mark('dataPrep.dbInProgress.start');
            const ipResult = await pgPool.query(ipQuery, [projectNames]);
            timings.mark('dataPrep.dbInProgress.end');
            ipResult.rows.forEach(row => {
                inProgressOps.add(`${row.job_name}|${row.item_reference_name}|${row.operation_name}`);
            });
            timings.note('dbInProgressRows', inProgressOps.size);
            logs.push(`Found ${inProgressOps.size} in-progress operations (Running/Paused in Fulcrum).`);
        }
    } catch (err) {
        logs.push(`In-progress query failed: ${err.message}. Continuing without in-progress tagging.`);
    }

    // Tag remaining tasks with in-progress status
    remainingTasks.forEach(task => {
        const key = `${task.Project}|${task.SKU}|${task.Operation}`;
        task.InProgress = inProgressOps.has(key);
    });

    timings.note('filteredTaskCount', remainingTasks.length);
    timings.mark('dataPrep.total.end');
    return { tasks: remainingTasks, logs, completedTasks: completedTasksForReport };
}

module.exports = { prepareProjectData };
