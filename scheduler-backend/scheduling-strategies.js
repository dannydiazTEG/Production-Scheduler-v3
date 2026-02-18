// scheduling-strategies.js
// Alternative scheduling engine strategies with different priority/dispatch logic.
// Each function is a standalone copy of the original runSchedulingEngine from server.js,
// with ONLY the priority logic changed.

// --- Duplicated Helper Functions ---
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

// =================================================================
// STRATEGY 1: Earliest Due Date Engine
// =================================================================
// - BasePriority set to 1 for all tasks (neutralize complexity weighting)
// - DynamicPriority = dueDateMultiplier (pure due-date urgency)
// - Sort by DynamicPriority descending (now purely due-date driven)
// =================================================================

const runEarliestDueDateEngine = async (
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

    // === STRATEGY CHANGE #1: calculateBasePriority ===
    // Earliest Due Date: BasePriority = 1 for all tasks (neutralize complexity weighting)
    const calculateBasePriority = (df, headcounts) => {
        const teamHeadcountMap = headcounts.reduce((acc, curr) => ({ ...acc, [curr.name]: curr.count }), {});
        return df.map(row => ({ ...row, BasePriority: 1, TeamCapacity: teamHeadcountMap[row.Team] || 1 }));
    };

    try {
        logs.push("--- Starting Earliest Due Date Scheduling Simulation ---");
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
        let dailyDwellingData = {};

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

            // === STRATEGY CHANGE #2: Dynamic priority recalculation ===
            // Urgency Ratio: SKUs with lots of remaining work relative to time left get boosted
            // Precompute remaining hours per SKU (changes daily as work completes)
            const skuRemainingHours = {};
            unscheduled_tasks.forEach(task => {
                if (!skuRemainingHours[task.SKU]) skuRemainingHours[task.SKU] = 0;
                skuRemainingHours[task.SKU] += task.HoursRemaining;
            });

            unscheduled_tasks.forEach(task => {
                const daysUntilDue = (task.DueDate - current_date) / (1000 * 60 * 60 * 24);
                let dueDateMultiplier;
                if (daysUntilDue < 0) {
                    dueDateMultiplier = 100 * Math.pow(1.1, -daysUntilDue);
                } else {
                    dueDateMultiplier = 1 + (60 / (daysUntilDue + 1));
                }
                // Urgency ratio: how many hours this SKU needs per remaining day
                const urgencyRatio = (skuRemainingHours[task.SKU] || 1) / Math.max(daysUntilDue, 1);
                task.DynamicPriority = urgencyRatio * dueDateMultiplier;
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
                // === STRATEGY CHANGE #3: Task sorting ===
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
            if (loopCounter % 5 === 0) {
                const progress = 15 + Math.round((totalHoursCompleted / totalWorkloadHours) * 75);
                updateProgress(progress, `Simulating Day ${loopCounter + 1}...`);
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
        const projectedCompletion = projectSummary.length > 0 ? projectSummary.reduce((max, p) => p.FinishDate > max ? p.FinishDate : max, '0') : null;

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


        return {
            finalSchedule,
            projectSummary,
            taskSummary: finalSchedule, // Add taskSummary for bottleneck detection
            teamUtilization,
            weeklyOutput,
            dailyCompletions,
            teamWorkload,
            recommendations,
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


// =================================================================
// STRATEGY 2: Critical Path Engine
// =================================================================
// - BasePriority = (remaining operations in SKU chain) * (total remaining hours)
//   This prioritizes SKUs with the longest chains.
// - DynamicPriority = (BasePriority * dueDateMultiplier) / TeamCapacity
//   Same formula as original, but BasePriority now favors long chains.
// - Sort by DynamicPriority descending
// =================================================================

const runCriticalPathEngine = async (
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

    // === STRATEGY CHANGE #1: calculateBasePriority ===
    // Critical Path: Per-task priority based on remaining downstream work.
    // Tasks early in a long chain get higher priority because they unlock more work.
    // Includes baseline's assembly-aware multipliers (assemblyImpact + assemblyConstraint).
    // Floor prevents final ops from getting near-zero priority.
    const calculateBasePriority = (df, headcounts) => {
        const teamHeadcountMap = headcounts.reduce((acc, curr) => ({ ...acc, [curr.name]: curr.count }), {});
        // Group tasks by SKU to analyze chains
        const skuGroups = df.reduce((acc, row) => {
            if (!acc[row.SKU]) acc[row.SKU] = [];
            acc[row.SKU].push(row);
            return acc;
        }, {});

        return df.map(row => {
            const skuTasks = skuGroups[row.SKU] || [];
            const totalHours = skuTasks.reduce((sum, t) => sum + (t['Estimated Hours'] || 0), 0);
            // Count operations AFTER this one in the chain
            const downstreamOps = skuTasks.filter(t => t.Order > row.Order);
            const downstreamHours = downstreamOps.reduce((sum, t) => sum + (t['Estimated Hours'] || 0), 0);
            const downstreamCount = downstreamOps.length;

            // Assembly-aware multipliers (both from baseline)
            const assemblyTask = skuTasks.find(t => t.Operation === 'Final Assembly');
            const assemblyHours = assemblyTask ? (assemblyTask['Estimated Hours'] || 0) : 0;
            const assemblyOrder = assemblyTask ? assemblyTask.Order : Infinity;
            const stepsBeforeAssembly = skuTasks.filter(t => t.Order < assemblyOrder).length;
            const assemblyImpact = assemblyHours > 15 ? 3 : assemblyHours >= 8 ? 2 : 1;
            const assemblyConstraint = stepsBeforeAssembly === 0 ? 1 : stepsBeforeAssembly <= 2 ? 2 : stepsBeforeAssembly <= 4 ? 1.5 : 1;

            // Chain priority: downstream work × assembly multipliers
            // +1 so the final op in a chain still gets a nonzero base
            const chainPriority = (downstreamHours + downstreamCount + 1) * (assemblyImpact * assemblyConstraint);
            // Floor: final ops (assembly, tech) get at least 50% of SKU total × assembly impact
            const floorPriority = totalHours * 0.5 * assemblyImpact;
            const basePriority = Math.max(chainPriority, floorPriority);

            return { ...row, BasePriority: basePriority, TeamCapacity: teamHeadcountMap[row.Team] || 1 };
        });
    };

    try {
        logs.push("--- Starting Critical Path Scheduling Simulation ---");
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
        let dailyDwellingData = {};

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

            // === STRATEGY CHANGE #2: Dynamic priority recalculation ===
            // Critical Path + Bottleneck hybrid: chain priority + bottleneck awareness
            // Also: removed /TeamCapacity so chain importance isn't diluted by team size
            // Also: project-level urgency boost for lagging SKUs

            // Bottleneck awareness: find today's most overloaded team
            const cpTeamRemainingHours = {};
            unscheduled_tasks.forEach(task => {
                if (!cpTeamRemainingHours[task.Team]) cpTeamRemainingHours[task.Team] = 0;
                cpTeamRemainingHours[task.Team] += task.HoursRemaining;
            });
            let cpBottleneckTeam = null;
            let cpMaxLoad = 0;
            for (const team in cpTeamRemainingHours) {
                const headcount = teamHeadcounts[team] || 1;
                const load = cpTeamRemainingHours[team] / headcount;
                if (load > cpMaxLoad) {
                    cpMaxLoad = load;
                    cpBottleneckTeam = team;
                }
            }

            // Project-level urgency: find lagging SKUs per project
            const projectSkuHours = {};
            unscheduled_tasks.forEach(task => {
                const projKey = task.Project;
                if (!projectSkuHours[projKey]) projectSkuHours[projKey] = {};
                if (!projectSkuHours[projKey][task.SKU]) projectSkuHours[projKey][task.SKU] = 0;
                projectSkuHours[projKey][task.SKU] += task.HoursRemaining;
            });
            const laggingSKUs = new Set();
            for (const proj in projectSkuHours) {
                const skus = Object.entries(projectSkuHours[proj]);
                if (skus.length <= 1) continue;
                const avgHours = skus.reduce((sum, [, hrs]) => sum + hrs, 0) / skus.length;
                skus.forEach(([sku, hrs]) => {
                    if (hrs > avgHours * 1.5) laggingSKUs.add(sku);
                });
            }

            // Group remaining tasks by SKU for chain/bottleneck analysis
            const cpSkuGroups = {};
            unscheduled_tasks.forEach(task => {
                if (!cpSkuGroups[task.SKU]) cpSkuGroups[task.SKU] = [];
                cpSkuGroups[task.SKU].push(task);
            });

            unscheduled_tasks.forEach(task => {
                const daysUntilDue = (task.DueDate - current_date) / (1000 * 60 * 60 * 24);
                let dueDateMultiplier;
                if (daysUntilDue < 0) {
                    dueDateMultiplier = 100 * Math.pow(1.1, -daysUntilDue);
                } else {
                    dueDateMultiplier = 1 + (60 / (daysUntilDue + 1));
                }

                // Bottleneck hybrid: if downstream chain touches bottleneck team, boost
                let bottleneckChainBoost = 1;
                if (cpBottleneckTeam) {
                    const skuTasks = cpSkuGroups[task.SKU] || [];
                    const downstreamBottleneck = skuTasks.find(t => t.Order > task.Order && t.Team === cpBottleneckTeam);
                    if (downstreamBottleneck) {
                        const stepsAway = downstreamBottleneck.Order - task.Order;
                        bottleneckChainBoost = stepsAway <= 1 ? 2.5 : stepsAway <= 2 ? 2 : 1.5;
                    }
                }

                // Project-level urgency: boost lagging SKUs
                const projectUrgencyBoost = laggingSKUs.has(task.SKU) ? 1.5 : 1;

                // No /TeamCapacity — let chain importance drive decisions, not team size
                task.DynamicPriority = task.BasePriority * dueDateMultiplier * bottleneckChainBoost * projectUrgencyBoost;
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
                // === STRATEGY CHANGE #3: Task sorting + relaxed SKU spreading ===
                const ready_tasks = unscheduled_tasks.filter(isReady).sort((a,b) => b.DynamicPriority - a.DynamicPriority);

                // Top 20% priority threshold: tasks above this can double up on SKUs
                const topPriorityThreshold = ready_tasks.length > 4 ? ready_tasks[Math.floor(ready_tasks.length * 0.2)]?.DynamicPriority || 0 : 0;

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
                                    // Relaxed SKU spreading: top 20% priority tasks can double up on SKUs
                                    let new_task = team_ready_tasks.find(t => !t.AssignedTo && (!skus_being_worked_on_today.has(t.SKU) || t.DynamicPriority >= topPriorityThreshold));
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
            if (loopCounter % 5 === 0) {
                const progress = 15 + Math.round((totalHoursCompleted / totalWorkloadHours) * 75);
                updateProgress(progress, `Simulating Day ${loopCounter + 1}...`);
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
        const projectedCompletion = projectSummary.length > 0 ? projectSummary.reduce((max, p) => p.FinishDate > max ? p.FinishDate : max, '0') : null;

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


        return {
            finalSchedule,
            projectSummary,
            taskSummary: finalSchedule, // Add taskSummary for bottleneck detection
            teamUtilization,
            weeklyOutput,
            dailyCompletions,
            teamWorkload,
            recommendations,
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


// =================================================================
// STRATEGY 3: Work Leveling Engine
// =================================================================
// - BasePriority = 1 for all tasks (equal weight)
// - DynamicPriority = sqrt(dueDateMultiplier) — flattened urgency curve
//   Tasks don't spike in priority until truly close to due date.
//   This pushes non-urgent work later, spreading load more evenly.
// - Sort by DynamicPriority descending
// =================================================================

const runWorkLevelingEngine = async (
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
            const operationLower = (row.Operation || '').toLowerCase();
            if (operationLower.includes('kitting')) {
                return { ...row, Team: 'Receiving' };
            }
            return { ...row, Team: teamMap[row.Operation] || 'Unassigned' };
        });
    };

    // === STRATEGY CHANGE #1: calculateBasePriority ===
    // Work Leveling: BasePriority = 1 for all tasks (equal weight, no complexity bias)
    const calculateBasePriority = (df, headcounts) => {
        const teamHeadcountMap = headcounts.reduce((acc, curr) => ({ ...acc, [curr.name]: curr.count }), {});
        return df.map(row => ({ ...row, BasePriority: 1, TeamCapacity: teamHeadcountMap[row.Team] || 1 }));
    };

    try {
        logs.push("--- Starting Work Leveling Scheduling Simulation ---");
        logs.push(`Received ${teamMemberChanges.length} team member changes`);
        logs.push(`Received ${workHourOverrides.length} work hour overrides`);

        const scheduledHybridWorkers = teamMemberChanges
            .filter(c => c.type === 'Starts' && c.isHybrid && c.secondaryTeam)
            .map(c => ({ name: c.name, primaryTeam: c.team, secondaryTeam: c.secondaryTeam }));
        const allHybridWorkers = [...hybridWorkers, ...scheduledHybridWorkers];
        hybridWorkers = allHybridWorkers;

        if (teamMemberChanges.length > 0) {
            const newHires = teamMemberChanges.filter(c => c.type === 'Starts');
            const normalHires = newHires.filter(h => !h.isHybrid);
            const hybridHires = newHires.filter(h => h.isHybrid);
            if (normalHires.length > 0) logs.push(`  New specialist hires: ${normalHires.map(h => `${h.name} (${h.date})`).join(', ')}`);
            if (hybridHires.length > 0) logs.push(`  New hybrid hires: ${hybridHires.map(h => `${h.name} (${h.date}) - Primary: ${h.team}, Secondary: ${h.secondaryTeam || 'N/A'}`).join(', ')}`);
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
            if (!acc[key] || value > acc[key]) acc[key] = value;
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
                    finalCompletions.push({ completionDate: parseDate(originalTask.StartDate), value: skuValueMap[skuKey] || 0, Project: originalTask.Project, Store: originalTask.Store, SKU: originalTask.SKU, 'SKU Name': originalTask['SKU Name'] });
                }
            });
        }

        operations_df = calculateBasePriority(operations_df, teamDefs.headcounts);
        operations_df = operations_df.map(row => ({ ...row, DueDate: parseDate(row.DueDate), StartDate: parseDate(row.StartDate) }));

        const skuMaxOrderMap = operations_df.reduce((acc, task) => {
            if (!acc[task.SKU] || task.Order > acc[task.SKU]) acc[task.SKU] = task.Order;
            return acc;
        }, {});

        operations_df = operations_df.map((row, index) => ({...row, TaskID: index, HoursRemaining: row['Estimated Hours'], AssignedTo: null }))
            .sort((a,b) => (a.Project || '').localeCompare(b.Project || '') || (a.SKU || '').localeCompare(b.SKU || '') || a.Order - b.Order);

        const globalBufferPercent = (parseFloat(params.globalBuffer) || 0) / 100;
        operations_df.forEach(task => {
            let calculatedBuffer = task['Estimated Hours'] * globalBufferPercent;
            task.LagAfterHours = calculatedBuffer;
        });

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
        let dailyDwellingData = {};

        const overtimeTracking = {};
        const MAX_OVERTIME_DAYS = 90;
        const COOLDOWN_DAYS = 30;

        const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

        while(unscheduled_tasks.length > 0 && loopCounter < maxDays) {
            const dayOfWeek = current_date.getDay();
            const currentDateStr = formatDate(current_date);
            if (dayOfWeek === 6 || dayOfWeek === 0 || holidayList.has(currentDateStr)) {
                current_date.setDate(current_date.getDate() + 1);
                loopCounter++;
                continue;
            }

            const isReady = (task) => {
                if (current_date < task.StartDate) return false;
                const key = `${task.Project}|${task.SKU}`;
                const allSkuTasks = schedulableTasksMap.get(key) || [];
                const predecessors = allSkuTasks.filter(t => t.Order < task.Order);
                if (predecessors.length === 0) return true;
                return predecessors.every(p => {
                    const completedPredecessor = completed_operations.find(c => c.TaskID === p.TaskID);
                    if (!completedPredecessor) return false;
                    const lagHours = p.LagAfterHours || 0;
                    if (lagHours === 0) return true;
                    const hoursPerWorkDay = parseFloat(params.hoursPerDay) || 8;
                    const lagInDays = lagHours / hoursPerWorkDay;
                    const completionDate = new Date(completedPredecessor.CompletionDate);
                    const readyDate = new Date(completionDate.getTime());
                    readyDate.setDate(readyDate.getDate() + Math.ceil(lagInDays));
                    return current_date >= readyDate;
                });
            };

            const ready_tasks_for_dwelling_check = unscheduled_tasks.filter(isReady);
            const dwellingHoursToday = {};
            ready_tasks_for_dwelling_check.forEach(task => {
                if (!dwellingHoursToday[task.Team]) dwellingHoursToday[task.Team] = 0;
                dwellingHoursToday[task.Team] += task.HoursRemaining;
            });
            dailyDwellingData[currentDateStr] = dwellingHoursToday;

            // === STRATEGY CHANGE #2: Dynamic priority recalculation ===
            // Work Leveling: sqrt(dueDateMultiplier) — flattened urgency curve
            // Tasks only spike in priority when truly close to due date
            unscheduled_tasks.forEach(task => {
                const daysUntilDue = (task.DueDate - current_date) / (1000 * 60 * 60 * 24);
                let dueDateMultiplier;
                if (daysUntilDue < 0) {
                    dueDateMultiplier = 100 * Math.pow(1.1, -daysUntilDue);
                } else {
                    dueDateMultiplier = 1 + (60 / (daysUntilDue + 1));
                }
                task.DynamicPriority = Math.sqrt(dueDateMultiplier);
            });

            const dailyRoster = {};
            Object.keys(teamHeadcounts).forEach(team => {
                dailyRoster[team] = new Set();
                const headcount = teamHeadcounts[team] || 0;
                for(let i=0; i < Math.floor(headcount); i++) dailyRoster[team].add(`${team.replace(/\s/g, '')}${i+1}`);
            });

            let rosterBeforeChanges = {};
            Object.keys(dailyRoster).forEach(team => { rosterBeforeChanges[team] = dailyRoster[team].size; });

            teamMemberChanges.forEach(change => {
                if(currentDateStr >= change.date) {
                    if(!dailyRoster[change.team]) dailyRoster[change.team] = new Set();
                    if(change.type === 'Starts') {
                        dailyRoster[change.team].add(change.name);
                        if (currentDateStr === change.date) logs.push(`${currentDateStr}: 👷 ${change.name} joined ${change.team} team`);
                    } else {
                        dailyRoster[change.team].delete(change.name);
                    }
                }
            });

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
                const isOvertime = override && parseFloat(override.hours) > parseFloat(params.hoursPerDay);
                const currentDate = parseDate(currentDateStr);
                if (isOvertime) {
                    if (!overtimeTracking[team]) overtimeTracking[team] = { startDate: null, endDate: null, inCooldown: false, cooldownEndDate: null };
                    const tracking = overtimeTracking[team];
                    if (tracking.inCooldown && tracking.cooldownEndDate) {
                        const cooldownEnd = parseDate(tracking.cooldownEndDate);
                        if (currentDate < cooldownEnd) {
                            hours = parseFloat(params.hoursPerDay);
                            const daysRemaining = Math.ceil((cooldownEnd - currentDate) / (1000 * 60 * 60 * 24));
                            if (currentDateStr === override.startDate) logs.push(`${currentDateStr}: ⚠️ ${team} overtime blocked - in cooldown for ${daysRemaining} more days (ends ${tracking.cooldownEndDate})`);
                        } else {
                            tracking.inCooldown = false; tracking.cooldownEndDate = null;
                            tracking.startDate = currentDateStr; tracking.endDate = null;
                            hours = parseFloat(override.hours);
                            logs.push(`${currentDateStr}: ⏰ ${team} starting overtime (${hours}hrs/day) until ${override.endDate} - cooldown complete`);
                        }
                    } else {
                        if (!tracking.startDate) {
                            tracking.startDate = currentDateStr; tracking.endDate = null;
                            hours = parseFloat(override.hours);
                            logs.push(`${currentDateStr}: ⏰ ${team} starting overtime (${hours}hrs/day) until ${override.endDate}`);
                        } else {
                            const overtimeStart = parseDate(tracking.startDate);
                            const daysSinceStart = Math.floor((currentDate - overtimeStart) / (1000 * 60 * 60 * 24));
                            if (daysSinceStart >= MAX_OVERTIME_DAYS) {
                                if (!tracking.endDate) {
                                    tracking.endDate = currentDateStr; tracking.inCooldown = true;
                                    const cooldownEnd = new Date(currentDate); cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_DAYS);
                                    tracking.cooldownEndDate = formatDate(cooldownEnd);
                                    logs.push(`${currentDateStr}: 🛑 ${team} overtime limit reached (${MAX_OVERTIME_DAYS} days) - starting ${COOLDOWN_DAYS}-day cooldown until ${tracking.cooldownEndDate}`);
                                }
                                hours = parseFloat(params.hoursPerDay);
                            } else {
                                hours = parseFloat(override.hours);
                            }
                        }
                    }
                } else {
                    if (overtimeTracking[team] && overtimeTracking[team].startDate && !overtimeTracking[team].endDate) {
                        const tracking = overtimeTracking[team];
                        const overtimeStart = parseDate(tracking.startDate);
                        const daysSinceStart = Math.floor((currentDate - overtimeStart) / (1000 * 60 * 60 * 24));
                        tracking.endDate = currentDateStr;
                        if (daysSinceStart >= MAX_OVERTIME_DAYS) {
                            tracking.inCooldown = true;
                            const cooldownEnd = new Date(currentDate); cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_DAYS);
                            tracking.cooldownEndDate = formatDate(cooldownEnd);
                            logs.push(`${currentDateStr}: 📅 ${team} overtime ended after ${daysSinceStart} days - starting ${COOLDOWN_DAYS}-day cooldown until ${tracking.cooldownEndDate}`);
                        } else {
                            tracking.startDate = null; tracking.endDate = null;
                        }
                    }
                    if (override) hours = parseFloat(override.hours);
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
                // === STRATEGY CHANGE #3: Task sorting ===
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
            if (loopCounter % 5 === 0) {
                const progress = 15 + Math.round((totalHoursCompleted / totalWorkloadHours) * 75);
                updateProgress(progress, `Simulating Day ${loopCounter + 1}...`);
                await yieldToEventLoop();
            }
            current_date.setDate(current_date.getDate() + 1);
            loopCounter++;
        }

        updateProgress(90, 'Finalizing results...');

        const workByMember = {};
        daily_log_entries.forEach(log => {
            if (!workByMember[log.TeamMember]) workByMember[log.TeamMember] = { hours: 0, tasks: 0 };
            workByMember[log.TeamMember].hours += log['Time Spent (Hours)'];
            workByMember[log.TeamMember].tasks++;
        });
        const newHireNames = new Set(teamMemberChanges.filter(c => c.type === 'Starts').map(c => c.name));
        if (newHireNames.size > 0) {
            logs.push(`\n--- Work Completed by New Hires ---`);
            newHireNames.forEach(name => {
                const work = workByMember[name];
                if (work) logs.push(`  ${name}: ${work.tasks} tasks, ${work.hours.toFixed(1)} hours`);
                else logs.push(`  ${name}: NO WORK ASSIGNED`);
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
        const projectedCompletion = projectSummary.length > 0 ? projectSummary.reduce((max, p) => p.FinishDate > max ? p.FinishDate : max, '0') : null;

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

        return { finalSchedule, projectSummary, taskSummary: finalSchedule, teamUtilization, weeklyOutput, dailyCompletions, teamWorkload, recommendations, projectedCompletion, logs, error };

    } catch (e) {
        console.error("Critical error in scheduling engine:", e);
        logs.push(`Critical Error: ${e.message}`);
        return { error: `A critical error occurred on the server: ${e.message}`, logs };
    }
};


// =================================================================
// STRATEGY 4: Bottleneck-First Engine
// =================================================================
// - Calculates each team's load ratio (total hours / headcount)
// - The most overloaded team gets a 3x priority multiplier
// - DynamicPriority uses same formula as baseline but with
//   bottleneck-weighted BasePriority
// - Sort by DynamicPriority descending
// =================================================================

const runBottleneckFirstEngine = async (
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
            const operationLower = (row.Operation || '').toLowerCase();
            if (operationLower.includes('kitting')) {
                return { ...row, Team: 'Receiving' };
            }
            return { ...row, Team: teamMap[row.Operation] || 'Unassigned' };
        });
    };

    // === STRATEGY CHANGE #1: calculateBasePriority ===
    // Bottleneck-First: Compute baseline-equivalent priority (with assemblyConstraint).
    // Bottleneck boost is now applied DYNAMICALLY each day in the priority loop,
    // so the algorithm adapts as the bottleneck shifts over time.
    const calculateBasePriority = (df, headcounts) => {
        const teamHeadcountMap = headcounts.reduce((acc, curr) => ({ ...acc, [curr.name]: curr.count }), {});

        // Log initial bottleneck analysis
        const teamTotalHours = {};
        df.forEach(row => {
            const team = row.Team;
            if (!teamTotalHours[team]) teamTotalHours[team] = 0;
            teamTotalHours[team] += (row['Estimated Hours'] || 0);
        });
        const teamLoadRatio = {};
        for (const team in teamTotalHours) {
            const headcount = teamHeadcountMap[team] || 1;
            teamLoadRatio[team] = teamTotalHours[team] / headcount;
        }
        let initialBottleneck = null;
        let maxLoadRatio = 0;
        for (const team in teamLoadRatio) {
            if (teamLoadRatio[team] > maxLoadRatio) {
                maxLoadRatio = teamLoadRatio[team];
                initialBottleneck = team;
            }
        }
        logs.push(`Initial Bottleneck Analysis (shifts daily as work completes):`);
        const sortedTeams = Object.entries(teamLoadRatio).sort(([,a], [,b]) => b - a);
        sortedTeams.forEach(([team, ratio]) => {
            const marker = team === initialBottleneck ? ' ← BOTTLENECK' : '';
            logs.push(`  ${team}: ${teamTotalHours[team]?.toFixed(0) || 0} hrs / ${teamHeadcountMap[team] || 0} people = ${ratio.toFixed(1)} hrs/person${marker}`);
        });

        // Group tasks by SKU for assembly analysis
        const skuGroups = df.reduce((acc, row) => {
            if (!acc[row.SKU]) acc[row.SKU] = [];
            acc[row.SKU].push(row);
            return acc;
        }, {});

        // Compute base priority WITH assemblyConstraint (matches baseline formula)
        // NO bottleneck boost here — that's applied dynamically each day
        return df.map(row => {
            const skuTasks = skuGroups[row.SKU] || [];
            const totalHours = skuTasks.reduce((sum, t) => sum + (t['Estimated Hours'] || 0), 0);
            const opCount = skuTasks.length;

            const assemblyTask = skuTasks.find(t => t.Operation === 'Final Assembly');
            const assemblyHours = assemblyTask ? (assemblyTask['Estimated Hours'] || 0) : 0;
            const assemblyOrder = assemblyTask ? assemblyTask.Order : Infinity;
            const stepsBeforeAssembly = skuTasks.filter(t => t.Order < assemblyOrder).length;
            const assemblyImpact = assemblyHours > 15 ? 3 : assemblyHours >= 8 ? 2 : 1;
            const assemblyConstraint = stepsBeforeAssembly === 0 ? 1 : stepsBeforeAssembly <= 2 ? 2 : stepsBeforeAssembly <= 4 ? 1.5 : 1;

            const basePriority = (totalHours + opCount) * (assemblyImpact * assemblyConstraint);

            return { ...row, BasePriority: basePriority, TeamCapacity: teamHeadcountMap[row.Team] || 1 };
        });
    };

    try {
        logs.push("--- Starting Bottleneck-First Scheduling Simulation ---");
        logs.push(`Received ${teamMemberChanges.length} team member changes`);
        logs.push(`Received ${workHourOverrides.length} work hour overrides`);

        const scheduledHybridWorkers = teamMemberChanges
            .filter(c => c.type === 'Starts' && c.isHybrid && c.secondaryTeam)
            .map(c => ({ name: c.name, primaryTeam: c.team, secondaryTeam: c.secondaryTeam }));
        const allHybridWorkers = [...hybridWorkers, ...scheduledHybridWorkers];
        hybridWorkers = allHybridWorkers;

        if (teamMemberChanges.length > 0) {
            const newHires = teamMemberChanges.filter(c => c.type === 'Starts');
            const normalHires = newHires.filter(h => !h.isHybrid);
            const hybridHires = newHires.filter(h => h.isHybrid);
            if (normalHires.length > 0) logs.push(`  New specialist hires: ${normalHires.map(h => `${h.name} (${h.date})`).join(', ')}`);
            if (hybridHires.length > 0) logs.push(`  New hybrid hires: ${hybridHires.map(h => `${h.name} (${h.date}) - Primary: ${h.team}, Secondary: ${h.secondaryTeam || 'N/A'}`).join(', ')}`);
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
            if (!acc[key] || value > acc[key]) acc[key] = value;
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
                    finalCompletions.push({ completionDate: parseDate(originalTask.StartDate), value: skuValueMap[skuKey] || 0, Project: originalTask.Project, Store: originalTask.Store, SKU: originalTask.SKU, 'SKU Name': originalTask['SKU Name'] });
                }
            });
        }

        operations_df = calculateBasePriority(operations_df, teamDefs.headcounts);
        operations_df = operations_df.map(row => ({ ...row, DueDate: parseDate(row.DueDate), StartDate: parseDate(row.StartDate) }));

        const skuMaxOrderMap = operations_df.reduce((acc, task) => {
            if (!acc[task.SKU] || task.Order > acc[task.SKU]) acc[task.SKU] = task.Order;
            return acc;
        }, {});

        operations_df = operations_df.map((row, index) => ({...row, TaskID: index, HoursRemaining: row['Estimated Hours'], AssignedTo: null }))
            .sort((a,b) => (a.Project || '').localeCompare(b.Project || '') || (a.SKU || '').localeCompare(b.SKU || '') || a.Order - b.Order);

        const globalBufferPercent = (parseFloat(params.globalBuffer) || 0) / 100;
        operations_df.forEach(task => {
            let calculatedBuffer = task['Estimated Hours'] * globalBufferPercent;
            task.LagAfterHours = calculatedBuffer;
        });

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
        let dailyDwellingData = {};

        const overtimeTracking = {};
        const MAX_OVERTIME_DAYS = 90;
        const COOLDOWN_DAYS = 30;

        const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

        // Track previous bottleneck for momentum (avoid flip-flopping)
        let prevBottleneck = null;

        while(unscheduled_tasks.length > 0 && loopCounter < maxDays) {
            const dayOfWeek = current_date.getDay();
            const currentDateStr = formatDate(current_date);
            if (dayOfWeek === 6 || dayOfWeek === 0 || holidayList.has(currentDateStr)) {
                current_date.setDate(current_date.getDate() + 1);
                loopCounter++;
                continue;
            }

            const isReady = (task) => {
                if (current_date < task.StartDate) return false;
                const key = `${task.Project}|${task.SKU}`;
                const allSkuTasks = schedulableTasksMap.get(key) || [];
                const predecessors = allSkuTasks.filter(t => t.Order < task.Order);
                if (predecessors.length === 0) return true;
                return predecessors.every(p => {
                    const completedPredecessor = completed_operations.find(c => c.TaskID === p.TaskID);
                    if (!completedPredecessor) return false;
                    const lagHours = p.LagAfterHours || 0;
                    if (lagHours === 0) return true;
                    const hoursPerWorkDay = parseFloat(params.hoursPerDay) || 8;
                    const lagInDays = lagHours / hoursPerWorkDay;
                    const completionDate = new Date(completedPredecessor.CompletionDate);
                    const readyDate = new Date(completionDate.getTime());
                    readyDate.setDate(readyDate.getDate() + Math.ceil(lagInDays));
                    return current_date >= readyDate;
                });
            };

            const ready_tasks_for_dwelling_check = unscheduled_tasks.filter(isReady);
            const dwellingHoursToday = {};
            ready_tasks_for_dwelling_check.forEach(task => {
                if (!dwellingHoursToday[task.Team]) dwellingHoursToday[task.Team] = 0;
                dwellingHoursToday[task.Team] += task.HoursRemaining;
            });
            dailyDwellingData[currentDateStr] = dwellingHoursToday;

            // === STRATEGY CHANGE #2: Dynamic priority recalculation ===
            // Bottleneck-First: Recalculate bottleneck DAILY from remaining work.
            // Uses TOP 2 bottleneck teams (prevents "feed one, starve the other").
            // Momentum: only switches primary bottleneck if new team is 20%+ more loaded.
            const teamRemainingHours = {};
            unscheduled_tasks.forEach(task => {
                if (!teamRemainingHours[task.Team]) teamRemainingHours[task.Team] = 0;
                teamRemainingHours[task.Team] += task.HoursRemaining;
            });

            // Rank all teams by load ratio (remaining hours / headcount)
            const teamLoads = [];
            for (const team in teamRemainingHours) {
                const headcount = teamHeadcounts[team] || 1;
                teamLoads.push({ team, load: teamRemainingHours[team] / headcount });
            }
            teamLoads.sort((a, b) => b.load - a.load);

            // Momentum: stick with previous bottleneck unless new leader is 20%+ higher
            let primaryBottleneck = teamLoads[0]?.team || null;
            if (prevBottleneck && primaryBottleneck !== prevBottleneck) {
                const prevLoad = teamLoads.find(t => t.team === prevBottleneck)?.load || 0;
                const newLoad = teamLoads[0]?.load || 0;
                if (newLoad < prevLoad * 1.2) {
                    primaryBottleneck = prevBottleneck; // stick with current
                }
            }
            prevBottleneck = primaryBottleneck;

            // Secondary bottleneck: next most-loaded team
            const secondaryBottleneck = teamLoads.find(t => t.team !== primaryBottleneck)?.team || null;

            // Group remaining tasks by SKU for chain analysis
            const remainingSkuGroups = {};
            unscheduled_tasks.forEach(task => {
                if (!remainingSkuGroups[task.SKU]) remainingSkuGroups[task.SKU] = [];
                remainingSkuGroups[task.SKU].push(task);
            });

            // Project-level urgency: find lagging SKUs per project
            const bnProjectSkuHours = {};
            unscheduled_tasks.forEach(task => {
                const projKey = task.Project;
                if (!bnProjectSkuHours[projKey]) bnProjectSkuHours[projKey] = {};
                if (!bnProjectSkuHours[projKey][task.SKU]) bnProjectSkuHours[projKey][task.SKU] = 0;
                bnProjectSkuHours[projKey][task.SKU] += task.HoursRemaining;
            });
            const bnLaggingSKUs = new Set();
            for (const proj in bnProjectSkuHours) {
                const skus = Object.entries(bnProjectSkuHours[proj]);
                if (skus.length <= 1) continue;
                const avgHours = skus.reduce((sum, [, hrs]) => sum + hrs, 0) / skus.length;
                skus.forEach(([sku, hrs]) => {
                    if (hrs > avgHours * 1.5) bnLaggingSKUs.add(sku);
                });
            }

            unscheduled_tasks.forEach(task => {
                const daysUntilDue = (task.DueDate - current_date) / (1000 * 60 * 60 * 24);
                let dueDateMultiplier;
                if (daysUntilDue < 0) {
                    dueDateMultiplier = 100 * Math.pow(1.1, -daysUntilDue);
                } else {
                    dueDateMultiplier = 1 + (60 / (daysUntilDue + 1));
                }

                // Dynamic bottleneck boost from top 2 bottleneck teams (aggressive multipliers)
                let feedsBottleneckBoost = 1;
                const skuTasks = remainingSkuGroups[task.SKU] || [];

                // Primary bottleneck: aggressive boost (6x/5x/4x)
                if (primaryBottleneck) {
                    const bottleneckOp = skuTasks.find(t => t.Team === primaryBottleneck);
                    if (bottleneckOp && task.Order < bottleneckOp.Order) {
                        const stepsAway = bottleneckOp.Order - task.Order;
                        feedsBottleneckBoost = stepsAway <= 1 ? 6 : stepsAway <= 2 ? 5 : 4;
                    }
                }

                // Secondary bottleneck: moderate boost (3x/2x/1.5x), only if primary didn't apply
                if (secondaryBottleneck && feedsBottleneckBoost === 1) {
                    const bottleneckOp2 = skuTasks.find(t => t.Team === secondaryBottleneck);
                    if (bottleneckOp2 && task.Order < bottleneckOp2.Order) {
                        const stepsAway = bottleneckOp2.Order - task.Order;
                        feedsBottleneckBoost = stepsAway <= 1 ? 3 : stepsAway <= 2 ? 2 : 1.5;
                    }
                }

                // Project-level urgency: boost lagging SKUs
                const projectUrgencyBoost = bnLaggingSKUs.has(task.SKU) ? 1.5 : 1;

                task.DynamicPriority = (task.BasePriority * dueDateMultiplier * feedsBottleneckBoost * projectUrgencyBoost) / task.TeamCapacity;
            });

            const dailyRoster = {};
            Object.keys(teamHeadcounts).forEach(team => {
                dailyRoster[team] = new Set();
                const headcount = teamHeadcounts[team] || 0;
                for(let i=0; i < Math.floor(headcount); i++) dailyRoster[team].add(`${team.replace(/\s/g, '')}${i+1}`);
            });

            let rosterBeforeChanges = {};
            Object.keys(dailyRoster).forEach(team => { rosterBeforeChanges[team] = dailyRoster[team].size; });

            teamMemberChanges.forEach(change => {
                if(currentDateStr >= change.date) {
                    if(!dailyRoster[change.team]) dailyRoster[change.team] = new Set();
                    if(change.type === 'Starts') {
                        dailyRoster[change.team].add(change.name);
                        if (currentDateStr === change.date) logs.push(`${currentDateStr}: 👷 ${change.name} joined ${change.team} team`);
                    } else {
                        dailyRoster[change.team].delete(change.name);
                    }
                }
            });

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
                const isOvertime = override && parseFloat(override.hours) > parseFloat(params.hoursPerDay);
                const currentDate = parseDate(currentDateStr);
                if (isOvertime) {
                    if (!overtimeTracking[team]) overtimeTracking[team] = { startDate: null, endDate: null, inCooldown: false, cooldownEndDate: null };
                    const tracking = overtimeTracking[team];
                    if (tracking.inCooldown && tracking.cooldownEndDate) {
                        const cooldownEnd = parseDate(tracking.cooldownEndDate);
                        if (currentDate < cooldownEnd) {
                            hours = parseFloat(params.hoursPerDay);
                            const daysRemaining = Math.ceil((cooldownEnd - currentDate) / (1000 * 60 * 60 * 24));
                            if (currentDateStr === override.startDate) logs.push(`${currentDateStr}: ⚠️ ${team} overtime blocked - in cooldown for ${daysRemaining} more days (ends ${tracking.cooldownEndDate})`);
                        } else {
                            tracking.inCooldown = false; tracking.cooldownEndDate = null;
                            tracking.startDate = currentDateStr; tracking.endDate = null;
                            hours = parseFloat(override.hours);
                            logs.push(`${currentDateStr}: ⏰ ${team} starting overtime (${hours}hrs/day) until ${override.endDate} - cooldown complete`);
                        }
                    } else {
                        if (!tracking.startDate) {
                            tracking.startDate = currentDateStr; tracking.endDate = null;
                            hours = parseFloat(override.hours);
                            logs.push(`${currentDateStr}: ⏰ ${team} starting overtime (${hours}hrs/day) until ${override.endDate}`);
                        } else {
                            const overtimeStart = parseDate(tracking.startDate);
                            const daysSinceStart = Math.floor((currentDate - overtimeStart) / (1000 * 60 * 60 * 24));
                            if (daysSinceStart >= MAX_OVERTIME_DAYS) {
                                if (!tracking.endDate) {
                                    tracking.endDate = currentDateStr; tracking.inCooldown = true;
                                    const cooldownEnd = new Date(currentDate); cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_DAYS);
                                    tracking.cooldownEndDate = formatDate(cooldownEnd);
                                    logs.push(`${currentDateStr}: 🛑 ${team} overtime limit reached (${MAX_OVERTIME_DAYS} days) - starting ${COOLDOWN_DAYS}-day cooldown until ${tracking.cooldownEndDate}`);
                                }
                                hours = parseFloat(params.hoursPerDay);
                            } else {
                                hours = parseFloat(override.hours);
                            }
                        }
                    }
                } else {
                    if (overtimeTracking[team] && overtimeTracking[team].startDate && !overtimeTracking[team].endDate) {
                        const tracking = overtimeTracking[team];
                        const overtimeStart = parseDate(tracking.startDate);
                        const daysSinceStart = Math.floor((currentDate - overtimeStart) / (1000 * 60 * 60 * 24));
                        tracking.endDate = currentDateStr;
                        if (daysSinceStart >= MAX_OVERTIME_DAYS) {
                            tracking.inCooldown = true;
                            const cooldownEnd = new Date(currentDate); cooldownEnd.setDate(cooldownEnd.getDate() + COOLDOWN_DAYS);
                            tracking.cooldownEndDate = formatDate(cooldownEnd);
                            logs.push(`${currentDateStr}: 📅 ${team} overtime ended after ${daysSinceStart} days - starting ${COOLDOWN_DAYS}-day cooldown until ${tracking.cooldownEndDate}`);
                        } else {
                            tracking.startDate = null; tracking.endDate = null;
                        }
                    }
                    if (override) hours = parseFloat(override.hours);
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
                // === STRATEGY CHANGE #3: Task sorting + relaxed SKU spreading ===
                const ready_tasks = unscheduled_tasks.filter(isReady).sort((a,b) => b.DynamicPriority - a.DynamicPriority);

                // Top 20% priority threshold: tasks above this can double up on SKUs
                const topPriorityThreshold = ready_tasks.length > 4 ? ready_tasks[Math.floor(ready_tasks.length * 0.2)]?.DynamicPriority || 0 : 0;

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
                                    // Relaxed SKU spreading: top 20% priority tasks can double up on SKUs
                                    let new_task = team_ready_tasks.find(t => !t.AssignedTo && (!skus_being_worked_on_today.has(t.SKU) || t.DynamicPriority >= topPriorityThreshold));
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
            if (loopCounter % 5 === 0) {
                const progress = 15 + Math.round((totalHoursCompleted / totalWorkloadHours) * 75);
                updateProgress(progress, `Simulating Day ${loopCounter + 1}...`);
                await yieldToEventLoop();
            }
            current_date.setDate(current_date.getDate() + 1);
            loopCounter++;
        }

        updateProgress(90, 'Finalizing results...');

        const workByMember = {};
        daily_log_entries.forEach(log => {
            if (!workByMember[log.TeamMember]) workByMember[log.TeamMember] = { hours: 0, tasks: 0 };
            workByMember[log.TeamMember].hours += log['Time Spent (Hours)'];
            workByMember[log.TeamMember].tasks++;
        });
        const newHireNames = new Set(teamMemberChanges.filter(c => c.type === 'Starts').map(c => c.name));
        if (newHireNames.size > 0) {
            logs.push(`\n--- Work Completed by New Hires ---`);
            newHireNames.forEach(name => {
                const work = workByMember[name];
                if (work) logs.push(`  ${name}: ${work.tasks} tasks, ${work.hours.toFixed(1)} hours`);
                else logs.push(`  ${name}: NO WORK ASSIGNED`);
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
        const projectedCompletion = projectSummary.length > 0 ? projectSummary.reduce((max, p) => p.FinishDate > max ? p.FinishDate : max, '0') : null;

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

        return { finalSchedule, projectSummary, taskSummary: finalSchedule, teamUtilization, weeklyOutput, dailyCompletions, teamWorkload, recommendations, projectedCompletion, logs, error };

    } catch (e) {
        console.error("Critical error in scheduling engine:", e);
        logs.push(`Critical Error: ${e.message}`);
        return { error: `A critical error occurred on the server: ${e.message}`, logs };
    }
};


module.exports = { runEarliestDueDateEngine, runCriticalPathEngine, runWorkLevelingEngine, runBottleneckFirstEngine };
