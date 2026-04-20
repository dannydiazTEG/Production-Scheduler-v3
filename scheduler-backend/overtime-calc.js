/**
 * overtime-calc.js — Compute overtime hours from config/LLM work-hour overrides.
 *
 * Why this exists: scheduling-engine.js treats OT windows by raising the day's
 * per-worker hours, which raises `capacity`. That means scoring can't see
 * configured OT via `worked - capacity`. This helper totals OT directly from
 * the override windows, independent of what the engine ran.
 *
 * An OT hour = (override.hours - standardHoursPerDay) per working headcount
 * per day within the window, excluding weekends, holidays, and PTO.
 */

function parseDate(s) {
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
    return new Date(s);
}

function formatDate(d) {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
}

function computeOvertimeHours(workHourOverrides, params, ptoMap, teamDefs, holidayList, teamMemberChanges) {
    const standardHours = parseFloat(params.hoursPerDay) || 8;
    const headcountByTeam = new Map((teamDefs.headcounts || []).map(h => [h.name, h.count || 0]));
    const breakdown = [];
    let totalHours = 0;

    for (const ot of (workHourOverrides || [])) {
        const otHours = parseFloat(ot.hours);
        if (!isFinite(otHours) || otHours <= standardHours) continue;

        const premiumPerPersonPerDay = otHours - standardHours;
        const start = parseDate(ot.startDate);
        const end = parseDate(ot.endDate || ot.startDate);
        let windowHours = 0;

        const baseHC = Math.floor(headcountByTeam.get(ot.team) || 0);
        const cursor = new Date(start.getTime());
        while (cursor <= end) {
            const dayStr = formatDate(cursor);
            const dow = cursor.getDay();
            if (dow !== 0 && dow !== 6 && !holidayList.has(dayStr)) {
                const roster = new Set();
                for (let h = 0; h < baseHC; h++) {
                    roster.add(`${ot.team.replace(/\s/g, '')}${h + 1}`);
                }
                for (const c of (teamMemberChanges || [])) {
                    if (c.team === ot.team && dayStr >= c.date) {
                        if (c.type === 'Starts') roster.add(c.name);
                        else roster.delete(c.name);
                    }
                }
                const ptoSet = ptoMap[dayStr] || new Set();
                const workingCount = [...roster].filter(m => !ptoSet.has(m)).length;
                windowHours += workingCount * premiumPerPersonPerDay;
            }
            cursor.setDate(cursor.getDate() + 1);
        }

        totalHours += windowHours;
        breakdown.push({
            team: ot.team,
            hours: Number(windowHours.toFixed(1)),
            startDate: ot.startDate,
            endDate: ot.endDate || ot.startDate,
            hoursPerDay: otHours,
            source: ot.source || 'unknown',
        });
    }

    return { totalHours: Number(totalHours.toFixed(1)), breakdown };
}

module.exports = { computeOvertimeHours };
