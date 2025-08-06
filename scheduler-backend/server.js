// server.js
// This is the backend server for your Production Scheduling Engine.
// It now includes logic for Snowflake integration and dynamic master routing data from a Google Sheet.

require('dotenv').config(); // Loads environment variables from a .env file
const express = require('express');
const cors = require('cors');
const snowflake = require('snowflake-sdk');
const fetch = require('node-fetch'); // Use node-fetch for making http requests in Node

// --- Setup ---
const app = express();
const port = 3001;

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// --- CONSTANTS ---
const TEAM_SORT_ORDER = ['CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'Hybrid'];

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
            
            groupedData[projectType].push({
                "Operation": row.Operation,
                "Estimated Hours": parseFloat(row['Estimated Hours']),
                "Order": parseInt(row.Order, 10),
                "SKU": row.SKU,
                "SKU Name": row['SKU Name'],
                "Value": parseFloat(row.Value)
            });
        }
        
        for(const projectType in groupedData) {
            groupedData[projectType].sort((a, b) => a.Order - b.Order);
        }

        masterRoutingData = groupedData;
        console.log(`Successfully loaded routing for ${Object.keys(masterRoutingData).length} project types.`);

    } catch (error) {
        console.error(`Failed to load master routing data: ${error.message}`);
        console.error("CRITICAL: The server will shut down. Please fix the MASTER_ROUTING_URL or your network connection.");
        process.exit(1);
    }
}

