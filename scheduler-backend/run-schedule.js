#!/usr/bin/env node
// =================================================================
// CLI Runner for Production Scheduling Engine
// =================================================================
// Usage:
//   node run-schedule.js --tasks <csv> --config <json>
//   node run-schedule.js --tasks <csv> --config <json> --weights '{"pastDueBase": 150}'
//   node run-schedule.js --tasks <csv> --config <json> --out results.json
//   node run-schedule.js --tasks <csv> --config <json> --no-db
//
// Inputs:
//   --tasks   CSV file with columns: Project, Store, SKU, SKU Name, Operation,
//             Order, Estimated Hours, Value, StartDate, DueDate
//             (plus optional: LagAfterHours, AssemblyGroup, DelayUntilClose)
//   --config  JSON config file exported from the web app (schedule_config.json)
//   --weights Optional JSON string or file path with priority weight overrides
//   --out     Output file path (default: prints summary to stdout)
//   --type    Default project type when not in CSV: NSO, INFILL, RENO, PC (default: NSO)
//   --no-db   Skip database query for completed tasks (schedule all tasks as-is)
//   --quiet   Suppress progress messages
// =================================================================

if (process.env.NODE_ENV !== 'production') {
    try { require('dotenv').config(); } catch { /* dotenv optional */ }
}

const fs = require('fs');
const path = require('path');
const {
    runSchedulingEngine,
    DEFAULT_PRIORITY_WEIGHTS,
    parseDate,
    formatDate,
} = require('./scheduling-engine');

// --- Argument Parsing ---
function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--tasks' && args[i + 1]) parsed.tasks = args[++i];
        else if (args[i] === '--config' && args[i + 1]) parsed.config = args[++i];
        else if (args[i] === '--weights' && args[i + 1]) parsed.weights = args[++i];
        else if (args[i] === '--out' && args[i + 1]) parsed.out = args[++i];
        else if (args[i] === '--type' && args[i + 1]) parsed.type = args[++i];
        else if (args[i] === '--no-db') parsed.noDb = true;
        else if (args[i] === '--quiet') parsed.quiet = true;
        else if (args[i] === '--help' || args[i] === '-h') parsed.help = true;
    }
    return parsed;
}

function printUsage() {
    console.log(`
Production Scheduling Engine — CLI Runner

Usage:
  node run-schedule.js --tasks <csv> --config <json> [options]

Required:
  --tasks <path>     CSV file with project tasks
  --config <path>    JSON config file (exported from web app)

Options:
  --weights <json>   Priority weight overrides (JSON string or file path)
  --out <path>       Write full results to JSON file
  --type <type>      Default project type: NSO, INFILL, RENO, PC (default: NSO)
  --no-db            Skip database lookup for completed tasks
  --quiet            Suppress progress output
  --help             Show this help

Examples:
  node run-schedule.js --tasks tasks.csv --config config.json
  node run-schedule.js --tasks tasks.csv --config config.json --weights '{"pastDueBase": 150}'
  node run-schedule.js --tasks tasks.csv --config config.json --weights weights.json --out results.json
`);
}

// --- CSV Parser ---
function parseCsv(text) {
    const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

    const headers = parseCsvLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const values = parseCsvLine(lines[i]);
        if (values.length !== headers.length) continue; // skip malformed rows
        const row = {};
        headers.forEach((h, idx) => { row[h.trim()] = (values[idx] || '').trim(); });
        rows.push(row);
    }
    return rows;
}

function parseCsvLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i + 1] === '"') {
                current += '"';
                i++;
            } else if (ch === '"') {
                inQuotes = false;
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(current);
                current = '';
            } else {
                current += ch;
            }
        }
    }
    result.push(current);
    return result;
}

// --- Column Aliases ---
const COLUMN_ALIASES = {
    'Game': 'Project',
    'Expected Hours': 'Estimated Hours',
    'Labor Time': 'Estimated Hours',
    'Due Date': 'DueDate',
    'Start Date': 'StartDate',
};

function normalizeColumns(rows) {
    return rows.map(row => {
        const normalized = {};
        for (const [key, value] of Object.entries(row)) {
            const mappedKey = COLUMN_ALIASES[key] || key;
            normalized[mappedKey] = value;
        }
        return normalized;
    });
}

// --- Task Processing ---
function processTasksCsv(csvPath, defaultProjectType) {
    const text = fs.readFileSync(csvPath, 'utf-8');
    let rows = parseCsv(text);
    rows = normalizeColumns(rows);

    const tasks = rows
        .map(row => ({
            ...row,
            'Estimated Hours': parseFloat(row['Estimated Hours']) || 0,
            Order: parseInt(row.Order, 10),
            Value: parseFloat(String(row.Value || '0').replace(/,/g, '')) || 0,
            LagAfterHours: parseFloat(row.LagAfterHours) || 0,
            AssemblyGroup: row.AssemblyGroup || '',
            DelayUntilClose: (row.DelayUntilClose || '').toUpperCase() === 'TRUE',
            Store: row.Store || 'N/A',
            ProjectType: row.ProjectType || defaultProjectType,
        }))
        .filter(row =>
            row.Project &&
            row.SKU &&
            row.Store &&
            !isNaN(row.Order) &&
            row.DueDate &&
            row.StartDate &&
            !isNaN(row['Estimated Hours'])
        );

    return tasks;
}

