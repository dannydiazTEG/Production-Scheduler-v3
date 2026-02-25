// server.js
// This is the backend server for your Production Scheduling Engine.
// It now includes logic for Snowflake integration and asynchronous job processing.
// --- VERSION 3.2: Added LagAfterHours logic for process sit/dry time ---

if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const snowflake = require('snowflake-sdk');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid'); // To generate unique job IDs

// --- Setup ---
const app = express();
const port = process.env.PORT || 3001;

// --- Middleware ---
const allowedOrigins = [
  'https://tegproductiondb.web.app',
  /https:\/\/tegproductiondb--.+\.web\.app$/,
  'http://localhost:3000', // Allow local development
  'http://localhost:3001',  // Allow backend self-requests
  /^http:\/\/localhost(:\d+)?$/, // Allow localhost with any port
  /^http:\/\/127\.0\.0\.1(:\d+)?$/, // Allow 127.0.0.1 with any port
  /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/, // Allow local network 192.168.x.x
  /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/, // Allow local network 10.x.x.x
  /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/ // Allow local network 172.16-31.x.x
];

const corsOptions = {
  origin: function (origin, callback) {
    // Log all CORS checks for debugging
    console.log(`CORS Check: Origin="${origin}"`);
    if (!origin || allowedOrigins.some(allowed => typeof allowed === 'string' ? allowed === origin : allowed.test(origin))) {
      console.log(`CORS Check: Origin ${origin || 'null'} is ALLOWED`);
      return callback(null, true);
    } else {
      console.error(`CORS Check: Origin ${origin} is NOT allowed.`);
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 600 // Cache preflight for 10 minutes
};
app.use(cors(corsOptions));

// Handle OPTIONS preflight requests explicitly
// Note: cors middleware already handles OPTIONS automatically

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// --- In-memory store for async jobs ---
const jobs = {};

// --- JOB CLEANUP TO PREVENT MEMORY LEAKS ---
// Automatically removes completed jobs older than 1 hour
const JOB_RETENTION_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // Run cleanup every 10 minutes

function cleanupOldJobs() {
    const now = Date.now();
    let removedCount = 0;

    for (const jobId in jobs) {
        const job = jobs[jobId];
        // Remove jobs that are complete or errored AND older than retention period
        if ((job.status === 'complete' || job.status === 'error') &&
            job.createdAt && (now - job.createdAt > JOB_RETENTION_MS)) {
            delete jobs[jobId];
            removedCount++;
        }
    }

    if (removedCount > 0) {
        console.log(`Cleaned up ${removedCount} old jobs. Active jobs remaining: ${Object.keys(jobs).length}`);
    }
}

// Start periodic cleanup
setInterval(cleanupOldJobs, CLEANUP_INTERVAL_MS);
console.log('Job cleanup service started. Will run every 10 minutes to remove jobs older than 1 hour.');

// --- CONSTANTS ---
// UPDATED: Added 'Receiving' (start of flow) and 'QC' (end of flow) to sort order
const TEAM_SORT_ORDER = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC', 'Hybrid'];

// =================================================================
// --- MASTER ROUTING DATA FROM GOOGLE SHEETS ---
// =================================================================
const MASTER_ROUTING_URL = process.env.MASTER_ROUTING_URL || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTTmWdo7GyGwrG1iru8KBk166ndwV802lg3slbcrgekwdLXWWb9WF-i0snEipFq-AMVMTNH9qUWxHH_/pub?gid=1072114065&single=true&output=csv';
let masterRoutingData = {};

async function loadMasterRoutingData() {
    console.log(`Fetching master routing data from: ${MASTER_ROUTING_URL}`);
    try {
        const response = await fetch(MASTER_ROUTING_URL);
        if (!response.ok) throw new Error(`Network response was not ok: ${response.statusText}`);
        
        const csvText = await response.text();
        const lines = csvText.trim().replace(/\r/g, '').split('\n');
        const header = lines[0].split(',').map(h => h.trim());
        const rows = lines.slice(1).map(line => {
            const values = line.split(',');
            const rowObject = {};
            header.forEach((col, index) => rowObject[col] = values[index]?.trim());
            return rowObject;
        });

        const groupedData = {};
        for (const row of rows) {
            const projectType = row.TemplateName; 
            if (!projectType) continue;
            if (!groupedData[projectType]) groupedData[projectType] = [];
            
            // --- MODIFIED SECTION ---
            // Added LagAfterHours to the data loading logic.
            groupedData[projectType].push({
                "Operation": row.Operation,
                "Estimated Hours": parseFloat(row['Estimated Hours']),
                "Order": parseInt(row.Order, 10),
                "SKU": row.SKU,
                "SKU Name": row['SKU Name'],
                "Value": parseFloat(row.Value),
                "LagAfterHours": parseFloat(row.LagAfterHours) || 0
            });
            // --- END MODIFICATION ---
        }
        
        for(const projectType in groupedData) {
            groupedData[projectType].sort((a, b) => a.Order - b.Order);
        }

        masterRoutingData = groupedData;
        console.log(`Successfully loaded routing for ${Object.keys(masterRoutingData).length} project types.`);

    } catch (error) {
        console.error(`Failed to load master routing data: ${error.message}`);
        console.error("WARNING: Server will continue running, but project builder may not work until routing data loads.");
        // Retry after 30 seconds
        setTimeout(() => {
            console.log("Retrying to load master routing data...");
            loadMasterRoutingData();
        }, 30000);
    }
}

// =================================================================
// --- SNOWFLAKE CONNECTION POOL ---
// =================================================================
const snowflakePool = snowflake.createPool({
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USER,
    password: process.env.SNOWFLAKE_PASSWORD,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA
}, {
    max: 10, // max number of connections in the pool
    min: 1   // min number of connections in the pool
});

// --- Helper Functions ---
const parseDate = (dateStr) => {
    if (!dateStr || typeof dateStr !== 'string') return null;
    if (dateStr.endsWith('Z')) {
        const date = new Date(dateStr);
        return isNaN(date.getTime()) ? null : date;
    }
    const sanitizedStr = dateStr.replace(/-/g, '/');
    const date = new Date(sanitizedStr);
    return isNaN(date.getTime()) ? null : date;
};

const formatDate = (date) => {
    if (!date) return '';
    const dateObj = (typeof date === 'string') ? parseDate(date) : date;
    if (!dateObj || isNaN(dateObj.getTime())) return '';
    return dateObj.toISOString().split('T')[0];
};

const getWeekStartDate = (date) => {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day;
    return new Date(d.setDate(diff));
};

// --- Data Preparation Logic with Snowflake ---
async function prepareProjectData(projectTasks, updateProgress) {
    const logs = [];
    const projectNumbers = [...new Set(projectTasks.map(p => p['Project']))];

    if (projectNumbers.length === 0) {
        return { tasks: [], logs: ["No projects were provided to prepare."], completedTasks: [] };
    }

    let completedOperations = new Set();
    let completedTasksForReport = [];
    
    let liveCompletedTasks = [];
    try {
        updateProgress(5, 'Querying Snowflake for completed tasks...');
        const placeholders = projectNumbers.map(() => '?').join(',');
        const query = `
            SELECT JOBNAME, ITEMREFERENCE_NUMBER, JOBOPERATIONNAME, CREATEDUTC
            FROM JOBLOG 
            WHERE LOGTYPE = 'OperationRunCompleted'
            AND JOBNAME IN (${placeholders});
        `;

        await snowflakePool.use(async (connection) => {
            const statement = await connection.execute({
                sqlText: query,
                binds: projectNumbers,
            });

            liveCompletedTasks = await new Promise((resolve, reject) => {
                const rows = [];
                statement.streamRows()
                    .on('error', (err) => reject(err))
                    .on('data', (row) => rows.push(row))
                    .on('end', () => resolve(rows));
            });
        });

        logs.push(`Found ${liveCompletedTasks.length} completed operations in Snowflake.`);
        updateProgress(10, 'Processing Snowflake results...');

    } catch (err) {
        logs.push(`Snowflake Error: ${err.message}. Proceeding without live data.`);
        console.error('Snowflake query failed:', err);
        updateProgress(10, 'Snowflake query failed. Skipping check...');
        liveCompletedTasks = []; 
    }
    
    liveCompletedTasks.forEach(row => {
        const key = `${row.JOBNAME}|${row.ITEMREFERENCE_NUMBER}|${row.JOBOPERATIONNAME}`;
        completedOperations.add(key);
        completedTasksForReport.push({
            Project: row.JOBNAME,
            SKU: row.ITEMREFERENCE_NUMBER,
            Operation: row.JOBOPERATIONNAME,
            CompletionDate: formatDate(row.CREATEDUTC)
        });
    });

    const remainingTasks = projectTasks.filter(task => {
        const operationKey = `${task.Project}|${task.SKU}|${task.Operation}`;
        return !completedOperations.has(operationKey);
    });

    logs.push(`Filtered out ${projectTasks.length - remainingTasks.length} completed operations based on Snowflake data.`);
    
    return { tasks: remainingTasks, logs, completedTasks: completedTasksForReport };
}


// --- Core Scheduling Logic ---
const runSchedulingEngine = async (
    preparedTasks, params, teamDefs, ptoEntries, teamMemberChanges,
    workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
    startDateOverrides, endDateOverrides,
    updateProgress 
) => {
    const logs = [];
    let error = '';

    const tasksWithOverrides = preparedTasks.map(task => {
        const newStartDate = startDateOverrides[task.Project];
        const newDueDate = endDateOverrides[task.Project];
        if (newStartDate) task.StartDate = newStartDate;
        if (newDueDate) task.DueDate = newDueDate;
        return task;
    });

    const assignTeams = (df, mapping) => {
        const teamMap = mapping.reduce((acc, curr) => ({...acc, [curr.operation]: curr.team }), {});
        return df.map(row => {
            // Check if operation name contains "kitting" (case-insensitive)
            const operationLower = (row.Operation || '').toLowerCase();
            if (operationLower.includes('kitting')) {
                return { ...row, Team: 'Receiving' };
            }
            return { ...row, Team: teamMap[row.Operation] || 'Unassigned' };
        });
    };

    const calculateBasePriority = (df, headcounts) => {
        const teamHeadcountMap = headcounts.reduce((acc, curr) => ({ ...acc, [curr.name]: curr.count }), {});
        const skuGroups = df.reduce((acc, row) => {
            if (!acc[row.SKU]) acc[row.SKU] = [];
            acc[row.SKU].push(row);
            return acc;
        }, {});
        const skuScores = {};
        for (const sku in skuGroups) {
            const tasks = skuGroups[sku];
            const totalHours = tasks.reduce((sum, t) => sum + (t['Estimated Hours'] || 0), 0);
            const opCount = tasks.length;
            const assemblyTask = tasks.find(t => t.Operation === 'Final Assembly');
            const assemblyHours = assemblyTask ? (assemblyTask['Estimated Hours'] || 0) : 0;
            const assemblyOrder = assemblyTask ? assemblyTask.Order : Infinity;
            const stepsBeforeAssembly = tasks.filter(t => t.Order < assemblyOrder).length;
            const assemblyImpact = assemblyHours > 15 ? 3 : assemblyHours >= 8 ? 2 : 1;
            const assemblyConstraint = stepsBeforeAssembly === 0 ? 1 : stepsBeforeAssembly <= 2 ? 2 : stepsBeforeAssembly <= 4 ? 1.5 : 1;
            skuScores[sku] = { BasePriority: (totalHours + opCount) * (assemblyImpact * assemblyConstraint) };
        }
        return df.map(row => ({ ...row, BasePriority: skuScores[row.SKU]?.BasePriority || 0, TeamCapacity: teamHeadcountMap[row.Team] || 1 }));
    };
    
    try {
        logs.push("--- Starting Scheduling Simulation on Server ---");
        logs.push(`Received ${teamMemberChanges.length} team member changes`);
        logs.push(`Received ${workHourOverrides.length} work hour overrides`);

        // Extract hybrid workers from scheduled team member changes
        const scheduledHybridWorkers = teamMemberChanges
            .filter(c => c.type === 'Starts' && c.isHybrid && c.secondaryTeam)
            .map(c => ({
                name: c.name,
                primaryTeam: c.team,
                secondaryTeam: c.secondaryTeam
            }));

        // Combine with any existing hybrid workers from UI
        const allHybridWorkers = [...hybridWorkers, ...scheduledHybridWorkers];

        // Use the combined list
        hybridWorkers = allHybridWorkers;

        if (teamMemberChanges.length > 0) {
            const newHires = teamMemberChanges.filter(c => c.type === 'Starts');
            const normalHires = newHires.filter(h => !h.isHybrid);
            const hybridHires = newHires.filter(h => h.isHybrid);

            if (normalHires.length > 0) {
                logs.push(`  New specialist hires: ${normalHires.map(h => `${h.name} (${h.date})`).join(', ')}`);
            }
            if (hybridHires.length > 0) {
                logs.push(`  New hybrid hires: ${hybridHires.map(h => `${h.name} (${h.date}) - Primary: ${h.team}, Secondary: ${h.secondaryTeam || 'N/A'}`).join(', ')}`);
            }
        }
        updateProgress(15, 'Initializing simulation parameters...');
        const holidayList = new Set(params.holidays.split(',').map(d => d.trim()).filter(Boolean));
        const ptoMap = ptoEntries.reduce((acc, curr) => { if (curr.date && curr.memberName) { if (!acc[curr.date]) acc[curr.date] = new Set(); acc[curr.date].add(curr.memberName.trim()); } return acc; }, {});
        const teamMapping = teamDefs.mapping;
        let teamHeadcounts = teamDefs.headcounts.reduce((acc, t) => ({...acc, [t.name]: t.count}), {});
        const teamsToIgnoreList = params.teamsToIgnore.split(',').map(t => t.trim());

        let all_tasks_with_teams = tasksWithOverrides.map(row => ({...row}));
        all_tasks_with_teams = assignTeams(all_tasks_with_teams, teamMapping);

        const skuValueMap = all_tasks_with_teams.reduce((acc, task) => {
            const key = `${task.Project}|${task.SKU}`;
            const value = parseFloat(String(task.Value).replace(/,/g, '')) || 0;
            if (!acc[key] || value > acc[key]) {
                acc[key] = value;
            }
            return acc;
        }, {});

        const allOriginalSkuKeys = new Set(all_tasks_with_teams.map(task => `${task.Project}|${task.SKU}`));
        let operations_df = all_tasks_with_teams.filter(row => !teamsToIgnoreList.includes(row.Team));
        const schedulableSkuKeys = new Set(operations_df.map(task => `${task.Project}|${task.SKU}`));
        const fullyIgnoredSkuKeys = [...allOriginalSkuKeys].filter(key => !schedulableSkuKeys.has(key));
        let finalCompletions = [];

        if (fullyIgnoredSkuKeys.length > 0) {
            logs.push(`Found ${fullyIgnoredSkuKeys.length} SKUs consisting entirely of ignored operations. Recognizing their value immediately.`);
            fullyIgnoredSkuKeys.forEach(skuKey => {
                const originalTask = all_tasks_with_teams.find(task => `${task.Project}|${task.SKU}` === skuKey);
                if (originalTask) {
                    finalCompletions.push({
                        completionDate: parseDate(originalTask.StartDate),
                        value: skuValueMap[skuKey] || 0,
                        Project: originalTask.Project,
                        Store: originalTask.Store,
                        SKU: originalTask.SKU,
                        'SKU Name': originalTask['SKU Name']
                    });
                }
            });
        }
        
        operations_df = calculateBasePriority(operations_df, teamDefs.headcounts);
        
        operations_df = operations_df.map(row => ({
            ...row,
            DueDate: parseDate(row.DueDate),
            StartDate: parseDate(row.StartDate)
        }));
        
        const skuMaxOrderMap = operations_df.reduce((acc, task) => {
            if (!acc[task.SKU] || task.Order > acc[task.SKU]) {
                acc[task.SKU] = task.Order;
            }
            return acc;
        }, {});

        operations_df = operations_df.map((row, index) => ({...row, TaskID: index, HoursRemaining: row['Estimated Hours'], AssignedTo: null }))
            .sort((a,b) => (a.Project || '').localeCompare(b.Project || '') || (a.SKU || '').localeCompare(b.SKU || '') || a.Order - b.Order);
        // =========================================================
        // START NEW LOGIC: Global Transition Buffer
        // =========================================================
        const globalBufferPercent = (parseFloat(params.globalBuffer) || 0) / 100;

        operations_df.forEach(task => {
        // Calculate buffer dynamically
        let calculatedBuffer = task['Estimated Hours'] * globalBufferPercent;
        task.LagAfterHours = calculatedBuffer;
        });
        // =========================================================
        // END NEW LOGIC
        // =========================================================

        const schedulableTasksMap = new Map();
        operations_df.forEach(task => {
            const key = `${task.Project}|${task.SKU}`;
            if (!schedulableTasksMap.has(key)) schedulableTasksMap.set(key, []);
            schedulableTasksMap.get(key).push(task);
        });

        let unscheduled_tasks = [...operations_df];
        const totalWorkloadHours = unscheduled_tasks.reduce((sum, task) => sum + task['Estimated Hours'], 0);
        let totalHoursCompleted = 0;
        let current_date = parseDate(params.startDate);
        let daily_log_entries = [], completed_operations = [];
        logs.push(`Starting with ${unscheduled_tasks.length} schedulable tasks.`);
        let loopCounter = 0; const maxDays = 365 * 2;
        let workDayCounter = 0;
        let dailyDwellingData = {};
        let lastCompletedCount = 0;
        let stallDays = 0;
        const MAX_STALL_WORK_DAYS = 30; // Break out if no tasks complete for 30 work days

        // Overtime tracking: max 3 months, then 1 month cooldown
        const overtimeTracking = {}; // { team: { startDate, endDate, inCooldown, cooldownEndDate } }
        const MAX_OVERTIME_DAYS = 90; // 3 months
        const COOLDOWN_DAYS = 30; // 1 month

        const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

        while(unscheduled_tasks.length > 0 && loopCounter < maxDays) {
            const dayOfWeek = current_date.getDay();
            const currentDateStr = formatDate(current_date);
            if (dayOfWeek === 6 || dayOfWeek === 0 || holidayList.has(currentDateStr)) {
                current_date.setDate(current_date.getDate() + 1);
                loopCounter++;
                continue;
            }
            workDayCounter++;

            // --- MODIFIED SECTION ---
            // Replaced the original isReady function with one that understands LagAfterHours.
            const isReady = (task) => {
                if (current_date < task.StartDate) return false;

                const key = `${task.Project}|${task.SKU}`;
                const allSkuTasks = schedulableTasksMap.get(key) || [];
                const predecessors = allSkuTasks.filter(t => t.Order < task.Order);

                if (predecessors.length === 0) {
                    return true; // First operation is always ready if after start date
                }

                return predecessors.every(p => {
                    const completedPredecessor = completed_operations.find(c => c.TaskID === p.TaskID);
                    if (!completedPredecessor) {
                        return false; // Predecessor isn't done yet
                    }

                    // Predecessor is done, now check for lag time.
                    const lagHours = p.LagAfterHours || 0;
                    if (lagHours === 0) {
                        return true; // No lag, so it's ready
                    }
                    
                    const hoursPerWorkDay = parseFloat(params.hoursPerDay) || 8;
                    const lagInDays = lagHours / hoursPerWorkDay;
                    
                    const completionDate = new Date(completedPredecessor.CompletionDate);
                    const readyDate = new Date(completionDate.getTime());
                    readyDate.setDate(readyDate.getDate() + Math.ceil(lagInDays));

                    return current_date >= readyDate;
                });
            };
            // --- END MODIFICATION ---

            const ready_tasks_for_dwelling_check = unscheduled_tasks.filter(isReady);
            const dwellingHoursToday = {};
            ready_tasks_for_dwelling_check.forEach(task => {
                if (!dwellingHoursToday[task.Team]) {
                    dwellingHoursToday[task.Team] = 0;
                }
                dwellingHoursToday[task.Team] += task.HoursRemaining;
            });
            dailyDwellingData[currentDateStr] = dwellingHoursToday;

            unscheduled_tasks.forEach(task => {
                const daysUntilDue = (task.DueDate - current_date) / (1000 * 60 * 60 * 24);
                let dueDateMultiplier;
                if (daysUntilDue < 0) {
                    dueDateMultiplier = 100 * Math.pow(1.1, -daysUntilDue);
                } else {
                    dueDateMultiplier = 1 + (60 / (daysUntilDue + 1));
                }
                task.DynamicPriority = (task.BasePriority * dueDateMultiplier) / task.TeamCapacity;
            });

            const dailyRoster = {};
            Object.keys(teamHeadcounts).forEach(team => {
                dailyRoster[team] = new Set();
                const headcount = teamHeadcounts[team] || 0;
                for(let i=0; i < Math.floor(headcount); i++) {
                    dailyRoster[team].add(`${team.replace(/\s/g, '')}${i+1}`);
                }
            });

            // Debug: Log roster before team member changes
            let rosterBeforeChanges = {};
            Object.keys(dailyRoster).forEach(team => {
                rosterBeforeChanges[team] = dailyRoster[team].size;
            });

            teamMemberChanges.forEach(change => {
                if(currentDateStr >= change.date) {
                    if(!dailyRoster[change.team]) dailyRoster[change.team] = new Set();
                    if(change.type === 'Starts') {
                        dailyRoster[change.team].add(change.name);
                        if (currentDateStr === change.date) {
                            logs.push(`${currentDateStr}: 👷 ${change.name} joined ${change.team} team`);
                        }
                    } else {
                        dailyRoster[change.team].delete(change.name);
                    }
                }
            });

            // Debug: Log roster size changes on first day with changes
            if (current_date.toISOString().split('T')[0] === params.startDate && teamMemberChanges.length > 0) {
                logs.push(`\n--- Daily Roster on ${currentDateStr} ---`);
                Object.keys(dailyRoster).forEach(team => {
                    const before = rosterBeforeChanges[team] || 0;
                    const after = dailyRoster[team].size;
                    if (before !== after) {
                        logs.push(`  ${team}: ${before} → ${after} members`);
                        logs.push(`    Members: ${Array.from(dailyRoster[team]).join(', ')}`);
                    }
                });
            }
            hybridWorkers.forEach(h => {
                if (!dailyRoster[h.primaryTeam]) dailyRoster[h.primaryTeam] = new Set();
                dailyRoster[h.primaryTeam].add(h.name);
            });
            const dailyHoursMap = {};
            Object.keys(dailyRoster).forEach(team => {
                let hours = parseFloat(params.hoursPerDay);
                const override = workHourOverrides.find(o => o.team === team && currentDateStr >= o.startDate && currentDateStr <= o.endDate);

                // Check overtime constraints
                const isOvertime = override && parseFloat(override.hours) > parseFloat(params.hoursPerDay);
                const currentDate = parseDate(currentDateStr);

                if (isOvertime) {
                    // Initialize tracking for this team if needed
                    if (!overtimeTracking[team]) {
                        overtimeTracking[team] = { startDate: null, endDate: null, inCooldown: false, cooldownEndDate: null };
                    }

                    const tracking = overtimeTracking[team];

                    // Check if in cooldown period
                    if (tracking.inCooldown && tracking.cooldownEndDate) {
                        const cooldownEnd = parseDate(tracking.cooldownEndDate);
                        if (currentDate < cooldownEnd) {
                            // Still in cooldown - cannot use overtime
                            hours = parseFloat(params.hoursPerDay);
                            const daysRemaining = Math.ceil((cooldownEnd - currentDate) / (1000 * 60 * 60 * 24));
                            if (currentDateStr === override.startDate) {
                                logs.push(`${currentDateStr}: ⚠️ ${team} overtime blocked - in cooldown for ${daysRemaining} more days (ends ${tracking.cooldownEndDate})`);
                            }
                        } else {
                            // Cooldown ended - can start new overtime period
                            tracking.inCooldown = false;
                            tracking.cooldownEndDate = null;
                            tracking.startDate = currentDateStr;
                            tracking.endDate = null;
                            hours = parseFloat(override.hours);
                            logs.push(`${currentDateStr}: ⏰ ${team} starting overtime (${hours}hrs/day) until ${override.endDate} - cooldown complete`);
                        }
                    } else {
                        // Not in cooldown - check if we're starting or continuing overtime
                        if (!tracking.startDate) {
                            // Starting new overtime period
                            tracking.startDate = currentDateStr;
                            tracking.endDate = null;
                            hours = parseFloat(override.hours);
                            logs.push(`${currentDateStr}: ⏰ ${team} starting overtime (${hours}hrs/day) until ${override.endDate}`);
                        } else {
                            // Continuing overtime - check duration
                            const overtimeStart = parseDate(tracking.startDate);
                            const daysSinceStart = Math.floor((currentDate - overtimeStart) / (1000 * 60 * 60 * 24));

                            if (daysSinceStart >= MAX_OVERTIME_DAYS) {
                                // Exceeded 3-month limit - end overtime and start cooldown
                                if (!tracking.endDate) {
                                    tracking.endDate = currentDateStr;
                                    tracking.inCooldown = true;
                                    const cooldownEnd = new Date(currentDate);
                                    cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_DAYS);
                                    tracking.cooldownEndDate = formatDate(cooldownEnd);
                                    logs.push(`${currentDateStr}: 🛑 ${team} overtime limit reached (${MAX_OVERTIME_DAYS} days) - starting ${COOLDOWN_DAYS}-day cooldown until ${tracking.cooldownEndDate}`);
                                }
                                hours = parseFloat(params.hoursPerDay);
                            } else {
                                // Within limit - continue overtime
                                hours = parseFloat(override.hours);
                            }
                        }
                    }
                } else {
                    // Not overtime or no override - check if we need to end an overtime period
                    if (overtimeTracking[team] && overtimeTracking[team].startDate && !overtimeTracking[team].endDate) {
                        const tracking = overtimeTracking[team];
                        const overtimeStart = parseDate(tracking.startDate);
                        const daysSinceStart = Math.floor((currentDate - overtimeStart) / (1000 * 60 * 60 * 24));

                        // Overtime ended naturally before 3-month limit
                        tracking.endDate = currentDateStr;

                        if (daysSinceStart >= MAX_OVERTIME_DAYS) {
                            // Was at limit - start cooldown
                            tracking.inCooldown = true;
                            const cooldownEnd = new Date(currentDate);
                            cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_DAYS);
                            tracking.cooldownEndDate = formatDate(cooldownEnd);
                            logs.push(`${currentDateStr}: 📅 ${team} overtime ended after ${daysSinceStart} days - starting ${COOLDOWN_DAYS}-day cooldown until ${tracking.cooldownEndDate}`);
                        } else {
                            // Ended early - no cooldown required
                            tracking.startDate = null;
                            tracking.endDate = null;
                        }
                    }

                    if (override) {
                        hours = parseFloat(override.hours);
                    }
                }

                dailyHoursMap[team] = hours;
            });
            const daily_capacity = {};
            for (const team_name in dailyRoster) {
                daily_capacity[team_name] = [];
                dailyRoster[team_name].forEach(memberName => {
                    if (!ptoMap[currentDateStr] || !ptoMap[currentDateStr].has(memberName)) {
                         const schedulableHours = dailyHoursMap[team_name] * params.productivityAssumption;
                         daily_capacity[team_name].push({ TeamMember: memberName, SchedulableHoursLeft: schedulableHours });
                    }
                });
                const teamHeadcount = teamHeadcounts[team_name] || 0;
                if (teamHeadcount > Math.floor(teamHeadcount)) {
                    const fractionalHeadcount = teamHeadcount % 1;
                    const schedulableHours = (dailyHoursMap[team_name] || params.hoursPerDay) * params.productivityAssumption * fractionalHeadcount;
                    daily_capacity[team_name].push({ TeamMember: `${team_name}-fractional`, SchedulableHoursLeft: schedulableHours });
                }
            }

            let skus_being_worked_on_today = new Set();
            let more_work_to_assign_today = true;

            while (more_work_to_assign_today) {
                more_work_to_assign_today = false;
                const ready_tasks = unscheduled_tasks.filter(isReady).sort((a,b) => b.DynamicPriority - a.DynamicPriority);

                if (ready_tasks.length > 0) {
                    for (const team_name in daily_capacity) {
                        const available_members = daily_capacity[team_name]?.filter(m => m.SchedulableHoursLeft > 0.01);
                        const availableHybrids = hybridWorkers
                            .filter(h => h.secondaryTeam === team_name)
                            .map(h => daily_capacity[h.primaryTeam]?.find(m => m.TeamMember === h.name && m.SchedulableHoursLeft > 0.01))
                            .filter(Boolean);
                        const fullRoster = [...(available_members || []), ...availableHybrids];

                        if (fullRoster.length > 0) {
                            for (const member of fullRoster) {
                                if (member.SchedulableHoursLeft <= 0.01) continue;
                                const member_team = hybridWorkers.find(h => h.name === member.TeamMember)?.secondaryTeam === team_name ? team_name : hybridWorkers.find(h => h.name === member.TeamMember)?.primaryTeam || team_name;
                                let task_to_assign = null;
                                const team_ready_tasks = ready_tasks.filter(t => t.Team === member_team);
                                const continuation_task = team_ready_tasks.find(t => t.AssignedTo === member.TeamMember);
                                if (continuation_task) {
                                    task_to_assign = continuation_task;
                                } else {
                                    let new_task = team_ready_tasks.find(t => !t.AssignedTo && !skus_being_worked_on_today.has(t.SKU));
                                    if (!new_task) new_task = team_ready_tasks.find(t => !t.AssignedTo);
                                    if (new_task) {
                                        task_to_assign = new_task;
                                        unscheduled_tasks.find(t => t.TaskID === task_to_assign.TaskID).AssignedTo = member.TeamMember;
                                    }
                                }
                                if (task_to_assign) {
                                    const member_for_task = task_to_assign.AssignedTo || member.TeamMember;
                                    const hybridInfo = hybridWorkers.find(h => h.name === member_for_task);
                                    const capacityPool = hybridInfo ? daily_capacity[hybridInfo.primaryTeam] : daily_capacity[team_name];
                                    const memberInPool = capacityPool?.find(m => m.TeamMember === member_for_task);
                                    if (memberInPool && memberInPool.SchedulableHoursLeft > 0.01) {
                                        const individualEfficiency = efficiencyData[member_for_task] || 1.0;
                                        const effective_hours_left_for_member = memberInPool.SchedulableHoursLeft * individualEfficiency;
                                        const task_hours_to_complete = Math.min(task_to_assign.HoursRemaining, effective_hours_left_for_member);
                                        if (task_hours_to_complete > 0.001) {
                                            const time_to_spend_on_task = task_hours_to_complete / individualEfficiency;
                                            const teamHoursPerDay = dailyHoursMap[member_team] || params.hoursPerDay;
                                            daily_log_entries.push({ ...task_to_assign, Date: currentDateStr, 'Task Hours Completed': Number(task_hours_to_complete.toFixed(2)), 'Time Spent (Hours)': Number(time_to_spend_on_task.toFixed(2)), TeamMember: member_for_task, TeamMemberName: teamMemberNameMap[member_for_task] || member_for_task, 'Hours Per Day': teamHoursPerDay });
                                            skus_being_worked_on_today.add(task_to_assign.SKU);
                                            const taskInArray = unscheduled_tasks.find(t => t.TaskID === task_to_assign.TaskID);
                                            taskInArray.HoursRemaining -= task_hours_to_complete;
                                            memberInPool.SchedulableHoursLeft -= time_to_spend_on_task;
                                            
                                            totalHoursCompleted += task_hours_to_complete;

                                            if (taskInArray.HoursRemaining <= 0.01) {
                                                completed_operations.push({ Project: task_to_assign.Project, SKU: task_to_assign.SKU, Order: task_to_assign.Order, TaskID: task_to_assign.TaskID, CompletionDate: new Date(current_date) });
                                                if (taskInArray.Order === skuMaxOrderMap[taskInArray.SKU]) {
                                                    const skuKey = `${taskInArray.Project}|${taskInArray.SKU}`;
                                                    const finalSkuValue = skuValueMap[skuKey] || 0;
                                                    finalCompletions.push({ completionDate: new Date(current_date), value: finalSkuValue, Project: taskInArray.Project, Store: taskInArray.Store, SKU: taskInArray.SKU, 'SKU Name': taskInArray['SKU Name'] });
                                                }
                                            }
                                            more_work_to_assign_today = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                unscheduled_tasks = unscheduled_tasks.filter(t => t.HoursRemaining > 0.01);
            }

            // Stall detection: break early if no tasks have completed in MAX_STALL_WORK_DAYS
            const currentCompletedCount = completed_operations.length;
            if (currentCompletedCount > lastCompletedCount) {
                lastCompletedCount = currentCompletedCount;
                stallDays = 0;
            } else {
                stallDays++;
            }
            if (stallDays >= MAX_STALL_WORK_DAYS) {
                logs.push(`\n⚠️ Schedule stalled: No tasks completed in ${MAX_STALL_WORK_DAYS} work days. ${unscheduled_tasks.length} tasks remain unschedulable.`);
                unscheduled_tasks.forEach(t => {
                    logs.push(`  - Stuck: ${t.Project} | ${t.SKU} | ${t.Operation} (Team: ${t.Team}, Hours Remaining: ${t.HoursRemaining.toFixed(1)})`);
                });
                break;
            }

            if (loopCounter % 5 === 0) {
                const progress = 15 + Math.round((totalHoursCompleted / totalWorkloadHours) * 75);
                updateProgress(progress, `Simulating Work Day ${workDayCounter}...`);
                await yieldToEventLoop();
            }

            current_date.setDate(current_date.getDate() + 1);
            loopCounter++;
        }
        
        updateProgress(90, 'Finalizing results...');

        // Track work by team member to see if new hires did anything
        const workByMember = {};
        daily_log_entries.forEach(log => {
            if (!workByMember[log.TeamMember]) {
                workByMember[log.TeamMember] = { hours: 0, tasks: 0 };
            }
            workByMember[log.TeamMember].hours += log['Time Spent (Hours)'];
            workByMember[log.TeamMember].tasks++;
        });

        // Log work by new hires
        const newHireNames = new Set(teamMemberChanges.filter(c => c.type === 'Starts').map(c => c.name));
        if (newHireNames.size > 0) {
            logs.push(`\n--- Work Completed by New Hires ---`);
            newHireNames.forEach(name => {
                const work = workByMember[name];
                if (work) {
                    logs.push(`  ${name}: ${work.tasks} tasks, ${work.hours.toFixed(1)} hours`);
                } else {
                    logs.push(`  ${name}: NO WORK ASSIGNED`);
                }
            });
        }

        const projectSummaryMap = {};
        daily_log_entries.forEach(log => {
            const proj = log.Project;
            if (!projectSummaryMap[proj]) {
                projectSummaryMap[proj] = { Project: proj, Store: log.Store, StartDate: parseDate(log.Date), FinishDate: parseDate(log.Date), DueDate: log.DueDate };
            } else {
                if (parseDate(log.Date) < projectSummaryMap[proj].StartDate) projectSummaryMap[proj].StartDate = parseDate(log.Date);
                if (log.DueDate > projectSummaryMap[proj].DueDate) projectSummaryMap[proj].DueDate = log.DueDate;
            }
        });
        completed_operations.forEach(op => { if (projectSummaryMap[op.Project] && op.CompletionDate > projectSummaryMap[op.Project].FinishDate) projectSummaryMap[op.Project].FinishDate = op.CompletionDate; });

        const projectSummary = Object.values(projectSummaryMap).map(p => ({...p, StartDate: formatDate(p.StartDate), FinishDate: formatDate(p.FinishDate), DueDate: formatDate(p.DueDate) }));
        const finalSchedule = daily_log_entries.map(log => ({...log, StartDate: formatDate(log.StartDate), DueDate: formatDate(log.DueDate)}));
        const projectedCompletion = projectSummary.length > 0 ? formatDate(projectSummary.reduce((max, p) => p.FinishDate > max ? p.FinishDate : max, new Date(0))) : null;

        const dailyCompletions = finalCompletions.map(item => ({ Date: formatDate(item.completionDate), Job: item.Project, Store: item.Store, SKU: item.SKU, 'SKU Name': item['SKU Name'], Value: item.value })).sort((a,b) => new Date(a.Date) - new Date(b.Date));
        const weeklyValueMap = finalCompletions.reduce((acc, item) => { const weekStart = formatDate(getWeekStartDate(item.completionDate)); if (!acc[weekStart]) acc[weekStart] = 0; acc[weekStart] += item.value; return acc; }, {});
        const dailyWorkersMap = daily_log_entries.reduce((acc, log) => { const date = log.Date; if (!acc[date]) acc[date] = new Set(); acc[date].add(log.TeamMember); return acc; }, {});
        const weeklyPaidHoursMap = Object.entries(dailyWorkersMap).reduce((acc, [date, membersSet]) => { const weekStart = formatDate(getWeekStartDate(parseDate(date))); if (!acc[weekStart]) acc[weekStart] = 0; acc[weekStart] += membersSet.size * parseFloat(params.hoursPerDay); return acc; }, {});
        const allWeeks = new Set([...Object.keys(weeklyValueMap), ...Object.keys(weeklyPaidHoursMap)]);
        const weeklyOutput = Array.from(allWeeks).map(week => { const totalValue = weeklyValueMap[week] || 0; const totalHoursWorked = weeklyPaidHoursMap[week] || 0; const valuePerHour = totalHoursWorked > 0 ? totalValue / totalHoursWorked : 0; return { week, totalValue, totalHoursWorked, valuePerHour }; }).sort((a, b) => new Date(a.week) - new Date(b.week));

        const weeklyUtil = {};
        const hybridWorkerNames = new Set(hybridWorkers.map(h => h.name));
        daily_log_entries.forEach(log => {
            const weekStart = formatDate(getWeekStartDate(parseDate(log.Date)));
            if (!weeklyUtil[weekStart]) weeklyUtil[weekStart] = {};
            const timeSpent = log['Time Spent (Hours)'];
            const taskHours = log['Task Hours Completed'];
            if (hybridWorkerNames.has(log.TeamMember)) {
                const hybridTeamName = 'Hybrid';
                if (!weeklyUtil[weekStart][hybridTeamName]) weeklyUtil[weekStart][hybridTeamName] = { worked: 0, capacity: 0, breakdown: {} };
                weeklyUtil[weekStart][hybridTeamName].worked += timeSpent;
                const targetTeam = log.Team;
                if (!weeklyUtil[weekStart][hybridTeamName].breakdown[targetTeam]) weeklyUtil[weekStart][hybridTeamName].breakdown[targetTeam] = 0;
                weeklyUtil[weekStart][hybridTeamName].breakdown[targetTeam] += taskHours;
            } else {
                const teamName = log.Team;
                if (!weeklyUtil[weekStart][teamName]) weeklyUtil[weekStart][teamName] = { worked: 0, capacity: 0 };
                weeklyUtil[weekStart][teamName].worked += timeSpent;
            }
        });

        const allTeamNames = teamDefs.headcounts.map(h => h.name);
        const weeklyCapacityMap = {};
        const allWeeksForCapacity = new Set(Object.keys(weeklyUtil).concat(Object.keys(dailyDwellingData).map(d => formatDate(getWeekStartDate(parseDate(d))))));
        for (const week of Array.from(allWeeksForCapacity).sort()) {
            const weekStartDate = parseDate(week);
            weeklyCapacityMap[week] = {};
            let weeklyHybridCapacity = 0;
            for (let i = 0; i < 5; i++) {
                const day = new Date(weekStartDate); day.setDate(day.getDate() + i + (day.getDay() === 6 ? 2 : day.getDay() === 0 ? 1 : 0));
                const dayStr = formatDate(day); if (holidayList.has(dayStr)) continue;
                hybridWorkers.forEach(h => {
                    const ptoForDay = ptoMap[dayStr] || new Set();
                    if (!ptoForDay.has(h.name)) {
                        let hours = parseFloat(params.hoursPerDay);
                        const override = workHourOverrides.find(o => o.team === h.primaryTeam && dayStr >= o.startDate && dayStr <= o.endDate);
                        if (override) hours = parseFloat(override.hours);
                        weeklyHybridCapacity += hours;
                    }
                });
            }
            if (weeklyUtil[week] && weeklyUtil[week]['Hybrid']) weeklyUtil[week]['Hybrid'].capacity = weeklyHybridCapacity;
            weeklyCapacityMap[week]['Hybrid'] = weeklyHybridCapacity;

            for (const teamName of allTeamNames) {
                if (teamsToIgnoreList.includes(teamName)) continue;
                let weeklyCapacity = 0;
                 for(let i=0; i<5; i++){
                    const day = new Date(weekStartDate); day.setDate(day.getDate() + i + (day.getDay() === 6 ? 2 : day.getDay() === 0 ? 1 : 0));
                    const dayStr = formatDate(day); if(holidayList.has(dayStr)) continue;
                    let currentHours = parseFloat(params.hoursPerDay);
                    const override = workHourOverrides.find(o => o.team === teamName && dayStr >= o.startDate && dayStr <= o.endDate);
                    if (override) currentHours = parseFloat(override.hours);
                    let dailyHeadcount = teamDefs.headcounts.find(h => h.name === teamName)?.count || 0;
                    const ptoForDay = ptoMap[dayStr] || new Set();
                    const rosterOnDay = new Set();
                    for(let h=0; h < Math.floor(dailyHeadcount); h++) rosterOnDay.add(`${teamName.replace(/\s/g, '')}${h+1}`);
                    teamMemberChanges.forEach(c => { if(c.team === teamName && dayStr >= c.date && !hybridWorkerNames.has(c.name)) { if (c.type === 'Starts') rosterOnDay.add(c.name); else rosterOnDay.delete(c.name); } });
                    const workingHeadcount = Array.from(rosterOnDay).filter(m => !ptoForDay.has(m)).length;
                    const fractionalHeadcount = dailyHeadcount % 1;
                    weeklyCapacity += (workingHeadcount + fractionalHeadcount) * currentHours;
                }
                if(weeklyUtil[week] && !weeklyUtil[week][teamName]) weeklyUtil[week][teamName] = { worked: 0 };
                if(weeklyUtil[week]) weeklyUtil[week][teamName].capacity = weeklyCapacity;
                weeklyCapacityMap[week][teamName] = weeklyCapacity;
            }
        }
        const teamUtilization = Object.keys(weeklyUtil).sort().map(week => { const teamsForWeek = Object.keys(weeklyUtil[week]).map(teamName => ({ name: teamName, worked: (weeklyUtil[week][teamName].worked || 0).toFixed(1), capacity: (weeklyUtil[week][teamName].capacity || 0).toFixed(1), utilization: Math.round(weeklyUtil[week][teamName].capacity > 0 ? ((weeklyUtil[week][teamName].worked || 0) / weeklyUtil[week][teamName].capacity) * 100 : 0), breakdown: weeklyUtil[week][teamName].breakdown })); return { week, teams: teamsForWeek }; });
        
        const weeklyDwellingBacklog = {};
        const processedWeeks = new Set();
        const sortedDates = Object.keys(dailyDwellingData).sort((a,b) => new Date(a) - new Date(b));

        for(const dateStr of sortedDates) {
            const date = parseDate(dateStr);
            const weekStart = formatDate(getWeekStartDate(date));
            if (!processedWeeks.has(weekStart)) {
                const dayOfWeek = date.getDay();
                if (dayOfWeek >= 1 && dayOfWeek <= 5) {
                    weeklyDwellingBacklog[weekStart] = dailyDwellingData[dateStr];
                    processedWeeks.add(weekStart);
                }
            }
        }

        const teamWorkload = Object.keys(weeklyDwellingBacklog).sort().map(week => {
            const teamsWithDwelling = weeklyDwellingBacklog[week];
            const allTeamNamesForWeek = new Set([...allTeamNames, ...Object.keys(teamsWithDwelling)]);
            const teams = Array.from(allTeamNamesForWeek).map(teamName => {
                const dwellingHours = teamsWithDwelling[teamName] || 0;
                const capacity = weeklyCapacityMap[week]?.[teamName] || 0;
                return { name: teamName, workloadRatio: capacity > 0 ? (dwellingHours / capacity) * 100 : 0 };
            }).sort((a, b) => {
                const indexA = TEAM_SORT_ORDER.indexOf(a.name);
                const indexB = TEAM_SORT_ORDER.indexOf(b.name);
                if (indexA === -1) return 1;
                if (indexB === -1) return -1;
                return indexA - indexB;
            });
            return { week, teams };
        });
        
        return {
            finalSchedule,
            projectSummary,
            taskSummary: finalSchedule, // Add taskSummary for bottleneck detection
            teamUtilization,
            weeklyOutput,
            dailyCompletions,
            teamWorkload,

            projectedCompletion,
            logs,
            error
        };

    } catch (e) {
        console.error("Critical error in scheduling engine:", e);
        logs.push(`Critical Error: ${e.message}`);
        return { error: `A critical error occurred on the server: ${e.message}`, logs };
    }
};
// --- Resource Optimization Algorithm ---
const optimizeResources = async (
    projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
    workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
    startDateOverrides, endDateOverrides, optimizationConfig, updateProgress
) => {
    const logs = [];
    logs.push("--- Starting Resource Optimization ---");

    const {
        targetDeadlineBuffer = 0, // Days of buffer before due date (positive = early)
        maxIterations = 20,
        budgetLimit = Infinity,
        maxHeadcount = {},
        allowHiring = true,
        allowOvertime = false,
        maxOvertimeHours = 2,
        costPerHour = 25, // Base hourly rate
        overtimeMultiplier = 1.5,
    } = optimizationConfig;

    // Define reasonable default max hires per team (can be overridden in optimizationConfig.maxHeadcount)
    const defaultMaxHires = {
        'Paint': 12,
        'Scenic': 8,
        'CNC': 8,
        'Metal': 6,
        'Carpentry': 10,
        'Assembly': 10,
        'Tech': 8,
        'default': 8  // Fallback for any team not listed
    };

    // Merge user-provided maxHeadcount with defaults (maxHeadcount = max hires allowed, not max team size)
    const effectiveMaxHeadcount = {};
    teamDefs.headcounts.forEach(team => {
        effectiveMaxHeadcount[team.name] = maxHeadcount[team.name] || defaultMaxHires[team.name] || defaultMaxHires.default;
    });

    let currentTeamDefs = JSON.parse(JSON.stringify(teamDefs)); // Deep copy
    let iteration = 0;
    let bestSolution = null;
    let bestCost = Infinity;
    let totalAdditionalCost = 0;
    
    const originalHeadcounts = {};
    teamDefs.headcounts.forEach(t => {
        originalHeadcounts[t.name] = t.count;
    });

    const allChanges = [];

    while (iteration < maxIterations) {
        logs.push(`\n--- Iteration ${iteration + 1} ---`);
        updateProgress(
            10 + Math.round((iteration / maxIterations) * 80),
            `Optimization iteration ${iteration + 1} of ${maxIterations}...`,
            'optimizing'
        );

        // Run scheduler with current resource configuration
        const { tasks: preparedTasks } = await prepareProjectData(projectTasks, () => {});
        
        const results = await runSchedulingEngine(
            preparedTasks, params, currentTeamDefs, ptoEntries, teamMemberChanges,
            workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
            startDateOverrides, endDateOverrides,
            () => {} // Silent progress updates during optimization
        );

        if (results.error) {
            logs.push(`Iteration ${iteration + 1} failed: ${results.error}`);
            break;
        }

        // Analyze results - check if all projects meet target deadlines
        const gaps = [];
        results.projectSummary.forEach(project => {
            const finishDate = parseDate(project.FinishDate);
            const targetDueDate = parseDate(endDateOverrides[project.Project] || project.DueDate);
            
            if (!finishDate || !targetDueDate) return;
            
            // Calculate days difference (negative = late)
            const daysFromTarget = Math.round((targetDueDate.getTime() - finishDate.getTime()) / (1000 * 60 * 60 * 24));
            const requiredBuffer = targetDeadlineBuffer;
            
            if (daysFromTarget < requiredBuffer) {
                const daysLate = requiredBuffer - daysFromTarget;
                gaps.push({
                    project: project.Project,
                    daysLate: daysLate,
                    finishDate: project.FinishDate,
                    targetDate: project.DueDate
                });
            }
        });

        // Check if we've achieved the goal
        if (gaps.length === 0) {
            logs.push(`✓ SUCCESS: All projects meet target deadlines with ${targetDeadlineBuffer}-day buffer!`);
            bestSolution = {
                teamDefs: currentTeamDefs,
                schedule: results,
                gaps: [],
                changes: allChanges,
                totalCost: totalAdditionalCost,
                iterations: iteration + 1
            };
            break;
        }

        logs.push(`Found ${gaps.length} projects missing target deadline:`);
        gaps.forEach(gap => {
            logs.push(`  - ${gap.project}: ${gap.daysLate} days late`);
        });

        // Identify bottleneck teams from workload data
        const bottleneckTeams = identifyBottlenecks(results.teamWorkload, results.teamUtilization);
        logs.push(`Identified bottleneck teams: ${bottleneckTeams.map(b => `${b.team} (${b.severity.toFixed(0)}% overload)`).join(', ')}`);

        if (bottleneckTeams.length === 0) {
            logs.push("No clear bottlenecks identified. Optimization cannot proceed further.");
            break;
        }

        // Propose and apply adjustments
        const adjustment = proposeAdjustment(
            bottleneckTeams,
            currentTeamDefs,
            { allowHiring, allowOvertime, maxOvertimeHours, maxHeadcount: effectiveMaxHeadcount, costPerHour, budgetLimit: budgetLimit - totalAdditionalCost }
        );

        if (!adjustment) {
            logs.push("No viable adjustments available within constraints.");
            break;
        }

        logs.push(`Applying adjustment: ${adjustment.description}`);
        currentTeamDefs = applyAdjustment(currentTeamDefs, adjustment);
        allChanges.push(adjustment);
        totalAdditionalCost += adjustment.cost;

        // Store this as best solution so far if it improved
        if (gaps.length < (bestSolution?.gaps.length || Infinity)) {
            bestSolution = {
                teamDefs: currentTeamDefs,
                schedule: results,
                gaps: gaps,
                changes: allChanges,
                totalCost: totalAdditionalCost,
                iterations: iteration + 1
            };
            bestCost = totalAdditionalCost;
        }

        iteration++;
    }

    if (!bestSolution) {
        return {
            success: false,
            error: "Could not find a viable solution within constraints.",
            logs
        };
    }

    const finalResult = {
        success: bestSolution.gaps.length === 0,
        optimizedTeamDefs: bestSolution.teamDefs,
        schedule: bestSolution.schedule,
        changes: bestSolution.changes,
        totalCost: bestSolution.totalCost,
        iterations: bestSolution.iterations,
        remainingGaps: bestSolution.gaps,
        logs
    };

    updateProgress(95, 'Optimization complete!', 'finalizing');
    return finalResult;
};

// Helper: Identify bottleneck teams from workload data
function identifyBottlenecks(teamWorkload, teamUtilization) {
    const bottlenecks = [];
    const teamOverloadScores = {};

    // Analyze workload ratios (demand vs capacity)
    teamWorkload.forEach(weekData => {
        weekData.teams.forEach(team => {
            if (!teamOverloadScores[team.name]) {
                teamOverloadScores[team.name] = { totalOverload: 0, weeks: 0, maxRatio: 0 };
            }
            if (team.workloadRatio > 100) {
                const overload = team.workloadRatio - 100;
                teamOverloadScores[team.name].totalOverload += overload;
                teamOverloadScores[team.name].weeks++;
                teamOverloadScores[team.name].maxRatio = Math.max(teamOverloadScores[team.name].maxRatio, team.workloadRatio);
            }
        });
    });

    // Analyze utilization (actual work done vs capacity)
    teamUtilization.forEach(weekData => {
        weekData.teams.forEach(team => {
            const utilization = parseFloat(team.utilization);
            if (utilization > 95) {
                if (!teamOverloadScores[team.name]) {
                    teamOverloadScores[team.name] = { totalOverload: 0, weeks: 0, maxRatio: 0 };
                }
                // High utilization suggests this team is running at capacity
                teamOverloadScores[team.name].totalOverload += (utilization - 95) * 2; // Weight high utilization
                teamOverloadScores[team.name].weeks++;
            }
        });
    });

    // Sort teams by severity
    const sortedTeams = Object.entries(teamOverloadScores)
        .map(([team, data]) => ({
            team,
            severity: data.totalOverload / Math.max(data.weeks, 1),
            weeksOverloaded: data.weeks,
            maxRatio: data.maxRatio
        }))
        .filter(t => t.severity > 5) // Only significant bottlenecks
        .sort((a, b) => b.severity - a.severity);

    return sortedTeams.slice(0, 3); // Top 3 bottlenecks
}

// Helper: Propose the best adjustment
function proposeAdjustment(bottleneckTeams, currentTeamDefs, constraints) {
    const { allowHiring, maxHeadcount, costPerHour, budgetLimit } = constraints;

    if (!allowHiring || bottleneckTeams.length === 0) return null;

    // Focus on the worst bottleneck
    const worstBottleneck = bottleneckTeams[0];
    const teamName = worstBottleneck.team;
    
    const currentTeam = currentTeamDefs.headcounts.find(t => t.name === teamName);
    if (!currentTeam) return null;

    const currentCount = currentTeam.count;
    const maxHiresAllowed = maxHeadcount[teamName];

    if (!maxHiresAllowed) {
        console.warn(`No max hires defined for team ${teamName}. Skipping hiring recommendation.`);
        return null;
    }

    // Calculate how many people to add based on severity
    // Rule of thumb: For every 50% overload, add 1 person
    const increaseNeeded = Math.max(0.5, Math.ceil(worstBottleneck.severity / 50));
    const proposedIncrease = Math.min(increaseNeeded, maxHiresAllowed);

    if (proposedIncrease < 0.5) return null;

    // Estimate cost (simplified: assume 40 hours/week * 52 weeks * hourly rate / 52 weeks = weekly cost)
    const weeklyCost = proposedIncrease * 40 * costPerHour;
    const totalCost = weeklyCost * worstBottleneck.weeksOverloaded;

    if (totalCost > budgetLimit) {
        // Try to fit within budget
        const affordableIncrease = Math.floor(budgetLimit / (40 * costPerHour * worstBottleneck.weeksOverloaded));
        if (affordableIncrease < 0.5) return null;
        
        return {
            type: 'hire',
            team: teamName,
            amount: affordableIncrease,
            cost: affordableIncrease * 40 * costPerHour * worstBottleneck.weeksOverloaded,
            description: `Add ${affordableIncrease} team member(s) to ${teamName} (budget-limited)`,
            estimatedImpact: `Reduces ${teamName} overload by ~${(affordableIncrease * 50).toFixed(0)}%`
        };
    }

    return {
        type: 'hire',
        team: teamName,
        amount: proposedIncrease,
        cost: totalCost,
        description: `Add ${proposedIncrease} team member(s) to ${teamName}`,
        estimatedImpact: `Reduces ${teamName} overload by ~${(proposedIncrease * 50).toFixed(0)}%`
    };
}

// Helper: Apply adjustment to team definitions
function applyAdjustment(teamDefs, adjustment) {
    const newTeamDefs = JSON.parse(JSON.stringify(teamDefs)); // Deep copy

    if (adjustment.type === 'hire') {
        const team = newTeamDefs.headcounts.find(t => t.name === adjustment.team);
        if (team) {
            team.count += adjustment.amount;
        }
    }

    return newTeamDefs;
}

// =================================================================
// --- MULTI-SCENARIO GENERATOR ---
// =================================================================

// Helper: Identify bottleneck periods from schedule results
// Helper: Get week identifier (YYYY-WW format) - shared utility
function getWeekId(date) {
    const d = new Date(date);
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNum = Math.ceil((((d - yearStart) / 86400000) + yearStart.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function identifyBottlenecks(scheduleResult, baseParams, baseTeamDefs) {
    console.log("=== identifyBottlenecks STARTED ===");
    const bottlenecks = [];

    if (!scheduleResult || !scheduleResult.taskSummary) {
        console.log("No scheduleResult or taskSummary, returning empty bottlenecks");
        return bottlenecks;
    }

    console.log(`Analyzing ${scheduleResult.taskSummary.length} tasks...`);

    // Analyze ALL tasks to find high-utilization periods (not just late projects)
    const teamLoad = {};

    // Group all tasks by team and week
    scheduleResult.taskSummary.forEach(task => {
        if (task.Date && task.Team) {
            const team = task.Team || 'Unknown';
            const workDate = new Date(task.Date);
            const week = getWeekId(workDate);

            if (!teamLoad[team]) teamLoad[team] = {};
            if (!teamLoad[team][week]) {
                teamLoad[team][week] = {
                    count: 0,
                    totalHours: 0,
                    projects: new Set(),
                    tasks: [],
                    weekStart: workDate
                };
            }

            teamLoad[team][week].count++;
            teamLoad[team][week].totalHours += parseFloat(task['Time Spent (Hours)']) || 0;
            teamLoad[team][week].projects.add(task.Project);
            teamLoad[team][week].tasks.push(task);
        }
    });

    // Calculate capacity utilization for each team/week
    Object.entries(teamLoad).forEach(([team, weeks]) => {
        const teamDef = baseTeamDefs.headcounts.find(t => t.name === team);
        if (!teamDef) return;

        const teamSize = teamDef.count;
        const hoursPerDay = baseParams.hoursPerDay || 8;
        const workDaysPerWeek = 5;
        const weeklyCapacity = teamSize * hoursPerDay * workDaysPerWeek;

        const weeksArray = Object.entries(weeks).map(([week, data]) => {
            const utilization = data.totalHours / weeklyCapacity;
            return {
                week,
                ...data,
                utilization,
                capacity: weeklyCapacity
            };
        });

        // Sort by week for consecutive analysis
        weeksArray.sort((a, b) => a.week.localeCompare(b.week));

        // Analyze sustained load patterns
        const avgUtilization = weeksArray.reduce((sum, w) => sum + w.utilization, 0) / weeksArray.length;
        const highLoadWeeks = weeksArray.filter(w => w.utilization > 0.7).length;

        // Detect consecutive high-load periods
        let consecutiveHighLoad = 0;
        let maxConsecutiveWeeks = 0;
        weeksArray.forEach(w => {
            if (w.utilization > 0.7) {
                consecutiveHighLoad++;
                maxConsecutiveWeeks = Math.max(maxConsecutiveWeeks, consecutiveHighLoad);
            } else {
                consecutiveHighLoad = 0;
            }
        });

        // Sustained = either >50% of weeks at high load OR 8+ consecutive weeks
        const isSustainedLoad = (highLoadWeeks / weeksArray.length > 0.5) || (maxConsecutiveWeeks >= 8);

        // Add each week as a bottleneck with appropriate severity
        weeksArray.forEach((weekData) => {
            const util = weekData.utilization;

            // Flag as bottleneck if:
            // 1. Utilization > 80% (weekly threshold), OR
            // 2. High project count (>= 3 concurrent projects), OR
            // 3. Part of sustained load pattern
            if (util > 0.8 || weekData.projects.size >= 3 || (isSustainedLoad && util > 0.7)) {
                bottlenecks.push({
                    team,
                    week: weekData.week,
                    weekStart: weekData.weekStart,
                    projectCount: weekData.projects.size,
                    totalHours: weekData.totalHours,
                    utilization: util,
                    capacity: weeklyCapacity,
                    projects: Array.from(weekData.projects),
                    sustained: isSustainedLoad,
                    maxConsecutiveWeeks: maxConsecutiveWeeks,
                    avgTeamUtilization: avgUtilization,
                    severity: util > 1.5 ? 'critical' :
                             util > 1.2 ? 'high' :
                             isSustainedLoad ? 'sustained' : 'moderate',
                    interventionType: (isSustainedLoad || maxConsecutiveWeeks >= 8) ? 'hiring' : 'overtime'
                });
            }
        });
    });

    // Sort by utilization (highest first)
    bottlenecks.sort((a, b) => b.utilization - a.utilization);

    // FALLBACK: If we found few/no bottlenecks but have late projects, analyze those
    if (bottlenecks.length < 3 && scheduleResult.projectSummary) {
        const lateProjects = scheduleResult.projectSummary.filter(p => p.daysVariance < 0);

        if (lateProjects.length > 0) {
            const lateProjectLoad = {};

            lateProjects.forEach(project => {
                const projectTasks = scheduleResult.taskSummary?.filter(t => t.Project === project.project) || [];

                projectTasks.forEach(task => {
                    if (task.Date && task.Team) {
                        const team = task.Team || 'Unknown';
                        const workDate = new Date(task.Date);
                        const week = getWeekId(workDate);

                        if (!lateProjectLoad[team]) lateProjectLoad[team] = {};
                        if (!lateProjectLoad[team][week]) {
                            lateProjectLoad[team][week] = {
                                count: 0,
                                totalHours: 0,
                                projects: new Set(),
                                weekStart: workDate
                            };
                        }

                        lateProjectLoad[team][week].count++;
                        lateProjectLoad[team][week].totalHours += parseFloat(task['Time Spent (Hours)']) || 0;
                        lateProjectLoad[team][week].projects.add(project.project);
                    }
                });
            });

            // Add these as critical bottlenecks
            Object.entries(lateProjectLoad).forEach(([team, weeks]) => {
                const teamDef = baseTeamDefs.headcounts.find(t => t.name === team);
                const teamSize = teamDef?.count || 1;
                const hoursPerDay = baseParams.hoursPerDay || 8;
                const workDaysPerWeek = 5;
                const weeklyCapacity = teamSize * hoursPerDay * workDaysPerWeek;

                Object.entries(weeks).forEach(([week, data]) => {
                    // Only add if not already in bottlenecks
                    const exists = bottlenecks.find(b => b.team === team && b.week === week);
                    if (!exists) {
                        bottlenecks.push({
                            team,
                            week,
                            weekStart: data.weekStart,
                            projectCount: data.projects.size,
                            totalHours: data.totalHours,
                            utilization: data.totalHours / weeklyCapacity,
                            capacity: weeklyCapacity,
                            projects: Array.from(data.projects),
                            severity: 'critical',
                            source: 'late_projects',
                            interventionType: 'hiring' // Late projects indicate sustained issues
                        });
                    }
                });
            });

            // Re-sort after adding late project bottlenecks
            bottlenecks.sort((a, b) => b.utilization - a.utilization);
        }
    }

    return bottlenecks;
}

// Helper: Generate strategic hiring based on bottlenecks
function generateStrategicHiring(bottlenecks, baseTeamDefs, optimizationConfig, baseParams, aggressive = false, logs = []) {
    const teamMemberChanges = [];
    const hiresByTeam = {};

    // Define reasonable default max hires per team (same as in optimization)
    const defaultMaxHires = {
        'Paint': 12,
        'Scenic': 8,
        'CNC': 8,
        'Metal': 6,
        'Carpentry': 10,
        'Assembly': 10,
        'Tech': 8,
        'default': 8
    };

    // Build effective max headcount with user overrides and static defaults (maxHeadcount = max hires allowed, not max team size)
    const effectiveMaxHeadcount = {};
    baseTeamDefs.headcounts.forEach(team => {
        effectiveMaxHeadcount[team.name] = optimizationConfig.maxHeadcount?.[team.name] || defaultMaxHires[team.name] || defaultMaxHires.default;
    });

    // Realistic hiring lead time: minimum 3 weeks from schedule start
    const HIRING_LEAD_TIME_WEEKS = 3;
    const HIRE_SPACING_WEEKS = 2; // Space out multiple hires by 2 weeks each

    const scheduleStart = baseParams.startDate ? new Date(baseParams.startDate) : new Date();
    const earliestHireDate = new Date(scheduleStart);
    earliestHireDate.setDate(earliestHireDate.getDate() + (HIRING_LEAD_TIME_WEEKS * 7)); // Minimum: 3 weeks after schedule start

    logs.push(`\n--- Strategic Hiring Analysis (${aggressive ? 'Aggressive' : 'Conservative'}) ---`);
    logs.push(`Schedule starts: ${scheduleStart instanceof Date && !isNaN(scheduleStart) ? scheduleStart.toISOString().split('T')[0] : 'Invalid date'}`);
    logs.push(`Hiring lead time: ${HIRING_LEAD_TIME_WEEKS} weeks`);
    logs.push(`Earliest hire date: ${earliestHireDate instanceof Date && !isNaN(earliestHireDate) ? earliestHireDate.toISOString().split('T')[0] : 'Invalid date'}`);
    logs.push(`Hire spacing: ${HIRE_SPACING_WEEKS} weeks between hires`);
    logs.push(`Processing ${bottlenecks.length} bottleneck periods...`);

    // Group bottlenecks by team
    bottlenecks.forEach(bottleneck => {
        if (!hiresByTeam[bottleneck.team]) {
            hiresByTeam[bottleneck.team] = [];
        }
        hiresByTeam[bottleneck.team].push(bottleneck);
    });

    logs.push(`Found bottlenecks for ${Object.keys(hiresByTeam).length} teams`);

    // For each team with bottlenecks, hire people before the first bottleneck
    Object.entries(hiresByTeam).forEach(([team, teamBottlenecks]) => {
        teamBottlenecks.sort((a, b) => {
            // Sort by week (YYYY-WW format) or by weekStart date if available
            if (a.week && b.week) return a.week.localeCompare(b.week);
            if (a.weekStart && b.weekStart) return new Date(a.weekStart) - new Date(b.weekStart);
            return 0;
        });

        const firstBottleneck = teamBottlenecks[0];
        // Calculate hire date - need all hires done 2 weeks before first bottleneck
        // If hiring multiple people, account for spacing between hires
        let firstHireDate = new Date(earliestHireDate); // Default to earliest hire date

        if (firstBottleneck.weekStart) {
            const bottleneckDate = new Date(firstBottleneck.weekStart);
            if (!isNaN(bottleneckDate)) {
                // We want all hires completed 2 weeks before bottleneck
                const targetCompletionDate = new Date(bottleneckDate);
                targetCompletionDate.setDate(targetCompletionDate.getDate() - 14);

                // For now, set first hire date to this target
                // We'll adjust it later based on the number of hires needed
                firstHireDate = new Date(targetCompletionDate);

                // Ensure hire date is not before the earliest allowed date
                if (firstHireDate < earliestHireDate) {
                    firstHireDate = new Date(earliestHireDate);
                }
            }
        }

        const currentTeam = baseTeamDefs.headcounts.find(t => t.name === team);
        if (!currentTeam) {
            logs.push(`  ${team}: SKIPPED - team not found in baseTeamDefs`);
            return;
        }

        const maxHeadcount = effectiveMaxHeadcount[team];
        const totalProjects = teamBottlenecks.reduce((sum, b) => sum + b.projectCount, 0);
        const avgUtilization = teamBottlenecks.reduce((sum, b) => sum + (b.utilization || 1.0), 0) / teamBottlenecks.length;

        // Check if this is sustained load
        const sustainedMonths = teamBottlenecks.filter(b => b.sustained).length;
        const isSustainedLoad = sustainedMonths > teamBottlenecks.length * 0.5;
        const avgTeamUtil = teamBottlenecks[0]?.avgTeamUtilization || avgUtilization;

        logs.push(`\n  ${team}:`);
        const firstBottleneckDate = firstBottleneck.weekStart ? new Date(firstBottleneck.weekStart) : null;
        const firstBottleneckDateStr = firstBottleneckDate && !isNaN(firstBottleneckDate) ? firstBottleneckDate.toISOString().split('T')[0] : 'N/A';
        logs.push(`    First bottleneck week: ${firstBottleneck.week} (${firstBottleneckDateStr})`);
        const hireDateStr = firstHireDate && !isNaN(firstHireDate) ? firstHireDate.toISOString().split('T')[0] : 'Invalid';
        logs.push(`    Target completion date (2 weeks before bottleneck): ${hireDateStr}`);
        logs.push(`    Current headcount: ${currentTeam.count}`);
        logs.push(`    Max hires allowed: ${maxHeadcount}`);
        logs.push(`    Bottleneck months: ${teamBottlenecks.length}`);
        logs.push(`    Sustained load: ${sustainedMonths}/${teamBottlenecks.length} months (${isSustainedLoad ? 'YES' : 'NO'})`);
        logs.push(`    Total projects in bottlenecks: ${totalProjects}`);
        logs.push(`    Avg utilization in bottlenecks: ${Math.round(avgUtilization * 100)}%`);
        logs.push(`    Overall team avg utilization: ${Math.round(avgTeamUtil * 100)}%`);

        // More aggressive hiring calculation based on sustained load and utilization
        let hiresToAdd;

        if (isSustainedLoad && avgTeamUtil > 0.7) {
            // Sustained high load across the year - needs permanent capacity increase
            const capacityGap = avgTeamUtil - 0.65; // Target 65% utilization for breathing room
            hiresToAdd = Math.ceil(currentTeam.count * capacityGap);
            logs.push(`    Calculation: SUSTAINED LOAD (${Math.round(avgTeamUtil * 100)}% avg) → hire ${Math.round(capacityGap * 100)}% more = ${hiresToAdd}`);
        } else if (avgUtilization > 1.5) {
            // Critically overloaded in specific months
            hiresToAdd = Math.ceil(currentTeam.count * 0.5); // Add 50% more people
            logs.push(`    Calculation: Critical overload (>150%) → hire 50% more = ${hiresToAdd}`);
        } else if (avgUtilization > 1.2) {
            // Significantly overloaded
            hiresToAdd = Math.ceil(currentTeam.count * 0.4); // Add 40% more people
            logs.push(`    Calculation: High overload (>120%) → hire 40% more = ${hiresToAdd}`);
        } else if (avgUtilization > 1.0) {
            // Over 100% capacity - need help
            hiresToAdd = Math.ceil(currentTeam.count * 0.25); // Add 25% more people
            logs.push(`    Calculation: Overloaded (>100%) → hire 25% more = ${hiresToAdd}`);
        } else {
            // Under 100% but still bottleneck - use project count
            hiresToAdd = aggressive ? Math.ceil(totalProjects / 5) : Math.ceil(totalProjects / 8);
            logs.push(`    Calculation: ${aggressive ? 'Aggressive' : 'Conservative'} (${totalProjects} projects) → ${hiresToAdd}`);
        }

        const maxHiresAllowed = maxHeadcount;
        logs.push(`    Max hires allowed: ${maxHiresAllowed}`);

        hiresToAdd = Math.min(hiresToAdd, maxHiresAllowed);
        logs.push(`    Final hire count (after max cap): ${hiresToAdd}`);

        if (hiresToAdd > 0) {
            // Validate hire date before creating entries
            if (!firstHireDate || isNaN(firstHireDate)) {
                logs.push(`    ⚠️  SKIPPED: Invalid hire date`);
                return;
            }

            // Calculate when to start hiring to have everyone ready before bottleneck
            // If hiring multiple people, we need to start earlier to space them out
            const totalHiringWeeks = (hiresToAdd - 1) * HIRE_SPACING_WEEKS;
            const actualStartDate = new Date(firstHireDate);
            actualStartDate.setDate(actualStartDate.getDate() - (totalHiringWeeks * 7));

            // Ensure we don't start hiring before the earliest allowed date
            const finalStartDate = actualStartDate < earliestHireDate ? new Date(earliestHireDate) : actualStartDate;

            logs.push(`    Hiring ${hiresToAdd} people over ${totalHiringWeeks} weeks`);
            logs.push(`    First hire starts: ${finalStartDate.toISOString().split('T')[0]}`);

            // Create individual team member entries with proper names, spaced out over time
            const currentTeamSize = currentTeam.count;
            const teamNameNoSpaces = team.replace(/\s/g, '');

            for (let i = 0; i < hiresToAdd; i++) {
                const memberNumber = currentTeamSize + i + 1;
                const memberName = `${teamNameNoSpaces}${memberNumber}`;

                // Calculate this hire's start date (spaced by HIRE_SPACING_WEEKS)
                const thisHireDate = new Date(finalStartDate);
                thisHireDate.setDate(thisHireDate.getDate() + (i * HIRE_SPACING_WEEKS * 7));
                const hireDateStr = thisHireDate.toISOString().split('T')[0];

                teamMemberChanges.push({
                    team,
                    date: hireDateStr,
                    type: 'Starts',
                    name: memberName,
                    reason: `Hire ${i + 1}/${hiresToAdd} for ${teamBottlenecks.length} bottleneck periods (${Math.round(avgUtilization * 100)}% util)`
                });
                logs.push(`    ✓ Created hiring intervention: ${memberName} starts on ${hireDateStr}`);
            }
        } else {
            logs.push(`    ✗ No hiring - hiresToAdd is ${hiresToAdd}`);
        }
    });

    logs.push(`\nTotal hiring interventions created: ${teamMemberChanges.length}`);
    return teamMemberChanges;
}

// Helper: Generate hybrid worker suggestions for teams with bottlenecks
function generateHybridWorkers(bottlenecks, teamMemberChanges, baseTeamDefs, logs = []) {
    const hybridWorkers = [];

    logs.push(`\n--- Hybrid Worker Analysis ---`);

    // Group bottlenecks by team
    const bottlenecksByTeam = {};
    bottlenecks.forEach(bottleneck => {
        if (!bottlenecksByTeam[bottleneck.team]) {
            bottlenecksByTeam[bottleneck.team] = [];
        }
        bottlenecksByTeam[bottleneck.team].push(bottleneck);
    });

    const teamsWithBottlenecks = Object.keys(bottlenecksByTeam);
    logs.push(`Teams with bottlenecks: ${teamsWithBottlenecks.join(', ')}`);

    if (teamsWithBottlenecks.length < 2) {
        logs.push(`Only ${teamsWithBottlenecks.length} team(s) with bottlenecks - not enough for hybrid workers`);
        return hybridWorkers;
    }

    // For each team being hired for, consider making some hires hybrid workers
    const hiresByTeam = {};
    teamMemberChanges.forEach(change => {
        if (change.type === 'Starts') {
            if (!hiresByTeam[change.team]) {
                hiresByTeam[change.team] = [];
            }
            hiresByTeam[change.team].push(change);
        }
    });

    // For each team with multiple hires, suggest some as hybrid workers
    Object.entries(hiresByTeam).forEach(([primaryTeam, hires]) => {
        if (hires.length < 2) {
            logs.push(`\n${primaryTeam}: Only ${hires.length} hire(s) - keeping as specialist`);
            return;
        }

        // Find best secondary team (one with bottlenecks but fewer hires or no hires)
        const otherTeams = teamsWithBottlenecks.filter(t => t !== primaryTeam);

        if (otherTeams.length === 0) {
            logs.push(`\n${primaryTeam}: No other teams with bottlenecks for hybrid pairing`);
            return;
        }

        // Rank secondary teams by: 1) has bottlenecks, 2) fewer hires, 3) higher utilization
        const rankedSecondaryTeams = otherTeams.map(team => {
            const teamBottlenecks = bottlenecksByTeam[team] || [];
            const teamHires = hiresByTeam[team] || [];
            const avgUtil = teamBottlenecks.reduce((sum, b) => sum + (b.utilization || 1.0), 0) / teamBottlenecks.length;

            return {
                team,
                score: teamBottlenecks.length * 10 - teamHires.length * 5 + avgUtil,
                avgUtil
            };
        }).sort((a, b) => b.score - a.score);

        const secondaryTeam = rankedSecondaryTeams[0].team;

        // Suggest 25-33% of hires as hybrid workers (minimum 1, maximum 3)
        const hybridCount = Math.min(3, Math.max(1, Math.floor(hires.length * 0.3)));

        logs.push(`\n${primaryTeam}: ${hires.length} hires → suggesting ${hybridCount} as hybrid with ${secondaryTeam}`);
        logs.push(`  Reason: ${secondaryTeam} has ${bottlenecksByTeam[secondaryTeam].length} bottlenecks, ${(hiresByTeam[secondaryTeam] || []).length} hires`);

        // Convert last N hires to hybrid workers
        const lastHires = hires.slice(-hybridCount);
        lastHires.forEach(hire => {
            hybridWorkers.push({
                name: hire.name,
                primaryTeam: primaryTeam,
                secondaryTeam: secondaryTeam
            });
            logs.push(`  ✓ ${hire.name}: Primary=${primaryTeam}, Secondary=${secondaryTeam}`);
        });
    });

    logs.push(`\nTotal hybrid workers suggested: ${hybridWorkers.length}`);
    return hybridWorkers;
}

// Helper: Generate strategic overtime for specific periods (ONLY for short-term spikes)
function generateStrategicOvertime(bottlenecks, baseParams, optimizationConfig) {
    const workHourOverrides = [];
    const maxHours = optimizationConfig.maxHoursPerDay || 10;

    // Filter for bottlenecks that should use overtime (NOT hiring)
    const overtimeBottlenecks = bottlenecks.filter(b => b.interventionType === 'overtime');

    // Group consecutive weeks for same team
    const groupedByTeam = {};
    overtimeBottlenecks.forEach(b => {
        if (!groupedByTeam[b.team]) groupedByTeam[b.team] = [];
        groupedByTeam[b.team].push(b);
    });

    Object.entries(groupedByTeam).forEach(([team, teamBottlenecks]) => {
        teamBottlenecks.sort((a, b) => a.week.localeCompare(b.week));

        // Group consecutive weeks into overtime periods
        let currentPeriod = null;

        teamBottlenecks.forEach((bottleneck, idx) => {
            if (!currentPeriod) {
                currentPeriod = {
                    team,
                    startWeek: bottleneck.week,
                    endWeek: bottleneck.week,
                    startDate: bottleneck.weekStart,
                    maxUtil: bottleneck.utilization,
                    projectCount: bottleneck.projectCount
                };
            } else {
                // Check if consecutive
                const prevWeek = teamBottlenecks[idx - 1].week;
                const prevWeekNum = parseInt(prevWeek.split('-W')[1]);
                const currWeekNum = parseInt(bottleneck.week.split('-W')[1]);

                if (currWeekNum === prevWeekNum + 1) {
                    // Consecutive - extend period
                    currentPeriod.endWeek = bottleneck.week;
                    currentPeriod.maxUtil = Math.max(currentPeriod.maxUtil, bottleneck.utilization);
                    currentPeriod.projectCount = Math.max(currentPeriod.projectCount, bottleneck.projectCount);
                } else {
                    // Not consecutive - save current period and start new one
                    workHourOverrides.push(createOvertimePeriod(currentPeriod, baseParams, maxHours));
                    currentPeriod = {
                        team,
                        startWeek: bottleneck.week,
                        endWeek: bottleneck.week,
                        startDate: bottleneck.weekStart,
                        maxUtil: bottleneck.utilization,
                        projectCount: bottleneck.projectCount
                    };
                }
            }

            // Save last period
            if (idx === teamBottlenecks.length - 1 && currentPeriod) {
                workHourOverrides.push(createOvertimePeriod(currentPeriod, baseParams, maxHours));
            }
        });
    });

    function createOvertimePeriod(period, baseParams, maxHours) {
        const startDate = new Date(period.startDate);
        const endDate = new Date(period.startDate);

        // Calculate end date from week difference
        const weekDiff = parseInt(period.endWeek.split('-W')[1]) - parseInt(period.startWeek.split('-W')[1]);
        endDate.setDate(endDate.getDate() + (weekDiff * 7) + 6); // Add weeks + 6 days to end of week

        // Calculate overtime hours based on utilization
        let overtimeHours = 1;
        if (period.maxUtil > 1.3) overtimeHours = 2;
        else if (period.maxUtil > 1.1) overtimeHours = 1.5;

        const targetHours = Math.min(baseParams.hoursPerDay + overtimeHours, maxHours);

        return {
            team: period.team,
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0],
            hours: targetHours,  // Changed from hoursPerDay to hours to match scheduler expectation
            reason: `${overtimeHours}hr overtime for ${period.startWeek} to ${period.endWeek} (${Math.round(period.maxUtil * 100)}% util spike)`
        };
    }

    return workHourOverrides;
}

// Helper: Generate strategic date shifts to smooth out bottlenecks
function generateStrategicDateShifts(bottlenecks, baselineSchedule, projectTasks, baseParams, optimizationConfig, logs = []) {
    const startDateOverrides = {};
    const shifts = [];

    logs.push('\n--- Bi-Directional Load Leveling Analysis ---');
    logs.push('Goals: Reduce bottlenecks | Fill idle capacity | Even utilization | Meet due dates');

    if (!baselineSchedule || !baselineSchedule.projectSummary || !baselineSchedule.teamUtilization) {
        logs.push('No baseline schedule available for load leveling analysis');
        return { startDateOverrides, shifts };
    }

    // Build comprehensive utilization map by team and week
    const weeklyUtilization = {};
    baselineSchedule.teamUtilization.forEach(util => {
        const week = util.week;
        const team = util.team;

        if (!weeklyUtilization[week]) {
            weeklyUtilization[week] = {};
        }
        weeklyUtilization[week][team] = {
            utilization: util.utilization || 0,
            hoursWorked: util.hoursWorked || 0,
            capacity: util.capacity || 1
        };
    });

    // Identify peaks (high load) and valleys (low load) by team
    const teamAnalysis = {};
    Object.entries(weeklyUtilization).forEach(([week, teams]) => {
        Object.entries(teams).forEach(([team, data]) => {
            if (!teamAnalysis[team]) {
                teamAnalysis[team] = { peaks: [], valleys: [], avgUtil: 0, variance: 0 };
            }

            if (data.utilization > 0.85) {  // >85% = peak
                teamAnalysis[team].peaks.push({ week, utilization: data.utilization });
            } else if (data.utilization < 0.60) {  // <60% = valley
                teamAnalysis[team].valleys.push({ week, utilization: data.utilization });
            }
        });
    });

    // Calculate utilization variance for each team
    Object.keys(teamAnalysis).forEach(team => {
        const teamUtils = Object.values(weeklyUtilization)
            .map(weeks => weeks[team]?.utilization || 0)
            .filter(u => u > 0);

        if (teamUtils.length > 0) {
            const avg = teamUtils.reduce((sum, u) => sum + u, 0) / teamUtils.length;
            const variance = teamUtils.reduce((sum, u) => sum + Math.pow(u - avg, 2), 0) / teamUtils.length;
            teamAnalysis[team].avgUtil = avg;
            teamAnalysis[team].variance = variance;
        }
    });

    // Log current utilization state
    logs.push('\nCurrent Utilization Analysis:');
    Object.entries(teamAnalysis).forEach(([team, analysis]) => {
        logs.push(`  ${team}: Avg=${(analysis.avgUtil * 100).toFixed(0)}%, Variance=${analysis.variance.toFixed(3)}`);
        if (analysis.peaks.length > 0) {
            logs.push(`    • ${analysis.peaks.length} peak weeks (>85% util)`);
        }
        if (analysis.valleys.length > 0) {
            logs.push(`    • ${analysis.valleys.length} valley weeks (<60% util)`);
        }
    });

    // Group bottlenecks by week for multi-team coordination
    const weeklyLoad = {};
    bottlenecks.forEach(b => {
        if (!weeklyLoad[b.week]) {
            weeklyLoad[b.week] = [];
        }
        weeklyLoad[b.week].push(b);
    });

    // Find high-load weeks (multiple teams bottlenecked OR >100% util)
    const highLoadWeeks = Object.entries(weeklyLoad)
        .filter(([week, teams]) => teams.length >= 2 || teams.some(t => t.utilization > 1.0))
        .sort((a, b) => b[1].length - a[1].length);

    if (highLoadWeeks.length === 0 && Object.values(teamAnalysis).every(t => t.peaks.length === 0)) {
        logs.push('\n✓ No significant bottlenecks found - schedule is well-balanced');
        return { startDateOverrides, shifts };
    }

    logs.push(`\nFound ${highLoadWeeks.length} critical multi-team bottleneck weeks`);

    // Analyze each project for shift potential with team-aware logic
    const projectAnalysis = baselineSchedule.projectSummary.map(proj => {
        const startDate = new Date(proj.StartDate);
        const finishDate = new Date(proj.FinishDate);
        const dueDate = new Date(proj.DueDate);

        // Calculate slack (days between scheduled finish and due date)
        const slackDays = Math.round((dueDate - finishDate) / (1000 * 60 * 60 * 24));

        // Estimate project duration
        const durationDays = Math.round((finishDate - startDate) / (1000 * 60 * 60 * 24));

        // Find which teams this project uses (from project tasks)
        const projectTeams = new Set();
        projectTasks.filter(t => t.Project === proj.Project).forEach(t => {
            if (t.Team) projectTeams.add(t.Team);
        });

        // Find which weeks this project overlaps with
        const projectWeeks = [];
        let current = new Date(startDate);
        while (current <= finishDate) {
            const weekId = getWeekId(current);
            projectWeeks.push(weekId);
            current.setDate(current.getDate() + 7);
        }

        // Check if project uses bottlenecked teams AND starts in high-load week
        const usesBottleneckedTeams = [...projectTeams].some(team =>
            teamAnalysis[team] && teamAnalysis[team].peaks.length > 0
        );

        const startsInHighLoad = highLoadWeeks.some(([week]) => {
            const weekStart = new Date(week.split('-W')[0] + '-01-01');
            const weekNum = parseInt(week.split('-W')[1]);
            weekStart.setDate(weekStart.getDate() + (weekNum - 1) * 7);
            return Math.abs(startDate - weekStart) < 7 * 24 * 60 * 60 * 1000;
        });

        // Calculate shift potential scores (BI-DIRECTIONAL)
        const MIN_SLACK_BUFFER = 7; // Always keep 7 days safety buffer
        const maxShiftEarlier = slackDays > MIN_SLACK_BUFFER ? Math.floor((slackDays - MIN_SLACK_BUFFER) / 7) : 0;
        const maxShiftLater = slackDays > MIN_SLACK_BUFFER ? Math.floor((slackDays - MIN_SLACK_BUFFER) / 7) : 0;

        return {
            project: proj.Project,
            store: proj.Store,
            startDate,
            finishDate,
            dueDate,
            slackDays,
            durationDays,
            projectWeeks,
            projectTeams: [...projectTeams],
            startsInHighLoad,
            usesBottleneckedTeams,
            canShiftEarlier: maxShiftEarlier > 0,
            maxShiftEarlier,
            maxShiftLater,
            canShiftLater: maxShiftLater > 0,
            shiftImpactScore: 0  // Will be calculated
        };
    });

    // Helper function: Calculate multi-objective score for a shift
    function calculateShiftScore(proj, newStartDate, shiftWeeks, isEarlier, weeklyUtilization, teamAnalysis) {
        let score = 0;
        const scores = { bottleneck: 0, valley: 0, dueDate: 0, variance: 0 };

        // Get weeks affected by original and new schedules
        const originalWeeks = [];
        const newWeeks = [];
        let current = new Date(proj.startDate);
        const finishDate = new Date(proj.finishDate);
        const durationMs = finishDate - proj.startDate;
        const newFinishDate = new Date(newStartDate.getTime() + durationMs);

        // Original weeks
        current = new Date(proj.startDate);
        while (current <= finishDate) {
            originalWeeks.push(getWeekId(current));
            current.setDate(current.getDate() + 7);
        }

        // New weeks
        current = new Date(newStartDate);
        while (current <= newFinishDate) {
            newWeeks.push(getWeekId(current));
            current.setDate(current.getDate() + 7);
        }

        // 1. BOTTLENECK REDUCTION SCORE (Weight: 40%)
        // Calculate how much this shift reduces peak utilization
        let bottleneckReduction = 0;
        proj.projectTeams.forEach(team => {
            originalWeeks.forEach(week => {
                const util = weeklyUtilization[week]?.[team]?.utilization || 0;
                if (util > 0.85) { // Peak threshold
                    bottleneckReduction += (util - 0.85) * 100; // Reward reducing peaks
                }
            });
        });
        scores.bottleneck = bottleneckReduction * 4; // Weight: 40%

        // 2. VALLEY FILLING SCORE (Weight: 30%)
        // Reward moving work into low-utilization periods
        let valleyFilling = 0;
        if (isEarlier) { // Early shifts can fill valleys
            proj.projectTeams.forEach(team => {
                newWeeks.forEach(week => {
                    const util = weeklyUtilization[week]?.[team]?.utilization || 0;
                    if (util < 0.60) { // Valley threshold
                        valleyFilling += (0.60 - util) * 100; // Reward filling idle capacity
                    }
                });
            });
        }
        scores.valley = valleyFilling * 3; // Weight: 30%

        // 3. DUE DATE ADHERENCE SCORE (Weight: 20%)
        // Penalize consuming slack, reward preserving buffer
        const slackDaysAfter = proj.slackDays - (isEarlier ? -shiftWeeks * 7 : shiftWeeks * 7);
        if (slackDaysAfter < 7) {
            scores.dueDate = -100; // Heavy penalty for tight deadlines
        } else if (slackDaysAfter < 14) {
            scores.dueDate = -20; // Moderate penalty
        } else {
            scores.dueDate = Math.min(slackDaysAfter / 2, 20); // Slight reward for healthy slack
        }
        scores.dueDate *= 2; // Weight: 20%

        // 4. UTILIZATION VARIANCE REDUCTION SCORE (Weight: 10%)
        // Reward moves that make utilization more even
        let varianceReduction = 0;
        proj.projectTeams.forEach(team => {
            if (teamAnalysis[team]) {
                const currentVariance = teamAnalysis[team].variance;
                // Estimate: moving from peak to valley reduces variance
                if (isEarlier && bottleneckReduction > 0 && valleyFilling > 0) {
                    varianceReduction += currentVariance * 0.1; // 10% improvement estimate
                } else if (!isEarlier && bottleneckReduction > 0) {
                    varianceReduction += currentVariance * 0.05; // 5% improvement estimate
                }
            }
        });
        scores.variance = varianceReduction * 100; // Weight: 10%

        // Total score
        score = scores.bottleneck + scores.valley + scores.dueDate + scores.variance;

        return { score, scores };
    }

    // Generate scored shift recommendations (BI-DIRECTIONAL)
    const shiftCandidates = [];

    projectAnalysis.forEach(proj => {
        // Skip projects with no shift potential
        if (proj.projectTeams.length === 0) return;
        if (!proj.canShiftEarlier && !proj.canShiftLater) return;

        const scheduleStart = new Date(baseParams.startDate);

        // EVALUATE EARLY SHIFTS (pull work earlier to fill valleys)
        if (proj.canShiftEarlier) {
            const maxWeeks = Math.min(proj.maxShiftEarlier, 4); // Max 4 weeks earlier

            for (let shiftWeeks = 1; shiftWeeks <= maxWeeks; shiftWeeks++) {
                const newStartDate = new Date(proj.startDate);
                newStartDate.setDate(newStartDate.getDate() - (shiftWeeks * 7));

                // Don't shift before schedule start
                if (newStartDate < scheduleStart) continue;

                const { score, scores } = calculateShiftScore(
                    proj, newStartDate, shiftWeeks, true, weeklyUtilization, teamAnalysis
                );

                // Only include if score is positive (net benefit)
                if (score > 0) {
                    const newStartDateStr = newStartDate.toISOString().split('T')[0];
                    const slackAfter = proj.slackDays + (shiftWeeks * 7);

                    shiftCandidates.push({
                        project: proj.project,
                        store: proj.store,
                        originalStart: proj.startDate.toISOString().split('T')[0],
                        newStart: newStartDateStr,
                        shiftDays: -shiftWeeks * 7,
                        shiftWeeks,
                        direction: 'earlier',
                        slackBefore: proj.slackDays,
                        slackAfter,
                        impactScore: score,
                        scores,
                        teamsAffected: proj.projectTeams.join(', '),
                        reason: `Pull ${shiftWeeks}w earlier → Fill idle capacity (valley score: ${scores.valley.toFixed(0)}) & reduce bottlenecks (${scores.bottleneck.toFixed(0)})`
                    });
                }
            }
        }

        // EVALUATE LATE SHIFTS (push work later to reduce bottlenecks)
        if (proj.canShiftLater && proj.startsInHighLoad) { // Only shift later if starting in high-load period
            const maxWeeks = Math.min(proj.maxShiftLater, 3); // Max 3 weeks later (more conservative)

            for (let shiftWeeks = 1; shiftWeeks <= maxWeeks; shiftWeeks++) {
                const newStartDate = new Date(proj.startDate);
                newStartDate.setDate(newStartDate.getDate() + (shiftWeeks * 7));

                const { score, scores } = calculateShiftScore(
                    proj, newStartDate, shiftWeeks, false, weeklyUtilization, teamAnalysis
                );

                // Only include if score is positive AND bottleneck reduction is significant
                if (score > 0 && scores.bottleneck > 10) {
                    const newStartDateStr = newStartDate.toISOString().split('T')[0];
                    const slackAfter = proj.slackDays - (shiftWeeks * 7);

                    shiftCandidates.push({
                        project: proj.project,
                        store: proj.store,
                        originalStart: proj.startDate.toISOString().split('T')[0],
                        newStart: newStartDateStr,
                        shiftDays: shiftWeeks * 7,
                        shiftWeeks,
                        direction: 'later',
                        slackBefore: proj.slackDays,
                        slackAfter,
                        impactScore: score,
                        scores,
                        teamsAffected: proj.projectTeams.join(', '),
                        reason: `Push ${shiftWeeks}w later → Reduce bottleneck (peak reduction: ${scores.bottleneck.toFixed(0)})`
                    });
                }
            }
        }
    });

    // Sort by impact score and select top shifts
    shiftCandidates.sort((a, b) => b.impactScore - a.impactScore);

    // Apply top shifts (limit to avoid over-shifting)
    const maxShifts = Math.min(shiftCandidates.length, Math.ceil(projectAnalysis.length * 0.3)); // Max 30% of projects
    const selectedShifts = shiftCandidates.slice(0, maxShifts);

    selectedShifts.forEach(shift => {
        startDateOverrides[shift.project] = shift.newStart;
        shifts.push(shift);
    });

    // Count shift types
    const earlyShifts = shifts.filter(s => s.direction === 'earlier').length;
    const lateShifts = shifts.filter(s => s.direction === 'later').length;

    logs.push(`\nBi-Directional Load Leveling Results:`);
    logs.push(`  Evaluated ${shiftCandidates.length} shift options`);
    logs.push(`  Selected ${shifts.length} optimal shifts (${earlyShifts} earlier, ${lateShifts} later)`);

    if (shifts.length > 0) {
        logs.push(`\nTop Shifts by Multi-Objective Score:`);
        shifts.slice(0, 10).forEach(shift => {
            const arrow = shift.direction === 'earlier' ? '←' : '→';
            logs.push(`  [${shift.impactScore.toFixed(0)}] ${arrow} ${shift.project}: ${shift.originalStart} → ${shift.newStart}`);
            logs.push(`      ${shift.reason}`);
            logs.push(`      Scores - Bottleneck:${shift.scores.bottleneck.toFixed(0)} | Valley:${shift.scores.valley.toFixed(0)} | DueDate:${shift.scores.dueDate.toFixed(0)} | Variance:${shift.scores.variance.toFixed(0)}`);
            logs.push(`      Slack: ${shift.slackBefore}d → ${shift.slackAfter}d`);
        });
        if (shifts.length > 10) {
            logs.push(`  ... and ${shifts.length - 10} more shifts`);
        }
    }

    return { startDateOverrides, shifts };
}

// Generate different resource configuration scenarios with TIME-BASED interventions
function generateScenarios(baseTeamDefs, baseParams, optimizationConfig, scenarioTypes, baselineBottlenecks, dateShiftData, logs = []) {
    const scenarios = [];

    if (scenarioTypes.includes('statusQuo')) {
        scenarios.push({
            id: 'statusQuo',
            name: 'Status Quo',
            description: 'Current resources - see what happens with no changes',
            teamDefs: JSON.parse(JSON.stringify(baseTeamDefs)),
            params: JSON.parse(JSON.stringify(baseParams)),
            workHourOverrides: [],
            teamMemberChanges: [],
            hybridWorkers: [],
            startDateOverrides: {},
            dateShifts: [],
            levers: [],
            type: 'baseline',
            config: optimizationConfig
        });
    }

    // Only generate strategic scenarios if we have bottlenecks to address
    if (baselineBottlenecks && baselineBottlenecks.length > 0) {
        if (scenarioTypes.includes('overtime')) {
            const workHourOverrides = generateStrategicOvertime(baselineBottlenecks, baseParams, optimizationConfig);
            const hasDateShifts = dateShiftData && dateShiftData.shifts && dateShiftData.shifts.length > 0;

            if (workHourOverrides.length > 0 || hasDateShifts) {
                const levers = [];
                let description = '';

                if (workHourOverrides.length > 0 && hasDateShifts) {
                    levers.push('overtime', 'scheduling');
                    description = `Overtime during ${workHourOverrides.length} high-load periods + shift ${dateShiftData.shifts.length} project start dates - no hiring`;
                } else if (workHourOverrides.length > 0) {
                    levers.push('overtime');
                    description = `Apply overtime during ${workHourOverrides.length} high-load periods - no hiring`;
                } else {
                    levers.push('scheduling');
                    description = `Shift ${dateShiftData.shifts.length} project start dates to smooth out bottlenecks - no additional cost`;
                }

                scenarios.push({
                    id: 'overtime',
                    name: 'Strategic Overtime + Load Leveling',
                    description: description,
                    teamDefs: JSON.parse(JSON.stringify(baseTeamDefs)),
                    params: JSON.parse(JSON.stringify(baseParams)),
                    workHourOverrides: workHourOverrides,
                    teamMemberChanges: [],
                    hybridWorkers: [],
                    startDateOverrides: hasDateShifts ? dateShiftData.startDateOverrides : {},
                    dateShifts: hasDateShifts ? dateShiftData.shifts : [],
                    levers: levers,
                    type: 'strategic',
                    config: optimizationConfig
                });
            }
        }

        if (scenarioTypes.includes('balanced')) {
            const teamMemberChanges = generateStrategicHiring(baselineBottlenecks, baseTeamDefs, optimizationConfig, baseParams, false, logs);
            const hybridWorkers = generateHybridWorkers(baselineBottlenecks, teamMemberChanges, baseTeamDefs, logs);
            const workHourOverrides = generateStrategicOvertime(baselineBottlenecks.slice(0, Math.ceil(baselineBottlenecks.length * 0.3)), baseParams, optimizationConfig);
            const hasDateShifts = dateShiftData && dateShiftData.shifts && dateShiftData.shifts.length > 0;

            if (teamMemberChanges.length > 0 || workHourOverrides.length > 0 || hasDateShifts) {
                const levers = [];
                const parts = [];

                if (teamMemberChanges.length > 0) {
                    levers.push('hiring');
                    const specialistCount = teamMemberChanges.length - hybridWorkers.length;
                    const hybridCount = hybridWorkers.length;
                    if (hybridCount > 0) {
                        parts.push(`${specialistCount} specialists + ${hybridCount} hybrid workers`);
                    } else {
                        parts.push(`${teamMemberChanges.length} hires`);
                    }
                }
                if (workHourOverrides.length > 0) {
                    levers.push('overtime');
                    parts.push(`${workHourOverrides.length} overtime periods`);
                }
                if (hasDateShifts) {
                    levers.push('scheduling');
                    parts.push(`${dateShiftData.shifts.length} date shifts`);
                }

                scenarios.push({
                    id: 'balanced',
                    name: 'Balanced Growth',
                    description: `Strategic ${parts.join(' + ')}`,
                    teamDefs: JSON.parse(JSON.stringify(baseTeamDefs)),
                    params: JSON.parse(JSON.stringify(baseParams)),
                    workHourOverrides: workHourOverrides,
                    teamMemberChanges: teamMemberChanges,
                    hybridWorkers: hybridWorkers,
                    startDateOverrides: hasDateShifts ? dateShiftData.startDateOverrides : {},
                    dateShifts: hasDateShifts ? dateShiftData.shifts : [],
                    levers: levers,
                    type: 'strategic',
                    config: optimizationConfig
                });
            }
        }

        if (scenarioTypes.includes('aggressive')) {
            const teamMemberChanges = generateStrategicHiring(baselineBottlenecks, baseTeamDefs, optimizationConfig, baseParams, true, logs);
            const hybridWorkers = generateHybridWorkers(baselineBottlenecks, teamMemberChanges, baseTeamDefs, logs);
            const hasDateShifts = dateShiftData && dateShiftData.shifts && dateShiftData.shifts.length > 0;

            if (teamMemberChanges.length > 0 || hasDateShifts) {
                const levers = [];
                let description = '';

                if (teamMemberChanges.length > 0 && hasDateShifts) {
                    levers.push('hiring', 'scheduling');
                    const hybridCount = hybridWorkers.length;
                    description = hybridCount > 0
                        ? `Front-load hiring (${teamMemberChanges.length - hybridCount} specialists + ${hybridCount} hybrid) + shift ${dateShiftData.shifts.length} projects`
                        : `Front-load hiring (${teamMemberChanges.length} hires) + shift ${dateShiftData.shifts.length} projects for optimal flow`;
                } else if (teamMemberChanges.length > 0) {
                    levers.push('hiring');
                    description = `Front-load hiring with ${teamMemberChanges.length} strategic additions`;
                } else {
                    levers.push('scheduling');
                    description = `Shift ${dateShiftData.shifts.length} project start dates to smooth out bottlenecks`;
                }

                scenarios.push({
                    id: 'aggressive',
                    name: 'Aggressive Hiring + Load Leveling',
                    description: description,
                    teamDefs: JSON.parse(JSON.stringify(baseTeamDefs)),
                    params: JSON.parse(JSON.stringify(baseParams)),
                    workHourOverrides: [],
                    teamMemberChanges: teamMemberChanges,
                    hybridWorkers: hybridWorkers,
                    startDateOverrides: hasDateShifts ? dateShiftData.startDateOverrides : {},
                    dateShifts: hasDateShifts ? dateShiftData.shifts : [],
                    levers: levers,
                    type: 'strategic',
                    config: optimizationConfig
                });
            }
        }

        if (scenarioTypes.includes('allIn')) {
            const teamMemberChanges = generateStrategicHiring(baselineBottlenecks, baseTeamDefs, optimizationConfig, baseParams, true, logs);
            const hybridWorkers = generateHybridWorkers(baselineBottlenecks, teamMemberChanges, baseTeamDefs, logs);
            const workHourOverrides = generateStrategicOvertime(baselineBottlenecks, baseParams, optimizationConfig);
            const hasDateShifts = dateShiftData && dateShiftData.shifts && dateShiftData.shifts.length > 0;

            if (teamMemberChanges.length > 0 || workHourOverrides.length > 0 || hasDateShifts) {
                const levers = [];
                const parts = [];

                if (teamMemberChanges.length > 0) {
                    levers.push('hiring');
                    const specialistCount = teamMemberChanges.length - hybridWorkers.length;
                    const hybridCount = hybridWorkers.length;
                    if (hybridCount > 0) {
                        parts.push(`${specialistCount} specialists + ${hybridCount} hybrid`);
                    } else {
                        parts.push(`${teamMemberChanges.length} hires`);
                    }
                }
                if (workHourOverrides.length > 0) {
                    levers.push('overtime');
                    parts.push(`${workHourOverrides.length} overtime periods`);
                }
                if (hasDateShifts) {
                    levers.push('scheduling');
                    parts.push(`${dateShiftData.shifts.length} date shifts`);
                }

                scenarios.push({
                    id: 'allIn',
                    name: 'All-In Strategy',
                    description: `All levers: ${parts.join(' + ')}`,
                    teamDefs: JSON.parse(JSON.stringify(baseTeamDefs)),
                    params: JSON.parse(JSON.stringify(baseParams)),
                    workHourOverrides: workHourOverrides,
                    teamMemberChanges: teamMemberChanges,
                    hybridWorkers: hybridWorkers,
                    startDateOverrides: hasDateShifts ? dateShiftData.startDateOverrides : {},
                    dateShifts: hasDateShifts ? dateShiftData.shifts : [],
                    levers: levers,
                    type: 'strategic',
                    config: optimizationConfig
                });
            }
        }
    }

    return scenarios;
}

// Run multiple scenarios and compare results
async function runMultiScenarioAnalysis(
    projectTasks, params, baseTeamDefs, ptoEntries, teamMemberChanges,
    workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
    startDateOverrides, endDateOverrides, optimizationConfig, scenarioTypes,
    updateProgress
) {
    console.log("=== runMultiScenarioAnalysis STARTED ===");
    console.log("Scenario types requested:", scenarioTypes);

    const logs = [];
    logs.push("--- Starting Multi-Scenario Analysis ---");

    // STEP 1: Run baseline to identify bottlenecks
    updateProgress(10, 'Analyzing baseline schedule to identify bottlenecks...', 'analyzing');
    logs.push("\n--- STEP 1: Baseline Analysis ---");
    console.log("About to run baseline analysis...");

    let baselineBottlenecks = null;
    let baselineResult = null;
    const { tasks: preparedTasks } = await prepareProjectData(projectTasks, () => {});
    console.log(`Prepared ${preparedTasks.length} tasks for baseline analysis`);

    try {
        console.log("Calling runSchedulingEngine for baseline...");
        baselineResult = await runSchedulingEngine(
            preparedTasks, params, baseTeamDefs, ptoEntries, teamMemberChanges,
            workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
            startDateOverrides, endDateOverrides,
            () => {}
        );

        console.log("Baseline result received:", {
            hasTaskSummary: !!baselineResult?.taskSummary,
            taskSummaryLength: baselineResult?.taskSummary?.length || 0,
            hasProjectSummary: !!baselineResult?.projectSummary,
            projectSummaryLength: baselineResult?.projectSummary?.length || 0
        });

        baselineBottlenecks = identifyBottlenecks(baselineResult, params, baseTeamDefs);
        logs.push(`Found ${baselineBottlenecks.length} bottleneck periods (>70% utilization or 3+ projects/week):`);

        if (baselineBottlenecks.length === 0) {
            logs.push("  No bottlenecks detected - all teams have capacity available");
            logs.push("  Scenarios will focus on maintaining current resource levels");
        } else {
            const bottlenecksByTeam = {};
            baselineBottlenecks.forEach(b => {
                if (!bottlenecksByTeam[b.team]) bottlenecksByTeam[b.team] = [];
                bottlenecksByTeam[b.team].push(b);
            });

            Object.entries(bottlenecksByTeam).forEach(([team, bottlenecks]) => {
                const sustainedCount = bottlenecks.filter(b => b.sustained).length;
                const avgUtil = bottlenecks.reduce((sum, b) => sum + b.utilization, 0) / bottlenecks.length;
                const avgTeamUtil = bottlenecks[0]?.avgTeamUtilization || avgUtil;
                const maxConsecutive = bottlenecks[0]?.maxConsecutiveWeeks || 0;

                logs.push(`  ${team}: ${bottlenecks.length} high-load weeks`);
                logs.push(`    Overall avg utilization: ${Math.round(avgTeamUtil * 100)}%`);
                logs.push(`    Max consecutive high-load weeks: ${maxConsecutive}`);
                if (sustainedCount > 0) {
                    logs.push(`    ⚠️  SUSTAINED LOAD: ${sustainedCount}/${bottlenecks.length} weeks flagged`);
                }

                // Show top 5 worst weeks
                const topBottlenecks = [...bottlenecks].sort((a, b) => b.utilization - a.utilization).slice(0, 5);
                topBottlenecks.forEach(b => {
                    const utilPct = Math.round(b.utilization * 100);
                    const sustainedFlag = b.sustained ? ' [SUSTAINED]' : '';
                    const interventionType = b.interventionType === 'hiring' ? ' → HIRING' : ' → OVERTIME';
                    logs.push(`    - ${b.week}: ${b.projectCount} projects, ${Math.round(b.totalHours)}hrs (${utilPct}% util)${sustainedFlag}${interventionType}`);
                });

                if (bottlenecks.length > 5) {
                    logs.push(`    ... and ${bottlenecks.length - 5} more weeks`);
                }
            });
        }
    } catch (error) {
        console.error("ERROR during baseline analysis:", error);
        logs.push(`Baseline analysis error: ${error.message}`);
        logs.push("Proceeding with static scenarios instead...");
    }

    // STEP 1.5: Analyze date shift opportunities
    let dateShiftData = { startDateOverrides: {}, shifts: [] };
    if (baselineResult && baselineBottlenecks && baselineBottlenecks.length > 0) {
        try {
            dateShiftData = generateStrategicDateShifts(
                baselineBottlenecks,
                baselineResult,
                preparedTasks,
                params,
                optimizationConfig,
                logs
            );
        } catch (error) {
            console.error("ERROR during date shift analysis:", error);
            logs.push(`Date shift analysis error: ${error.message}`);
        }
    }

    // STEP 2: Generate scenarios based on bottlenecks
    updateProgress(20, 'Generating strategic scenarios...', 'analyzing');
    logs.push("\n--- STEP 2: Generating Strategic Scenarios ---");

    const scenarios = generateScenarios(baseTeamDefs, params, optimizationConfig, scenarioTypes, baselineBottlenecks, dateShiftData, logs);
    logs.push(`\nGenerated ${scenarios.length} scenarios to analyze.`);

    const results = [];
    let scenarioIndex = 0;

    for (const scenario of scenarios) {
        scenarioIndex++;
        const progressBase = Math.floor((scenarioIndex - 1) / scenarios.length * 90);

        updateProgress(
            progressBase + 5,
            `Running scenario ${scenarioIndex}/${scenarios.length}: ${scenario.name}...`,
            'analyzing'
        );

        logs.push(`\n--- Running Scenario: ${scenario.name} ---`);
        logs.push(scenario.description);
        logs.push(`Levers: ${scenario.levers.join(', ') || 'None'}`);

        try {
            let scenarioResult;

            // Use scenario-specific parameters
            const scenarioParams = scenario.params || params;
            const scenarioWorkHourOverrides = scenario.workHourOverrides || workHourOverrides;
            const scenarioTeamMemberChanges = scenario.teamMemberChanges || teamMemberChanges;
            const scenarioHybridWorkers = scenario.hybridWorkers || hybridWorkers;

            // Log scenario interventions
            if (scenarioTeamMemberChanges && scenarioTeamMemberChanges.length > 0) {
                logs.push(`Team Member Changes (${scenarioTeamMemberChanges.length}):`);
                scenarioTeamMemberChanges.forEach(change => {
                    if (change.type === 'Starts') {
                        logs.push(`  ${change.date}: ${change.name} joins ${change.team} - ${change.reason || 'roster change'}`);
                    } else if (change.type === 'Ends') {
                        logs.push(`  ${change.date}: ${change.name} leaves ${change.team} - ${change.reason || 'roster change'}`);
                    } else {
                        // Legacy format with 'change' field
                        logs.push(`  ${change.date}: ${change.team} ${change.change > 0 ? '+' : ''}${change.change} - ${change.reason || 'roster change'}`);
                    }
                });
            }

            if (scenarioWorkHourOverrides && scenarioWorkHourOverrides.length > 0) {
                logs.push(`Work Hour Overrides (${scenarioWorkHourOverrides.length}):`);
                scenarioWorkHourOverrides.forEach(override => {
                    logs.push(`  ${override.startDate} to ${override.endDate}: ${override.team} = ${override.hours || override.hoursPerDay}hrs/day - ${override.reason || 'overtime'}`);
                });
            }

            // Add summary of what we're running
            logs.push(`\nRunning ${scenario.name} with:`);
            logs.push(`  - ${scenarioTeamMemberChanges.length} team member changes`);
            logs.push(`  - ${scenarioWorkHourOverrides.length} work hour overrides`);

            if (scenario.type === 'baseline' || scenario.type === 'manual' || scenario.type === 'strategic') {
                // For baseline, manual, or strategic scenarios, just run the scheduler
                const scheduleResult = await runSchedulingEngine(
                    preparedTasks, scenarioParams, scenario.teamDefs, ptoEntries, scenarioTeamMemberChanges,
                    scenarioWorkHourOverrides, scenarioHybridWorkers, efficiencyData, teamMemberNameMap,
                    startDateOverrides, endDateOverrides,
                    () => {}
                );

                // Capture and append logs from the scheduling engine
                logs.push(`\n=== ${scenario.name} Scheduling Engine Logs ===`);
                if (scheduleResult.logs && scheduleResult.logs.length > 0) {
                    scheduleResult.logs.forEach(log => logs.push(log));
                }

                scenarioResult = {
                    success: true,
                    optimizedTeamDefs: scenario.teamDefs,
                    optimizedParams: scenarioParams,
                    optimizedTeamMemberChanges: scenarioTeamMemberChanges,
                    optimizedWorkHourOverrides: scenarioWorkHourOverrides,
                    optimizedHybridWorkers: scenarioHybridWorkers,
                    schedule: scheduleResult,
                    changes: [],
                    totalCost: 0,
                    iterations: 1,
                    remainingGaps: analyzeProjectGaps(scheduleResult.projectSummary, endDateOverrides, 0),
                    logs: scheduleResult.logs || [`${scenario.name} scenario completed.`],
                    levers: scenario.levers
                };
            } else if (scenario.type === 'optimized') {
                // For optimization scenarios, run the optimizer
                scenarioResult = await optimizeResources(
                    projectTasks, scenarioParams, scenario.teamDefs, ptoEntries, scenarioTeamMemberChanges,
                    scenarioWorkHourOverrides, scenarioHybridWorkers, efficiencyData, teamMemberNameMap,
                    startDateOverrides, endDateOverrides, scenario.config,
                    () => {} // Silent progress for individual scenarios
                );
                scenarioResult.optimizedParams = scenarioParams;
                scenarioResult.levers = scenario.levers;
            }

            // Calculate summary metrics
            const summary = calculateScenarioSummary(
                scenario,
                scenarioResult,
                baseTeamDefs,
                params,
                endDateOverrides
            );

            // Debug logging
            logs.push(`\nDEBUG - ${scenario.name} Results:`);
            logs.push(`  Total projects in schedule: ${scenarioResult.schedule?.projectSummary?.length || 0}`);
            logs.push(`  Projects calculated as on-time: ${summary.projectsOnTime}`);
            logs.push(`  Team configuration used:`);
            scenarioResult.optimizedTeamDefs?.headcounts.forEach(team => {
                logs.push(`    - ${team.name}: ${team.count}`);
            });
            if (scenarioResult.optimizedParams) {
                logs.push(`  Hours per day: ${scenarioResult.optimizedParams.hoursPerDay}`);
            }

            results.push({
                scenario: scenario,
                result: scenarioResult,
                summary: summary
            });

            logs.push(`${scenario.name} completed: ${scenarioResult.success ? 'Success' : 'Partial solution'}`);
            logs.push(`Cost: $${summary.totalCost.toLocaleString()}, Projects on-time: ${summary.projectsOnTime}/${summary.totalProjects}`);

        } catch (error) {
            logs.push(`ERROR in ${scenario.name}: ${error.message}`);
            console.error(`Error in scenario ${scenario.name}:`, error);
            results.push({
                scenario: scenario,
                result: null,
                summary: {
                    error: error.message,
                    totalCost: 0,
                    feasible: false,
                    levers: scenario.levers
                }
            });
        }
    }

    updateProgress(95, 'Comparing scenarios...', 'finalizing');

    // Rank scenarios by on-time projects first, then cost
    const rankedResults = results
        .filter(r => r.result !== null)
        .sort((a, b) => {
            // Prioritize on-time projects
            const aOnTime = a.summary.projectsOnTime || 0;
            const bOnTime = b.summary.projectsOnTime || 0;
            if (aOnTime !== bOnTime) return bOnTime - aOnTime;

            // Then by cost
            return a.summary.totalCost - b.summary.totalCost;
        });

    return {
        scenarios: rankedResults,
        logs: logs,
        recommendedScenario: rankedResults.length > 0 ? rankedResults[0].scenario.id : null
    };
}

// Analyze project gaps against target deadlines
function analyzeProjectGaps(projectSummary, endDateOverrides, targetBuffer) {
    const gaps = [];

    projectSummary.forEach(project => {
        const finishDate = parseDate(project.FinishDate);
        const targetDueDate = parseDate(endDateOverrides[project.Project] || project.DueDate);

        if (!finishDate || !targetDueDate) return;

        const daysFromTarget = Math.round((targetDueDate.getTime() - finishDate.getTime()) / (1000 * 60 * 60 * 24));

        if (daysFromTarget < targetBuffer) {
            gaps.push({
                project: project.Project,
                daysLate: targetBuffer - daysFromTarget,
                finishDate: project.FinishDate,
                targetDate: project.DueDate
            });
        }
    });

    return gaps;
}

// Calculate summary metrics for a scenario
function calculateScenarioSummary(scenario, result, baseTeamDefs, baseParams, endDateOverrides) {
    // Calculate actual costs for this scenario
    const costPerHour = scenario.config?.costPerHour || 25;
    const overtimeMultiplier = scenario.config?.overtimeMultiplier || 1.5;
    let totalCost = 0;
    const costBreakdown = [];

    // 1. Calculate hiring costs (annual salary for new hires)
    // Assume full-time = 2080 hours/year (40 hrs/week * 52 weeks)
    const ANNUAL_WORK_HOURS = 2080;
    if (result.optimizedTeamDefs) {
        result.optimizedTeamDefs.headcounts.forEach(team => {
            const originalTeam = baseTeamDefs.headcounts.find(t => t.name === team.name);
            if (originalTeam) {
                const headcountIncrease = team.count - originalTeam.count;
                if (headcountIncrease > 0) {
                    // Annual salary cost for new hires
                    const annualCostPerPerson = costPerHour * ANNUAL_WORK_HOURS;
                    const hiringCost = headcountIncrease * annualCostPerPerson;
                    totalCost += hiringCost;
                    costBreakdown.push({
                        type: 'hiring',
                        team: team.name,
                        count: headcountIncrease,
                        annualCostPerPerson,
                        totalCost: hiringCost,
                        description: `Hire ${headcountIncrease.toFixed(1)} ${team.name} @ $${annualCostPerPerson.toLocaleString()}/yr`
                    });
                }
            }
        });
    }

    // 2. Calculate overtime costs (extended hours at 1.5x rate)
    if (result.optimizedParams && baseParams) {
        const extraHoursPerDay = result.optimizedParams.hoursPerDay - baseParams.hoursPerDay;
        if (extraHoursPerDay > 0) {
            // Calculate for all team members working overtime
            const totalTeamSize = baseTeamDefs.headcounts.reduce((sum, t) => sum + t.count, 0);

            // Estimate schedule duration in weeks (default to 52 weeks if not available)
            const scheduleStartDate = baseParams.startDate ? parseDate(baseParams.startDate) : new Date();
            const scheduleEndDate = result.schedule?.projectSummary?.length > 0
                ? parseDate(result.schedule.projectSummary.reduce((latest, p) =>
                    new Date(p.FinishDate) > new Date(latest) ? p.FinishDate : latest,
                    result.schedule.projectSummary[0].FinishDate))
                : new Date(scheduleStartDate.getTime() + (52 * 7 * 24 * 60 * 60 * 1000));

            const durationWeeks = Math.ceil((scheduleEndDate - scheduleStartDate) / (7 * 24 * 60 * 60 * 1000));
            const workDaysPerWeek = 5;

            // Overtime cost = extraHours * totalTeamSize * weeks * daysPerWeek * hourlyRate * 1.5
            const overtimeCost = extraHoursPerDay * totalTeamSize * durationWeeks * workDaysPerWeek * costPerHour * overtimeMultiplier;
            totalCost += overtimeCost;
            costBreakdown.push({
                type: 'overtime',
                extraHoursPerDay,
                teamSize: totalTeamSize,
                durationWeeks,
                overtimeRate: costPerHour * overtimeMultiplier,
                totalCost: overtimeCost,
                description: `${extraHoursPerDay}hr/day overtime for ${totalTeamSize} people over ${durationWeeks} weeks @ $${(costPerHour * overtimeMultiplier).toFixed(2)}/hr`
            });
        }
    }

    const summary = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        totalCost: totalCost,
        costBreakdown: costBreakdown,
        iterations: result.iterations || 1,
        success: result.success || false,
        feasible: result.success || (result.remainingGaps && result.remainingGaps.length < 3),
        levers: result.levers || scenario.levers || [],
    };

    // Resource changes
    const resourceChanges = [];
    if (result.optimizedTeamDefs) {
        result.optimizedTeamDefs.headcounts.forEach(team => {
            const originalTeam = baseTeamDefs.headcounts.find(t => t.name === team.name);
            if (originalTeam) {
                const difference = team.count - originalTeam.count;
                if (Math.abs(difference) > 0.001) {
                    resourceChanges.push({
                        team: team.name,
                        original: originalTeam.count,
                        new: team.count,
                        difference: difference
                    });
                }
            }
        });
    }
    summary.resourceChanges = resourceChanges;

    // Parameter changes (overtime, extended hours, etc.)
    const paramChanges = [];
    if (result.optimizedParams && baseParams) {
        if (result.optimizedParams.hoursPerDay !== baseParams.hoursPerDay) {
            const diff = result.optimizedParams.hoursPerDay - baseParams.hoursPerDay;
            paramChanges.push({
                type: 'hoursPerDay',
                original: baseParams.hoursPerDay,
                new: result.optimizedParams.hoursPerDay,
                difference: diff,
                description: diff > 0 ? `+${diff}hr overtime` : `${diff}hr reduction`
            });
        }
    }
    summary.paramChanges = paramChanges;

    // Time-based interventions
    summary.teamMemberChanges = result.optimizedTeamMemberChanges || [];
    summary.workHourOverrides = result.optimizedWorkHourOverrides || [];
    summary.dateShifts = scenario.dateShifts || [];

    // Project timing analysis
    if (result.schedule && result.schedule.projectSummary) {
        const projects = result.schedule.projectSummary;
        summary.totalProjects = projects.length;

        let onTime = 0;
        let totalDaysVariance = 0;
        let worstLate = 0;

        projects.forEach(project => {
            const finishDate = parseDate(project.FinishDate);
            const targetDueDate = parseDate(endDateOverrides[project.Project] || project.DueDate);

            if (finishDate && targetDueDate) {
                const daysVariance = Math.round((targetDueDate.getTime() - finishDate.getTime()) / (1000 * 60 * 60 * 24));

                if (daysVariance >= 0) onTime++;
                totalDaysVariance += daysVariance;

                if (daysVariance < worstLate) worstLate = daysVariance;
            }
        });

        summary.projectsOnTime = onTime;
        summary.projectsLate = summary.totalProjects - onTime;
        summary.avgDaysVariance = projects.length > 0 ? Math.round(totalDaysVariance / projects.length) : 0;
        summary.worstLateDays = Math.abs(worstLate);
    }

    // Team utilization summary
    if (result.schedule && result.schedule.teamUtilization) {
        const utilizations = result.schedule.teamUtilization.flatMap(week =>
            week.teams.map(team => parseFloat(team.utilization))
        );

        if (utilizations.length > 0) {
            summary.avgUtilization = Math.round(utilizations.reduce((a, b) => a + b, 0) / utilizations.length);
            summary.maxUtilization = Math.round(Math.max(...utilizations));
        }
    }

    return summary;
}

// --- NEW API ENDPOINT: Multi-Scenario Analysis ---
app.post('/api/scenarios', async (req, res) => {
    console.log('Received request to /api/scenarios to start multi-scenario analysis.');
    const jobId = uuidv4();

    jobs[jobId] = {
        status: 'pending',
        progress: 0,
        message: 'Multi-scenario analysis is queued...',
        step: 'starting',
        result: null,
        error: null,
        createdAt: Date.now(),
    };

    const {
        projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
        workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
        startDateOverrides, endDateOverrides, optimizationConfig, scenarioTypes
    } = req.body;

    if (!projectTasks || !params || !teamDefs || !optimizationConfig || !scenarioTypes) {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Missing required data from frontend.';
        return res.status(400).json({ error: jobs[jobId].error });
    }

    res.status(202).json({ jobId });

    (async () => {
        try {
            const updateProgress = (progress, message, step) => {
                if (jobs[jobId]) {
                    jobs[jobId].progress = progress;
                    jobs[jobId].message = message;
                    if (step) jobs[jobId].step = step;
                }
            };

            jobs[jobId].status = 'running';
            updateProgress(5, 'Starting multi-scenario analysis...', 'preparing');

            const results = await runMultiScenarioAnalysis(
                projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
                workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
                startDateOverrides, endDateOverrides, optimizationConfig, scenarioTypes,
                updateProgress
            );

            jobs[jobId].status = 'complete';
            jobs[jobId].progress = 100;
            jobs[jobId].message = 'Multi-scenario analysis complete!';
            jobs[jobId].step = 'done';
            jobs[jobId].result = results;

        } catch (e) {
            console.error(`[Job ${jobId}] Failed to run multi-scenario analysis:`, e);
            jobs[jobId].status = 'error';
            jobs[jobId].error = 'An internal server error occurred during scenario analysis.';
            jobs[jobId].result = { details: e.message };
        }
    })();
});

// --- NEW API ENDPOINT: Optimize Resources ---
app.post('/api/optimize', async (req, res) => {
    console.log('Received request to /api/optimize to start optimization job.');
    const jobId = uuidv4();

    jobs[jobId] = {
        status: 'pending',
        progress: 0,
        message: 'Optimization job is queued...',
        step: 'starting',
        result: null,
        error: null,
        createdAt: Date.now(),
    };

    const { 
        projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
        workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
        startDateOverrides, endDateOverrides, optimizationConfig
    } = req.body;

    if (!projectTasks || !params || !teamDefs || !optimizationConfig) {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Missing required data from frontend.';
        return res.status(400).json({ error: jobs[jobId].error });
    }
    
    res.status(202).json({ jobId });

    (async () => {
        try {
            const updateProgress = (progress, message, step) => {
                if (jobs[jobId]) {
                    jobs[jobId].progress = progress;
                    jobs[jobId].message = message;
                    if (step) jobs[jobId].step = step;
                }
            };

            jobs[jobId].status = 'running';
            updateProgress(5, 'Starting resource optimization...', 'preparing');
            
            const results = await optimizeResources(
                projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
                workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
                startDateOverrides, endDateOverrides, optimizationConfig,
                updateProgress
            );
            
            jobs[jobId].status = 'complete';
            jobs[jobId].progress = 100;
            jobs[jobId].message = results.success ? 'Optimization complete!' : 'Optimization finished with partial solution';
            jobs[jobId].step = 'done';
            jobs[jobId].result = results;

        } catch (e) {
            console.error(`[Job ${jobId}] Failed to run optimization:`, e);
            jobs[jobId].status = 'error';
            jobs[jobId].error = 'An internal server error occurred during optimization.';
            jobs[jobId].result = { details: e.message };
        }
    })();
});
// --- Health Check Endpoints ---
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Production Scheduler Backend',
        version: '2.0',
        uptime: process.uptime(),
        activeJobs: Object.keys(jobs).length
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        activeJobs: Object.keys(jobs).length
    });
});

// --- API Endpoints ---
app.post('/api/schedule', async (req, res) => {
    console.log('Received request to /api/schedule to start a new job.');
    const jobId = uuidv4();

    jobs[jobId] = {
        status: 'pending',
        progress: 0,
        message: 'Job is queued...',
        step: 'starting',
        result: null,
        error: null,
        createdAt: Date.now(),
    };

    const { 
        projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
        workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
        startDateOverrides, endDateOverrides 
    } = req.body;

    if (!projectTasks || !params || !teamDefs) {
        jobs[jobId].status = 'error';
        jobs[jobId].error = 'Missing required data from frontend.';
        return res.status(400).json({ error: jobs[jobId].error });
    }
    
    res.status(202).json({ jobId });

    (async () => {
        try {
            const updateProgress = (progress, message, step) => {
                if (jobs[jobId]) {
                    jobs[jobId].progress = progress;
                    jobs[jobId].message = message;
                    if (step) jobs[jobId].step = step;
                }
            };

            jobs[jobId].status = 'running';
            updateProgress(0, 'Preparing project data...', 'preparing');
            
            const { tasks: preparedTasks, logs: prepLogs, completedTasks } = await prepareProjectData(projectTasks, updateProgress);

            if (preparedTasks.length === 0) {
                const combinedLogs = [...prepLogs, "All tasks for the submitted projects are already complete."];
                jobs[jobId].status = 'complete';
                jobs[jobId].progress = 100;
                jobs[jobId].message = 'All tasks were already completed.';
                jobs[jobId].step = 'done';
                jobs[jobId].result = { 
                    finalSchedule: [], projectSummary: [], teamUtilization: [], weeklyOutput: [],
                    dailyCompletions: [], teamWorkload: [],
                    projectedCompletion: null, logs: combinedLogs, completedTasks, error: '' 
                };
                return;
            }

            updateProgress(15, 'Starting scheduling simulation...', 'simulating');
            
            const results = await runSchedulingEngine(
                preparedTasks, params, teamDefs, ptoEntries, teamMemberChanges,
                workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
                startDateOverrides, endDateOverrides,
                updateProgress
            );
            
            const combinedLogs = [...prepLogs, ...(results.logs || [])];
            
            jobs[jobId].status = 'complete';
            jobs[jobId].progress = 100;
            jobs[jobId].message = 'Scheduling complete!';
            jobs[jobId].step = 'done';
            jobs[jobId].result = { ...results, logs: combinedLogs, completedTasks };

        } catch (e) {
            console.error(`[Job ${jobId}] Failed to run scheduling engine:`, e);
            jobs[jobId].status = 'error';
            jobs[jobId].error = 'An internal server error occurred during scheduling.';
            jobs[jobId].result = { details: e.message };
        }
    })();
});

app.get('/api/schedule/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    res.json(job);
});

// Catch-all error handler for Express (must be after all routes)
app.use((err, req, res, next) => {
    console.error('Express Error Handler:', err);
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({
        error: 'Internal Server Error',
        message: err.message,
        path: req.path
    });
});

// --- Start Server ---
const startServer = async () => {
    await loadMasterRoutingData();
    
    console.log("Testing Snowflake pool connection...");
    try {
        await snowflakePool.use(async (connection) => {
            await connection.execute({ sqlText: 'SELECT 1;' });
        });
        console.log('Successfully connected to Snowflake and tested the connection pool.');
    } catch (err) {
        console.error(`WARNING: Could not establish initial connection to Snowflake via the pool. The server will still start, but queries will fail until the connection is restored. Error: ${err.message}`);
    }

    app.listen(port, '0.0.0.0', () => {
        console.log(`SERVER IS LIVE AND LISTENING ON ALL INTERFACES - Port: ${port}`);
    });
};

// Global error handlers
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION:', error);
    console.error('Stack:', error.stack);
    // Don't exit - let the server keep running
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('UNHANDLED REJECTION at:', promise);
    console.error('Reason:', reason);
    // Don't exit - let the server keep running
});

startServer();
