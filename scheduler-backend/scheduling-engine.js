// =================================================================
// Scheduling Engine — Standalone Module
// =================================================================
// Extracted from server.js to enable direct import by:
//   - Autoresearch optimization runner
//   - MCP server for agent-driven scheduling
//   - CLI tools
//
// Zero external dependencies. No Express, no Snowflake.
// Callers are responsible for preparing task data before calling.
// =================================================================

const { NOOP_TIMINGS } = require('./timings');

// --- Default Priority Weights ---
// These are the 12 tunable parameters that drive the priority scoring formula.
// Pass a partial override object as the last argument to runSchedulingEngine()
// to customize any subset. Omitted keys fall back to these defaults.
const DEFAULT_PRIORITY_WEIGHTS = {
    // Project type multipliers — higher = scheduled earlier
    projectTypeMultipliers: {
        NSO: 1.5,
        INFILL: 1.3,
        RENO: 1.15,
        PC: 1.0,
    },

    // Due date scoring — past-due tasks
    pastDueBase: 100,          // Base multiplier when task is past due
    pastDueGrowthRate: 1.1,    // Exponential growth rate per day past due

    // Due date scoring — on-time tasks
    dueDateNumerator: 60,      // Numerator in urgency curve: 1 + (N / (daysUntilDue + 1))

    // Assembly group synchronization
    assemblyLeadBoost: 1.3,        // Priority boost for lead SKU pre-assembly work
    assemblyNonLeadHoldback: 0.75, // Priority reduction for non-lead SKU work

    // In-progress boost — tasks actively being worked on in Fulcrum
    inProgressBoost: 5.0,      // Priority multiplier for Running/Paused operations

    // Past-due linear transition — exponential growth switches to linear after this many days
    pastDueLinearThreshold: 30, // Days past due before switching to linear growth

    // Dwell time (idle sequential operations)
    dwellThresholdDays: 7,     // Days before dwell boost kicks in
    dwellCap: 3.0,             // Maximum dwell multiplier

    // Assembly impact tiers — based on Final Assembly estimated hours
    // Evaluated top-down: first match where assemblyHours >= threshold wins
    assemblyImpactTiers: [
        { threshold: 15, multiplier: 3 },
        { threshold: 8, multiplier: 2 },
        { threshold: 0, multiplier: 1 },
    ],

    // Assembly constraint tiers — based on steps before Final Assembly
    // Special case: 0 steps = first entry. Then evaluated ascending: first match where steps <= threshold wins.
    assemblyConstraintTiers: [
        { threshold: 0, multiplier: 1 },
        { threshold: 2, multiplier: 2 },
        { threshold: 4, multiplier: 1.5 },
    ],
    assemblyConstraintDefault: 1,  // Fallback when steps exceed all tiers
};

const TEAM_SORT_ORDER = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC', 'Hybrid'];

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