// --- Load Weights ---
function loadWeights(weightsArg) {
    if (!weightsArg) return undefined;

    // Try as file path first
    if (fs.existsSync(weightsArg)) {
        return JSON.parse(fs.readFileSync(weightsArg, 'utf-8'));
    }

    // Try as inline JSON
    try {
        return JSON.parse(weightsArg);
    } catch {
        throw new Error(`--weights must be a valid JSON string or path to a JSON file. Got: ${weightsArg}`);
    }
}

// --- Print Summary ---
function printSummary(results) {
    const { projectSummary, teamUtilization, weeklyOutput, logs, error } = results;

    if (error) {
        console.error(`\nEngine error: ${error}`);
        return;
    }

    console.log('\n=== Schedule Summary ===\n');

    // Project completion
    if (projectSummary && projectSummary.length > 0) {
        console.log(`Projects: ${projectSummary.length}`);
        const onTime = projectSummary.filter(p => p.FinishDate <= p.DueDate).length;
        const late = projectSummary.length - onTime;
        console.log(`  On time: ${onTime}  |  Late: ${late}`);

        console.log('\n  Project                          | Finish     | Due        | Variance');
        console.log('  ' + '-'.repeat(80));
        projectSummary
            .sort((a, b) => a.FinishDate.localeCompare(b.FinishDate))
            .forEach(p => {
                const finish = new Date(p.FinishDate);
                const due = new Date(p.DueDate);
                const variance = Math.round((due - finish) / (1000 * 60 * 60 * 24));
                const status = variance >= 0 ? `${variance}d early` : `${-variance}d LATE`;
                const name = (p.Project + ' (' + p.Store + ')').padEnd(33);
                console.log(`  ${name} | ${p.FinishDate} | ${p.DueDate} | ${status}`);
            });
    }

    // Weekly output value
    if (weeklyOutput && weeklyOutput.length > 0) {
        const totalValue = weeklyOutput.reduce((sum, w) => sum + w.totalValue, 0);
        const totalHours = weeklyOutput.reduce((sum, w) => sum + w.totalHoursWorked, 0);
        const avgValuePerHour = totalHours > 0 ? (totalValue / totalHours).toFixed(2) : 'N/A';
        console.log(`\nOutput: $${totalValue.toLocaleString()} total value | ${totalHours.toFixed(0)} paid hours | $${avgValuePerHour}/hr`);
    }

    // Team utilization summary (average across all weeks)
    if (teamUtilization && teamUtilization.length > 0) {
        const teamAvg = {};
        teamUtilization.forEach(week => {
            week.teams.forEach(t => {
                if (!teamAvg[t.name]) teamAvg[t.name] = { total: 0, count: 0 };
                teamAvg[t.name].total += t.utilization;
                teamAvg[t.name].count++;
            });
        });
        console.log('\nAvg Team Utilization:');
        Object.entries(teamAvg)
            .sort(([, a], [, b]) => (b.total / b.count) - (a.total / a.count))
            .forEach(([team, data]) => {
                const avg = Math.round(data.total / data.count);
                const bar = '█'.repeat(Math.round(avg / 5)) + '░'.repeat(20 - Math.round(avg / 5));
                console.log(`  ${team.padEnd(12)} ${bar} ${avg}%`);
            });
    }

    // Log count
    if (logs) {
        const warnings = logs.filter(l => l.includes('WARNING')).length;
        console.log(`\nEngine logs: ${logs.length} entries${warnings > 0 ? ` (${warnings} warnings)` : ''}`);
    }
}