// =================================================================
// --- SNOWFLAKE CONNECTION ---
// =================================================================
const snowflakeConnection = snowflake.createConnection({
    account: process.env.SNOWFLAKE_ACCOUNT,
    username: process.env.SNOWFLAKE_USER,
    password: process.env.SNOWFLAKE_PASSWORD,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA
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
async function prepareProjectData(projectTasks) {
    const logs = [];
    const projectNumbers = [...new Set(projectTasks.map(p => p['Project']))];

    if (projectNumbers.length === 0) {
        return { tasks: [], logs: ["No projects were provided to prepare."], completedTasks: [] };
    }

    let completedOperationsSet = new Set();
    let completedTasksForReport = [];
    
    if (!snowflakeConnection.isUp()) {
        logs.push('Snowflake connection is down. Cannot fetch live data. Proceeding with template routing only.');
    } else {
        const placeholders = projectNumbers.map(() => '?').join(',');
        const query = `
            SELECT JOBNAME, ITEMREFERENCE_NUMBER, JOBOPERATIONNAME, CREATEDUTC
            FROM JOBLOG 
            WHERE LOGTYPE = 'OperationRunCompleted'
            AND JOBNAME IN (${placeholders});
        `;

        const liveCompletedTasks = await new Promise((resolve) => {
            snowflakeConnection.execute({
                sqlText: query,
                binds: projectNumbers,
                complete: (err, stmt, rows) => {
                    if (err) {
                        logs.push(`SQL Error fetching completed operations: ${err.message}. Proceeding without live data.`);
                        resolve([]);
                    } else {
                        logs.push(`Found ${rows.length} completed operations in Snowflake.`);
                        resolve(rows);
                    }
                }
            });
        });

        liveCompletedTasks.forEach(row => {
            const key = `${row.JOBNAME}|${row.ITEMREFERENCE_NUMBER}|${row.JOBOPERATIONNAME}`;
            completedOperationsSet.add(key);
            completedTasksForReport.push({
                Project: row.JOBNAME,
                SKU: row.ITEMREFERENCE_NUMBER,
                Operation: row.JOBOPERATIONNAME,
                CompletionDate: formatDate(row.CREATEDUTC)
            });
        });
    }

    const remainingTasks = projectTasks.filter(task => {
        const operationKey = `${task.Project}|${task.SKU}|${task.Operation}`;
        return !completedOperationsSet.has(operationKey);
    });

    logs.push(`Filtered out ${projectTasks.length - remainingTasks.length} completed operations based on Snowflake data.`);
    
    return { tasks: remainingTasks, logs, completedTasks: completedTasksForReport };
}


// --- Core Scheduling Logic ---
const runSchedulingEngine = async (
    preparedTasks, params, teamDefs, ptoEntries, teamMemberChanges,
    workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap
) => {
    const logs = [];
    let error = '';

    const assignTeams = (df, mapping) => {
        const teamMap = mapping.reduce((acc, curr) => ({...acc, [curr.operation]: curr.team }), {});
        return df.map(row => ({ ...row, Team: teamMap[row.Operation] || 'Unassigned' }));
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
        const holidayList = new Set(params.holidays.split(',').map(d => d.trim()).filter(Boolean));
        const ptoMap = ptoEntries.reduce((acc, curr) => { if (curr.date && curr.memberName) { if (!acc[curr.date]) acc[curr.date] = new Set(); acc[curr.date].add(curr.memberName.trim()); } return acc; }, {});
        const teamMapping = teamDefs.mapping;
        let teamHeadcounts = teamDefs.headcounts.reduce((acc, t) => ({...acc, [t.name]: t.count}), {});
        const teamsToIgnoreList = params.teamsToIgnore.split(',').map(t => t.trim());

        let all_tasks_with_teams = preparedTasks.map(row => ({...row}));
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

        const schedulableTasksMap = new Map();
        operations_df.forEach(task => {
            const key = `${task.Project}|${task.SKU}`;
            if (!schedulableTasksMap.has(key)) schedulableTasksMap.set(key, []);
            schedulableTasksMap.get(key).push(task);
        });

        let unscheduled_tasks = [...operations_df];
        let current_date = parseDate(params.startDate);
        let daily_log_entries = [], completed_operations = [];
        logs.push(`Starting with ${unscheduled_tasks.length} schedulable tasks.`);
        let loopCounter = 0; const maxDays = 365 * 2;
        let dailyDwellingData = {};

        while(unscheduled_tasks.length > 0 && loopCounter < maxDays) {
            const dayOfWeek = current_date.getDay();
            const currentDateStr = formatDate(current_date);
            if (dayOfWeek === 6 || dayOfWeek === 0 || holidayList.has(currentDateStr)) {
                current_date.setDate(current_date.getDate() + 1);
                loopCounter++;
                continue;
            }
            
            const ready_tasks_for_dwelling_check = unscheduled_tasks.filter(task => {
                if (current_date < task.StartDate) return false;
                const key = `${task.Project}|${task.SKU}`;
                const allSkuTasks = schedulableTasksMap.get(key) || [];
                const predecessors = allSkuTasks.filter(t => t.Order < task.Order).sort((a, b) => b.Order - a.Order);
                if (predecessors.length === 0) return true;
                const lastSchedulablePredecessor = predecessors[0];
                return completed_operations.some(c => c.TaskID === lastSchedulablePredecessor.TaskID);
            });
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
            teamMemberChanges.forEach(change => { if(currentDateStr >= change.date) { if(!dailyRoster[change.team]) dailyRoster[change.team] = new Set(); if(change.type === 'Starts') dailyRoster[change.team].add(change.name); else dailyRoster[change.team].delete(change.name); } });
            hybridWorkers.forEach(h => {
                if (!dailyRoster[h.primaryTeam]) dailyRoster[h.primaryTeam] = new Set();
                dailyRoster[h.primaryTeam].add(h.name);
            });
            const dailyHoursMap = {};
            Object.keys(dailyRoster).forEach(team => { let hours = parseFloat(params.hoursPerDay); const override = workHourOverrides.find(o => o.team === team && currentDateStr >= o.startDate && currentDateStr <= o.endDate); if (override) hours = parseFloat(override.hours); dailyHoursMap[team] = hours; });
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
                const ready_tasks = unscheduled_tasks.filter(task => {
                    if (current_date < task.StartDate) return false;
                    const key = `${task.Project}|${task.SKU}`;
                    const allSkuTasks = schedulableTasksMap.get(key) || [];
                    const predecessors = allSkuTasks.filter(t => t.Order < task.Order).sort((a, b) => b.Order - a.Order);
                    if (predecessors.length === 0) return true;
                    const lastSchedulablePredecessor = predecessors[0];
                    return completed_operations.some(c => c.TaskID === lastSchedulablePredecessor.TaskID);
                }).sort((a,b) => b.DynamicPriority - a.DynamicPriority);

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
                                            daily_log_entries.push({ ...task_to_assign, Date: currentDateStr, 'Task Hours Completed': Number(task_hours_to_complete.toFixed(2)), 'Time Spent (Hours)': Number(time_to_spend_on_task.toFixed(2)), TeamMember: member_for_task, TeamMemberName: teamMemberNameMap[member_for_task] || member_for_task });
                                            skus_being_worked_on_today.add(task_to_assign.SKU);
                                            const taskInArray = unscheduled_tasks.find(t => t.TaskID === task_to_assign.TaskID);
                                            taskInArray.HoursRemaining -= task_hours_to_complete;
                                            memberInPool.SchedulableHoursLeft -= time_to_spend_on_task;
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
            current_date.setDate(current_date.getDate() + 1);
            loopCounter++;
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
        
        const newRecommendations = [];
        const workloadThreshold = 120;
        const consecutiveWeeksThreshold = 2;
        const teamOverloadStreaks = {};
        teamWorkload.forEach(weekData => {
            weekData.teams.forEach(team => {
                if (!teamOverloadStreaks[team.name]) teamOverloadStreaks[team.name] = { streak: 0, weeks: [] };
                if (team.workloadRatio > workloadThreshold) {
                    teamOverloadStreaks[team.name].streak++;
                    teamOverloadStreaks[team.name].weeks.push(weekData.week);
                } else {
                    if (teamOverloadStreaks[team.name].streak >= consecutiveWeeksThreshold) newRecommendations.push({ team: team.name, weeks: [...teamOverloadStreaks[team.name].weeks], type: 'overload' });
                    teamOverloadStreaks[team.name] = { streak: 0, weeks: [] };
                }
            });
        });
        for (const teamName in teamOverloadStreaks) {
            if (teamOverloadStreaks[teamName].streak >= consecutiveWeeksThreshold) newRecommendations.push({ team: teamName, weeks: [...teamOverloadStreaks[teamName].weeks], type: 'overload' });
        }
        const recommendations = newRecommendations.map(rec => {
            const startWeek = rec.weeks[0];
            const endWeekDate = new Date(parseDate(rec.weeks[rec.weeks.length - 1]).getTime() + 6 * 24 * 60 * 60 * 1000);
            const contributingProjects = daily_log_entries.filter(log => { const logDate = parseDate(log.Date); return log.Team === rec.team && logDate >= parseDate(startWeek) && logDate <= endWeekDate; }).reduce((acc, log) => { acc[log.Project] = (acc[log.Project] || 0) + log['Time Spent (Hours)']; return acc; }, {});
            const topProjects = Object.entries(contributingProjects).sort(([, hoursA], [, hoursB]) => hoursB - hoursA).slice(0, 3).map(([projectName]) => projectName);
            return { ...rec, topProjects };
        });


        return { finalSchedule, projectSummary, teamUtilization, weeklyOutput, dailyCompletions, teamWorkload, recommendations, projectedCompletion, logs, error };

    } catch (e) {
        console.error("Critical error in scheduling engine:", e);
        logs.push(`Critical Error: ${e.message}`);
        return { error: `A critical error occurred on the server: ${e.message}`, logs };
    }
};

// --- API Endpoints ---
app.post('/api/schedule', async (req, res) => {
    console.log('Received request to /api/schedule');
    
    const { 
        projectTasks, params, teamDefs, ptoEntries, teamMemberChanges,
        workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap
    } = req.body;

    if (!projectTasks || !params || !teamDefs) {
        return res.status(400).json({ error: 'Missing required data from frontend.' });
    }

    try {
        const { tasks: preparedTasks, logs: prepLogs, completedTasks } = await prepareProjectData(projectTasks);

        if (preparedTasks.length === 0) {
            const combinedLogs = [...prepLogs, "All tasks for the submitted projects are already complete."];
            return res.json({ 
                finalSchedule: [], 
                projectSummary: [], 
                teamUtilization: [], 
                weeklyOutput: [],
                dailyCompletions: [],
                teamWorkload: [],
                recommendations: [],
                projectedCompletion: null, 
                logs: combinedLogs, 
                completedTasks: completedTasks,
                error: '' 
            });
        }

        const results = await runSchedulingEngine(
            preparedTasks, params, teamDefs, ptoEntries, teamMemberChanges,
            workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap
        );
        
        const combinedLogs = [...prepLogs, ...(results.logs || [])];
        res.json({ ...results, logs: combinedLogs, completedTasks });

    } catch (e) {
        console.error('Failed to run scheduling engine:', e);
        res.status(500).json({ error: 'An internal server error occurred.', details: e.message });
    }
});


// --- Start Server ---
const startServer = async () => {
    await loadMasterRoutingData();
    
    try {
        await new Promise((resolve, reject) => {
            snowflakeConnection.connect((err, conn) => {
                if (err) {
                    console.error('Unable to connect to Snowflake: ' + err.message);
                    reject(err);
                } else {
                    console.log('Successfully connected to Snowflake.');
                    resolve(conn);
                }
            });
        });
    } catch (err) {
        console.error("CRITICAL: Could not establish initial connection to Snowflake. Server will start but will not be able to query live data.");
    }

    app.listen(port, () => {
        console.log(`Scheduler backend listening on http://localhost:${port}`);
    });
};

startServer();