// --- Core Scheduling Logic ---
const runSchedulingEngine = async (
    preparedTasks, params, teamDefs, ptoEntries, teamMemberChanges,
    workHourOverrides, hybridWorkers, efficiencyData, teamMemberNameMap,
    startDateOverrides, endDateOverrides,
    updateProgress,
    priorityWeights,
    timings = NOOP_TIMINGS
) => {
    const logs = [];
    let error = '';
    timings.mark('engine.total.start');
    timings.mark('engine.setup.start');
    timings.note('inputTaskCount', preparedTasks.length);
    // perf_hooks.performance.now() is used for hot-path deltas. Must be
    // bound to the performance object or Node errors on `this` check.
    const _perf = require('perf_hooks').performance;
    const perfNow = () => _perf.now();

    // Merge caller-provided weight overrides with defaults
    const weights = { ...DEFAULT_PRIORITY_WEIGHTS, ...priorityWeights };
    weights.projectTypeMultipliers = {
        ...DEFAULT_PRIORITY_WEIGHTS.projectTypeMultipliers,
        ...(priorityWeights?.projectTypeMultipliers || {}),
    };
    weights.assemblyImpactTiers =
        priorityWeights?.assemblyImpactTiers || DEFAULT_PRIORITY_WEIGHTS.assemblyImpactTiers;
    weights.assemblyConstraintTiers =
        priorityWeights?.assemblyConstraintTiers || DEFAULT_PRIORITY_WEIGHTS.assemblyConstraintTiers;

    const PROJECT_TYPE_MULTIPLIERS = weights.projectTypeMultipliers;

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
            // Assembly impact: evaluate tiers top-down (highest threshold first)
            let assemblyImpact = 1;
            for (const tier of weights.assemblyImpactTiers) {
                if (assemblyHours >= tier.threshold) { assemblyImpact = tier.multiplier; break; }
            }
            // Assembly constraint: 0 steps = first tier, then ascending threshold match
            let assemblyConstraint = weights.assemblyConstraintDefault;
            if (stepsBeforeAssembly === 0) {
                assemblyConstraint = weights.assemblyConstraintTiers[0]?.multiplier ?? 1;
            } else {
                for (let i = 1; i < weights.assemblyConstraintTiers.length; i++) {
                    if (stepsBeforeAssembly <= weights.assemblyConstraintTiers[i].threshold) {
                        assemblyConstraint = weights.assemblyConstraintTiers[i].multiplier; break;
                    }
                }
            }
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

        // =========================================================
        // ASSEMBLY GROUP SYNCHRONIZATION - Data Structure Setup
        // =========================================================
        // Build a map of assembly groups: groupKey -> { skus, skuInfo, leadSku }
        // This enables cross-SKU dependencies at Final Assembly
        const assemblyGroupMap = new Map();

        operations_df.forEach(task => {
            if (!task.AssemblyGroup) return;

            const groupKey = `${task.Project}|${task.AssemblyGroup}`;

            if (!assemblyGroupMap.has(groupKey)) {
                assemblyGroupMap.set(groupKey, {
                    project: task.Project,
                    groupName: task.AssemblyGroup,
                    skus: new Set(),
                    skuInfo: new Map() // SKU -> { finalAssemblyOrder, preAssemblyTasks[], totalPreAssemblyHours }
                });
            }

            const group = assemblyGroupMap.get(groupKey);
            group.skus.add(task.SKU);

            if (!group.skuInfo.has(task.SKU)) {
                group.skuInfo.set(task.SKU, {
                    finalAssemblyOrder: Infinity,
                    preAssemblyTasks: [],
                    totalPreAssemblyHours: 0
                });
            }

            const skuInfo = group.skuInfo.get(task.SKU);
            if (task.Operation === 'Final Assembly') {
                skuInfo.finalAssemblyOrder = task.Order;
            }
        });

        // Second pass: classify pre-assembly tasks and identify lead SKU
        assemblyGroupMap.forEach((group, groupKey) => {
            group.skuInfo.forEach((info, sku) => {
                const skuKey = `${group.project}|${sku}`;
                const allSkuTasks = schedulableTasksMap.get(skuKey) || [];

                info.preAssemblyTasks = allSkuTasks.filter(t => t.Order < info.finalAssemblyOrder);
                info.totalPreAssemblyHours = info.preAssemblyTasks.reduce(
                    (sum, t) => sum + (t['Estimated Hours'] || 0), 0
                );
            });

            // Lead SKU = the one with the most pre-assembly hours
            let leadSku = null;
            let maxHours = 0;
            group.skuInfo.forEach((info, sku) => {
                if (info.totalPreAssemblyHours > maxHours) {
                    maxHours = info.totalPreAssemblyHours;
                    leadSku = sku;
                }
            });
            group.leadSku = leadSku;
        });

        // Build fast per-task lookup: TaskID -> { groupKey, isPreAssembly, isFinalAssembly, isLeadSku }
        const assemblyGroupTaskLookup = new Map();
        operations_df.forEach(task => {
            if (!task.AssemblyGroup) return;

            const groupKey = `${task.Project}|${task.AssemblyGroup}`;
            const group = assemblyGroupMap.get(groupKey);
            if (!group) return;

            const skuInfo = group.skuInfo.get(task.SKU);
            if (!skuInfo) return;

            const isFinalAssembly = task.Operation === 'Final Assembly';
            const isPreAssembly = task.Order < skuInfo.finalAssemblyOrder;
            const isLeadSku = task.SKU === group.leadSku;

            assemblyGroupTaskLookup.set(task.TaskID, {
                groupKey,
                isPreAssembly,
                isFinalAssembly,
                isLeadSku,
                isPostAssembly: !isPreAssembly && !isFinalAssembly
            });
        });

        // Log assembly group info
        if (assemblyGroupMap.size > 0) {
            assemblyGroupMap.forEach((group, groupKey) => {
                logs.push(`\n--- Assembly Group: "${group.groupName}" (${groupKey}) ---`);
                logs.push(`  SKUs: ${group.skus.size}, Lead SKU: ${group.leadSku}`);
                group.skuInfo.forEach((info, sku) => {
                    logs.push(`  ${sku}: ${info.preAssemblyTasks.length} pre-assembly ops (${info.totalPreAssemblyHours.toFixed(1)} hrs), Final Assembly at Order ${info.finalAssemblyOrder === Infinity ? 'N/A' : info.finalAssemblyOrder}`);
                });
            });
        }
        // =========================================================
        // END ASSEMBLY GROUP SYNCHRONIZATION - Data Structure Setup
        // =========================================================

        // =========================================================
        // DELAYED SKU CALCULATION - "Just-in-Time" Scheduling
        // =========================================================
        // Certain SKUs (e.g., IT Package BOH-107) have subscription fees
        // that start when set up. These should be scheduled as late as
        // possible to avoid unnecessary costs.
        // Flag comes from Google Sheet "DelayUntilClose" column, with a
        // hardcoded fallback list for SKUs that should always be delayed.
        const HARDCODED_DELAYED_SKUS = new Set([
            'BOH-107',  // IT Package - subscription fees
            'CC-405C',  // Clue Cranium
            'R-401',    // Ruins
            'D-155',    // Depths
            'GR-143',   // Gold Rush
            'LY-401',   // Lucky
            'PB-141',   // Prison Break
            'PG-139',   // Playground
            'RU-406',   // Rush Hour (previously Heist)
            'SP-147',   // Special Agent
            'TH-140',   // The Heist
            'TL-406',   // Time Lab (previously unknown)
            // Note: These SKUs are typically done late in the process and
            // should not be pulled forward by the scheduler.
        ]);
        const DELAY_BUFFER_DAYS = 15; // work days of safety margin before due date

        const delayedSkuStartDates = new Map(); // key: "Project|SKU" -> lateStartDate

        schedulableTasksMap.forEach((tasks, key) => {
            // A SKU is delayed if ANY of its tasks has the flag from routing data,
            // OR if the SKU is in the hardcoded fallback list
            const isDelayed = tasks.some(t => t.DelayUntilClose) || HARDCODED_DELAYED_SKUS.has(tasks[0].SKU);
            if (!isDelayed) return;

            // Sum total estimated hours for all operations in this SKU
            const totalHours = tasks.reduce((sum, t) => sum + (t['Estimated Hours'] || 0), 0);

            // Sum total lag hours between operations
            const totalLagHours = tasks.reduce((sum, t) => sum + (t.LagAfterHours || 0), 0);

            const hoursPerWorkDay = parseFloat(params.hoursPerDay) || 8;
            const productivity = parseFloat(params.productivityAssumption) || 0.78;

            // Convert to work days needed (accounting for productivity)
            const workDaysNeeded = Math.ceil((totalHours / productivity) / hoursPerWorkDay);
            const lagDaysNeeded = Math.ceil(totalLagHours / hoursPerWorkDay);
            const totalDaysNeeded = workDaysNeeded + lagDaysNeeded + DELAY_BUFFER_DAYS;

            // Get the DueDate from the first task (all tasks in a SKU share the same DueDate)
            const dueDate = tasks[0].DueDate;
            if (!dueDate) return;

            // Walk backward from DueDate, skipping weekends and holidays
            let lateStartDate = new Date(dueDate);
            let daysSubtracted = 0;
            while (daysSubtracted < totalDaysNeeded) {
                lateStartDate.setDate(lateStartDate.getDate() - 1);
                const dow = lateStartDate.getDay();
                const dateStr = formatDate(lateStartDate);
                if (dow !== 0 && dow !== 6 && !holidayList.has(dateStr)) {
                    daysSubtracted++;
                }
            }

            // If late start is before the project's original StartDate, fall back
            const originalStartDate = tasks[0].StartDate;
            if (lateStartDate < originalStartDate) {
                lateStartDate = new Date(originalStartDate);
                logs.push(`WARNING: Delayed SKU ${tasks[0].SKU} (${tasks[0]['SKU Name'] || ''}) in ${tasks[0].Project} cannot be fully delayed - insufficient time before due date. Falling back to project start date.`);
            }

            delayedSkuStartDates.set(key, lateStartDate);
            logs.push(`Delayed SKU: ${tasks[0].SKU} (${tasks[0]['SKU Name'] || ''}) in ${tasks[0].Project} - late start: ${formatDate(lateStartDate)} (needs ${totalDaysNeeded} work days before due ${formatDate(dueDate)})`);
        });

        // Warn about assembly group conflicts with delayed SKUs
        if (delayedSkuStartDates.size > 0 && assemblyGroupMap.size > 0) {
            assemblyGroupMap.forEach((group, groupKey) => {
                const delayedSkus = [];
                const nonDelayedSkus = [];
                group.skus.forEach(sku => {
                    const skuKey = `${group.project}|${sku}`;
                    if (delayedSkuStartDates.has(skuKey)) {
                        delayedSkus.push(sku);
                    } else {
                        nonDelayedSkus.push(sku);
                    }
                });
                if (delayedSkus.length > 0 && nonDelayedSkus.length > 0) {
                    logs.push(`WARNING: Assembly group "${group.groupName}" contains both delayed SKUs (${delayedSkus.join(', ')}) and non-delayed SKUs (${nonDelayedSkus.join(', ')}). The delayed SKUs will hold up Final Assembly for the entire group.`);
                }
            });
        }

        if (delayedSkuStartDates.size > 0) {
            logs.push(`Total delayed SKUs: ${delayedSkuStartDates.size}`);
        }
        // =========================================================
        // END DELAYED SKU CALCULATION
        // =========================================================

        let unscheduled_tasks = [...operations_df];
        const totalWorkloadHours = unscheduled_tasks.reduce((sum, task) => sum + task['Estimated Hours'], 0);
        let totalHoursCompleted = 0;
        let current_date = parseDate(params.startDate);
        let daily_log_entries = [], completed_operations = [], dailyPrioritySnapshots = [];
        const completedTaskIDs = new Set(); // O(1) lookup for assembly group gate checks
        // O(1) lookup by TaskID — kept in sync with completed_operations.push()
        // so isReady() predecessor checks avoid O(N) linear scans.
        const completedByTaskId = new Map();
        logs.push(`Starting with ${unscheduled_tasks.length} schedulable tasks.`);
        let loopCounter = 0; const maxDays = 365 * 2;
        let dailyDwellingData = {};

        // Overtime tracking: max 3 months, then 1 month cooldown
        const overtimeTracking = {}; // { team: { startDate, endDate, inCooldown, cooldownEndDate } }
        const MAX_OVERTIME_DAYS = 90; // 3 months
        const COOLDOWN_DAYS = 30; // 1 month

        const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

        // Dwell time tracking: records when each operation completes per SKU+Order,
        // so we can boost priority of tasks waiting too long after their predecessor finished
        const completionBySkuOrder = new Map(); // key: "Project|SKU|Order" -> Date
        const maxIdleDays = parseFloat(params.maxIdleDays) || weights.dwellThresholdDays;

        // --- Phase 2 indexes ---
        // Build once so hot-path callers get O(1) lookups instead of O(N) .find() scans.
        const hybridByName = new Map(hybridWorkers.map(h => [h.name, h]));
        const hybridsBySecondaryTeam = new Map();
        for (const h of hybridWorkers) {
            if (!h.secondaryTeam) continue;
            if (!hybridsBySecondaryTeam.has(h.secondaryTeam)) hybridsBySecondaryTeam.set(h.secondaryTeam, []);
            hybridsBySecondaryTeam.get(h.secondaryTeam).push(h);
        }
        const workHourOverridesByTeam = new Map();
        for (const o of workHourOverrides) {
            if (!workHourOverridesByTeam.has(o.team)) workHourOverridesByTeam.set(o.team, []);
            workHourOverridesByTeam.get(o.team).push(o);
        }
        const findWorkHourOverride = (team, dateStr) => {
            const list = workHourOverridesByTeam.get(team);
            if (!list) return undefined;
            for (const o of list) {
                if (dateStr >= o.startDate && dateStr <= o.endDate) return o;
            }
            return undefined;
        };

        // Pre-compute project-type multiplier per task — value depends only on
        // task.ProjectType, which is stable across the whole run. Reuses the
        // existing `_projectTypeMultiplier` field so no new field appears in output.
        unscheduled_tasks.forEach(t => {
            t._projectTypeMultiplier =
                PROJECT_TYPE_MULTIPLIERS[(t.ProjectType || '').toUpperCase()] || 1.0;
        });

        timings.mark('engine.setup.end');
        timings.mark('engine.mainLoop.start');

        while(unscheduled_tasks.length > 0 && loopCounter < maxDays) {
            const dayOfWeek = current_date.getDay();
            const currentDateStr = formatDate(current_date);
            if (dayOfWeek === 6 || dayOfWeek === 0 || holidayList.has(currentDateStr)) {
                current_date.setDate(current_date.getDate() + 1);
                loopCounter++;
                continue;
            }
            
            // --- MODIFIED SECTION ---
            // isReady: checks LagAfterHours + Assembly Group gate at Final Assembly.
            // Helper: checks if all sibling SKUs' pre-assembly work is done
            const checkAssemblyGroupReady = (task, groupKey) => {
                const group = assemblyGroupMap.get(groupKey);
                if (!group) return true;

                for (const [siblingSkU, siblingInfo] of group.skuInfo) {
                    for (const preTask of siblingInfo.preAssemblyTasks) {
                        if (!completedTaskIDs.has(preTask.TaskID)) {
                            return false; // A sibling still has unfinished pre-assembly work
                        }
                    }
                }
                return true; // All siblings' pre-assembly work is done
            };

            const isReady = (task) => {
                const _t0 = perfNow();
                timings.bump('isReady.calls');
                if (current_date < task.StartDate) { timings.inc('isReady.ms', perfNow() - _t0); return false; }

                // Delayed SKU gate: don't start until calculated late-start date
                const skuKey = `${task.Project}|${task.SKU}`;
                const lateStartDate = delayedSkuStartDates.get(skuKey);
                if (lateStartDate && current_date < lateStartDate) { timings.inc('isReady.ms', perfNow() - _t0); return false; }

                const key = `${task.Project}|${task.SKU}`;
                const allSkuTasks = schedulableTasksMap.get(key) || [];
                const predecessors = allSkuTasks.filter(t => t.Order < task.Order);

                if (predecessors.length === 0) {
                    // First operation in this SKU - check assembly group gate
                    // (handles cases like D-104 where Final Assembly IS the first op)
                    const taskGroupInfo = assemblyGroupTaskLookup.get(task.TaskID);
                    if (taskGroupInfo && taskGroupInfo.isFinalAssembly) {
                        const r = checkAssemblyGroupReady(task, taskGroupInfo.groupKey);
                        timings.inc('isReady.ms', perfNow() - _t0);
                        return r;
                    }
                    timings.inc('isReady.ms', perfNow() - _t0);
                    return true;
                }

                const predecessorsReady = predecessors.every(p => {
                    timings.bump('isReady.completedOpsFind');
                    const completedPredecessor = completedByTaskId.get(p.TaskID);
                    if (!completedPredecessor) {
                        return false; // Predecessor isn't done yet
                    }

                    // QC gets items the same day they're done — no buffer delay
                    if (task.Team === 'QC') {
                        return true;
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

                if (!predecessorsReady) { timings.inc('isReady.ms', perfNow() - _t0); return false; }

                // Assembly Group gate: if this is Final Assembly in a group,
                // all sibling SKUs must have their pre-assembly work done
                const taskGroupInfo = assemblyGroupTaskLookup.get(task.TaskID);
                if (taskGroupInfo && taskGroupInfo.isFinalAssembly) {
                    const r = checkAssemblyGroupReady(task, taskGroupInfo.groupKey);
                    timings.inc('isReady.ms', perfNow() - _t0);
                    return r;
                }

                timings.inc('isReady.ms', perfNow() - _t0);
                return true;
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

            const _pPriStart = perfNow();
            unscheduled_tasks.forEach(task => {
                const daysUntilDue = (task.DueDate - current_date) / (1000 * 60 * 60 * 24);
                let dueDateMultiplier;
                if (daysUntilDue < 0) {
                    const daysPastDue = -daysUntilDue;
                    if (daysPastDue <= weights.pastDueLinearThreshold) {
                        // Exponential growth for recently past-due tasks
                        dueDateMultiplier = weights.pastDueBase * Math.pow(weights.pastDueGrowthRate, daysPastDue);
                    } else {
                        // Linear growth beyond threshold — prevents overflow while maintaining urgency
                        const valueAtThreshold = weights.pastDueBase * Math.pow(weights.pastDueGrowthRate, weights.pastDueLinearThreshold);
                        const slopeAtThreshold = weights.pastDueBase * Math.log(weights.pastDueGrowthRate) * Math.pow(weights.pastDueGrowthRate, weights.pastDueLinearThreshold);
                        dueDateMultiplier = valueAtThreshold + slopeAtThreshold * (daysPastDue - weights.pastDueLinearThreshold);
                    }
                } else {
                    dueDateMultiplier = 1 + (weights.dueDateNumerator / (daysUntilDue + 1));
                }

                // Assembly Group sync multiplier: boost lead SKU, hold back non-lead
                let assemblyGroupMultiplier = 1.0;
                const taskGroupInfo = assemblyGroupTaskLookup.get(task.TaskID);
                if (taskGroupInfo && taskGroupInfo.isPreAssembly) {
                    if (taskGroupInfo.isLeadSku) {
                        assemblyGroupMultiplier = weights.assemblyLeadBoost;
                    } else {
                        assemblyGroupMultiplier = weights.assemblyNonLeadHoldback;
                    }
                }

                // Project Type multiplier: NSO > Infill > RENO > PC
                // Cached once at setup since ProjectType is stable across the run.
                const projectTypeMultiplier = task._projectTypeMultiplier;

                // Dwell time multiplier: boost priority when a task's predecessor completed
                // but this task has been waiting too long to get picked up
                let dwellMultiplier = 1.0;
                const skuKeyForDwell = `${task.Project}|${task.SKU}`;
                const allSkuTasksForDwell = schedulableTasksMap.get(skuKeyForDwell) || [];
                const predecessorOrders = allSkuTasksForDwell
                    .filter(t => t.Order < task.Order)
                    .map(t => t.Order);
                if (predecessorOrders.length > 0) {
                    const maxPredOrder = Math.max(...predecessorOrders);
                    const predKey = `${task.Project}|${task.SKU}|${maxPredOrder}`;
                    const predCompletionDate = completionBySkuOrder.get(predKey);
                    if (predCompletionDate) {
                        const dwellDays = (current_date - predCompletionDate) / (1000 * 60 * 60 * 24);
                        if (dwellDays > maxIdleDays) {
                            dwellMultiplier = 1 + ((dwellDays - maxIdleDays) / maxIdleDays);
                            dwellMultiplier = Math.min(dwellMultiplier, weights.dwellCap);
                        }
                    }
                }

                // In-progress boost: tasks currently being worked on in Fulcrum get priority
                const inProgressMultiplier = task.InProgress ? weights.inProgressBoost : 1.0;

                task.DynamicPriority = (task.BasePriority * dueDateMultiplier * assemblyGroupMultiplier * projectTypeMultiplier * dwellMultiplier * inProgressMultiplier) / task.TeamCapacity;
                task._dueDateMultiplier = dueDateMultiplier;
                task._assemblyGroupMultiplier = assemblyGroupMultiplier;
                // _projectTypeMultiplier already set at setup — it's stable across the run.
                task._dwellMultiplier = dwellMultiplier;
                task._inProgressMultiplier = inProgressMultiplier;
            });
            timings.inc('priorityCalc.ms', perfNow() - _pPriStart);

            // Capture priority snapshots weekly (Mondays) with top 50 tasks to keep response size manageable
            if (current_date.getDay() === 1) {
                const _sStart = perfNow();
                const readyForSnapshot = unscheduled_tasks.filter(t => t.HoursRemaining > 0);
                readyForSnapshot.sort((a, b) => b.DynamicPriority - a.DynamicPriority);
                const topTasks = readyForSnapshot.slice(0, 50);
                topTasks.forEach(t => {
                    const dueDate = t.DueDate instanceof Date ? t.DueDate : parseDate(t.DueDate);
                    const daysUntilDue = dueDate ? Math.ceil((dueDate - current_date) / (1000 * 60 * 60 * 24)) : 999;
                    dailyPrioritySnapshots.push({
                        Date: currentDateStr,
                        TaskID: t.TaskID,
                        Project: t.Project,
                        Store: t.Store,
                        SKU: t.SKU,
                        'SKU Name': t['SKU Name'] || '',
                        Operation: t.Operation,
                        Team: t.Team,
                        Order: t.Order,
                        ProjectType: t.ProjectType || '',
                        HoursRemaining: Number(t.HoursRemaining.toFixed(2)),
                        BasePriority: Number(t.BasePriority.toFixed(2)),
                        DueDateMultiplier: Number((t._dueDateMultiplier || 1).toFixed(2)),
                        ProjectTypeMultiplier: Number((t._projectTypeMultiplier || 1).toFixed(2)),
                        BottleneckMultiplier: 1,
                        DwellMultiplier: Number((t._dwellMultiplier || 1).toFixed(2)),
                        InProgressMultiplier: Number((t._inProgressMultiplier || 1).toFixed(2)),
                        TeamCapacity: t.TeamCapacity,
                        DynamicPriority: Number(t.DynamicPriority.toFixed(2)),
                        DaysUntilDue: daysUntilDue,
                        DaysSinceLastStep: 0,
                    });
                });
                timings.inc('snapshots.ms', perfNow() - _sStart);
            }

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
                timings.bump('workHourOverrides.find');
                const override = findWorkHourOverride(team, currentDateStr);

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
            const _aStart = perfNow();

            while (more_work_to_assign_today) {
                timings.bump('assignment.passes');
                more_work_to_assign_today = false;
                const ready_tasks = unscheduled_tasks.filter(isReady).sort((a,b) => b.DynamicPriority - a.DynamicPriority);

                if (ready_tasks.length > 0) {
                    for (const team_name in daily_capacity) {
                        const available_members = daily_capacity[team_name]?.filter(m => m.SchedulableHoursLeft > 0.01);
                        const hybridsForTeam = hybridsBySecondaryTeam.get(team_name) || [];
                        const availableHybrids = hybridsForTeam
                            .map(h => daily_capacity[h.primaryTeam]?.find(m => m.TeamMember === h.name && m.SchedulableHoursLeft > 0.01))
                            .filter(Boolean);
                        const fullRoster = [...(available_members || []), ...availableHybrids];

                        if (fullRoster.length > 0) {
                            for (const member of fullRoster) {
                                if (member.SchedulableHoursLeft <= 0.01) continue;
                                const memberHybrid = hybridByName.get(member.TeamMember);
                                const member_team = memberHybrid?.secondaryTeam === team_name
                                    ? team_name
                                    : (memberHybrid?.primaryTeam || team_name);
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
                                        // new_task is the same object reference already in unscheduled_tasks;
                                        // no need to re-find it.
                                        task_to_assign.AssignedTo = member.TeamMember;
                                    }
                                }
                                if (task_to_assign) {
                                    const member_for_task = task_to_assign.AssignedTo || member.TeamMember;
                                    const hybridInfo = hybridByName.get(member_for_task);
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
                                            // task_to_assign is the same reference as the task in unscheduled_tasks
                                            // (filter/find return original refs, not clones), so mutate directly.
                                            const taskInArray = task_to_assign;
                                            taskInArray.HoursRemaining -= task_hours_to_complete;
                                            memberInPool.SchedulableHoursLeft -= time_to_spend_on_task;

                                            totalHoursCompleted += task_hours_to_complete;

                                            if (taskInArray.HoursRemaining <= 0.01) {
                                                const completionRecord = { Project: task_to_assign.Project, SKU: task_to_assign.SKU, Order: task_to_assign.Order, TaskID: task_to_assign.TaskID, Operation: task_to_assign.Operation, CompletionDate: new Date(current_date) };
                                                completed_operations.push(completionRecord);
                                                completedByTaskId.set(task_to_assign.TaskID, completionRecord);
                                                completedTaskIDs.add(task_to_assign.TaskID);
                                                // Track completion at this Order level for dwell time boosting
                                                const compKey = `${taskInArray.Project}|${taskInArray.SKU}|${taskInArray.Order}`;
                                                completionBySkuOrder.set(compKey, new Date(current_date));
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
                // Yield to event loop between work-assignment passes so HTTP requests don't queue up
                await yieldToEventLoop();
            }
            timings.inc('assignment.ms', perfNow() - _aStart);
            timings.bump('mainLoop.workDays');
            // Throttle progress updates to every 5 days, but yield every day to keep server responsive
            if (loopCounter % 5 === 0) {
                const progress = 15 + Math.round((totalHoursCompleted / totalWorkloadHours) * 75);
                updateProgress(progress, `Simulating Day ${loopCounter + 1}...`);
            }
            await yieldToEventLoop();

            current_date.setDate(current_date.getDate() + 1);
            loopCounter++;
        }

        timings.mark('engine.mainLoop.end');
        timings.note('mainLoopIterations', loopCounter);
        timings.mark('engine.finalize.start');
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
            // Yield between weeks so HTTP requests stay responsive during post-sim aggregation
            await yieldToEventLoop();
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
                        const override = findWorkHourOverride(h.primaryTeam, dayStr);
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
                    const override = findWorkHourOverride(teamName, dayStr);
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


        timings.mark('engine.finalize.end');
        timings.mark('engine.total.end');

        return {
            finalSchedule,
            projectSummary,
            teamUtilization,
            weeklyOutput,
            dailyCompletions,
            teamWorkload,
            recommendations,
            projectedCompletion,
            dailyPrioritySnapshots,
            completedOperations: completed_operations,
            logs,
            error,
            timings: timings.report(),
        };

    } catch (e) {
        console.error("Critical error in scheduling engine:", e);
        logs.push(`Critical Error: ${e.message}`);
        timings.mark('engine.total.end');
        return { error: `A critical error occurred on the server: ${e.message}`, logs, timings: timings.report() };
    }
};

module.exports = {
    runSchedulingEngine,
    DEFAULT_PRIORITY_WEIGHTS,
    parseDate,
    formatDate,
    getWeekStartDate,
    TEAM_SORT_ORDER,
};