// --- Main ---
async function main() {
    const args = parseArgs();

    if (args.help) {
        printUsage();
        process.exit(0);
    }

    if (!args.tasks || !args.config) {
        console.error('Error: --tasks and --config are required.\n');
        printUsage();
        process.exit(1);
    }

    // Validate inputs exist
    if (!fs.existsSync(args.tasks)) {
        console.error(`Error: Tasks file not found: ${args.tasks}`);
        process.exit(1);
    }
    if (!fs.existsSync(args.config)) {
        console.error(`Error: Config file not found: ${args.config}`);
        process.exit(1);
    }

    const defaultType = (args.type || 'NSO').toUpperCase();
    const quiet = args.quiet || false;

    // Load inputs
    if (!quiet) console.log('Loading inputs...');

    const config = JSON.parse(fs.readFileSync(args.config, 'utf-8'));
    let projectTasks = processTasksCsv(args.tasks, defaultType);
    const priorityWeights = loadWeights(args.weights);

    if (!quiet) {
        console.log(`  Tasks: ${projectTasks.length} rows from ${path.basename(args.tasks)}`);
        console.log(`  Config: ${config.scheduleName || 'unnamed'}`);
        console.log(`  Teams: ${config.teamDefs.headcounts.map(h => `${h.name}(${h.count})`).join(', ')}`);
        if (priorityWeights) {
            console.log(`  Weight overrides: ${JSON.stringify(priorityWeights)}`);
        }
    }

    // Filter out completed tasks from database (unless --no-db)
    if (!args.noDb) {
        const pgPool = require('./db');
        if (pgPool) {
            try {
                if (!quiet) console.log('  Querying database for completed operations...');
                const projectNames = [...new Set(projectTasks.map(t => t.Project))];
                const result = await pgPool.query(
                    `SELECT job_name, item_reference_name, operation_name
                     FROM raw_fulcrum_job_log
                     WHERE log_type = 'OperationRunCompleted'
                     AND job_name = ANY($1)`,
                    [projectNames]
                );
                const completedOps = new Set(
                    result.rows.map(r => `${r.job_name}|${r.item_reference_name}|${r.operation_name}`)
                );
                const before = projectTasks.length;
                projectTasks = projectTasks.filter(t => {
                    const key = `${t.Project}|${t.SKU}|${t.Operation}`;
                    return !completedOps.has(key);
                });
                const filtered = before - projectTasks.length;
                if (!quiet) console.log(`  Filtered out ${filtered} completed operations (${projectTasks.length} remaining)`);

                // Query for in-progress operations (Running/Paused in Fulcrum)
                const ipResult = await pgPool.query(
                    `WITH latest_events AS (
                        SELECT job_name, item_reference_name, operation_name, log_type,
                            ROW_NUMBER() OVER (
                                PARTITION BY job_name, item_reference_name, operation_name
                                ORDER BY created_at DESC
                            ) as rn
                        FROM raw_fulcrum_job_log
                        WHERE log_type IN ('OperationLaborStarted', 'OperationLaborStopped', 'OperationRunCompleted')
                        AND job_name = ANY($1)
                    )
                    SELECT job_name, item_reference_name, operation_name
                    FROM latest_events WHERE rn = 1
                    AND log_type IN ('OperationLaborStarted', 'OperationLaborStopped')`,
                    [projectNames]
                );
                const inProgressOps = new Set(
                    ipResult.rows.map(r => `${r.job_name}|${r.item_reference_name}|${r.operation_name}`)
                );
                projectTasks.forEach(t => {
                    const key = `${t.Project}|${t.SKU}|${t.Operation}`;
                    t.InProgress = inProgressOps.has(key);
                });
                const ipCount = projectTasks.filter(t => t.InProgress).length;
                if (!quiet) console.log(`  Tagged ${ipCount} in-progress operations (Running/Paused)`);

                // Close pool after queries so the process can exit
                await pgPool.end();
            } catch (err) {
                console.error(`  Database warning: ${err.message}. Running without completion filtering.`);
            }
        } else {
            if (!quiet) console.log('  No DATABASE_URL set — skipping completion filtering');
        }
    } else {
        if (!quiet) console.log('  --no-db flag set — skipping completion filtering');
    }

    // Build engine inputs from config
    const {
        params,
        teamDefs,
        teamMemberChanges = [],
        hybridWorkers = [],
        ptoEntries = [],
        workHourOverrides = [],
    } = config;

    // The engine expects these but they default to empty when not in config
    const efficiencyData = config.efficiencyData || {};
    const teamMemberNameMap = config.teamMemberNameMap || {};
    const startDateOverrides = config.startDateOverrides || {};
    const endDateOverrides = config.endDateOverrides || {};

    // Progress callback
    const updateProgress = quiet
        ? () => {}
        : (progress, message) => {
            process.stdout.write(`\r  [${progress}%] ${message}`.padEnd(60));
        };

    // Run the engine
    if (!quiet) console.log('\nRunning scheduling engine...');
    const startTime = Date.now();

    const results = await runSchedulingEngine(
        projectTasks,
        params,
        teamDefs,
        ptoEntries,
        teamMemberChanges,
        workHourOverrides,
        hybridWorkers,
        efficiencyData,
        teamMemberNameMap,
        startDateOverrides,
        endDateOverrides,
        updateProgress,
        priorityWeights
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    if (!quiet) console.log(`\n  Completed in ${elapsed}s`);

    // Output
    if (args.out) {
        fs.writeFileSync(args.out, JSON.stringify(results, null, 2));
        if (!quiet) console.log(`\nFull results written to ${args.out}`);
    }

    printSummary(results);
}

main().catch(err => {
    console.error(`\nFatal error: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
});
