/**
 * optimize-run-validation.js — Pure validation logic for /api/optimize-run.
 *
 * Only flags LLM-added entries (identified by naming convention: NewHire-*, Flex-*).
 * Pre-existing entries from uploaded configs use human names and are left alone.
 */

const ALLOWED_FLEX_ROUTES = new Set([
    'Paint→Scenic', 'Scenic→Paint',
    'Carpentry→Assembly', 'Assembly→Carpentry',
    'Tech→Metal',
]);
const NO_FLEX_TEAMS = new Set(['CNC', 'Receiving', 'QC']);
const LOCKED_HORIZON_MONTHS = 6;
const CNC_MAX_TOTAL = 5;
const KITTING_MAX_ADD = 1;
const METAL_MAX_ADD = 0;
const HIRE_STAGGER_DAYS = 14;
const HIRE_EARLIEST_OFFSET_DAYS = 28;

function validateOptimizeRunProposal(body) {
    const errors = [];
    const {
        params, teamDefs,
        hybridWorkers, workHourOverrides, teamMemberChanges,
        horizonMonths,
    } = body || {};

    if (horizonMonths != null && Number(horizonMonths) !== LOCKED_HORIZON_MONTHS) {
        errors.push(`horizonMonths must be ${LOCKED_HORIZON_MONTHS} (received ${horizonMonths}). Horizon is locked.`);
    }

    const baseHC = new Map(((teamDefs && teamDefs.headcounts) || []).map(h => [h.name, h.count]));

    if (hybridWorkers && hybridWorkers.length > 0) {
        const flexFromCount = new Map();
        for (const hw of hybridWorkers) {
            if (!hw.name || !hw.name.startsWith('Flex-')) continue;
            const route = `${hw.primaryTeam}→${hw.secondaryTeam}`;
            if (!ALLOWED_FLEX_ROUTES.has(route)) {
                errors.push(`Invalid flex route: ${route}. Allowed: Paint↔Scenic, Carpentry↔Assembly, Tech→Metal.`);
            }
            if (NO_FLEX_TEAMS.has(hw.primaryTeam)) {
                errors.push(`Cannot flex from ${hw.primaryTeam} — too specialized.`);
            }
            const count = (flexFromCount.get(hw.primaryTeam) || 0) + 1;
            flexFromCount.set(hw.primaryTeam, count);
            const teamHC = baseHC.get(hw.primaryTeam) || 0;
            const maxFlex = Math.floor(teamHC * 0.20);
            if (count > maxFlex) {
                errors.push(`Too many flex from ${hw.primaryTeam}: ${count} exceeds 20% cap (${maxFlex} max of ${teamHC}).`);
            }
        }
    }

    if (workHourOverrides && workHourOverrides.length > 0) {
        for (const ot of workHourOverrides) {
            const hours = parseFloat(ot.hours);
            if (hours > 10) errors.push(`OT window for ${ot.team}: ${hours}h/day exceeds max 10h.`);
        }
    }

    if (teamMemberChanges && teamMemberChanges.length > 0) {
        const scheduleStart = (params && params.startDate) ? new Date(params.startDate) : new Date();
        const earliestHire = new Date(scheduleStart);
        earliestHire.setDate(earliestHire.getDate() + HIRE_EARLIEST_OFFSET_DAYS);
        const earliestHireStr = earliestHire.toISOString().slice(0, 10);

        const hiresByTeam = new Map();
        for (const change of teamMemberChanges) {
            if (change.type !== 'Starts' || !change.name || !change.name.startsWith('NewHire')) continue;
            const team = change.team;
            const list = hiresByTeam.get(team) || [];
            list.push(change);
            hiresByTeam.set(team, list);

            if (change.date && new Date(change.date) < earliestHire) {
                errors.push(`Hire for ${team} starts ${change.date}, before earliest allowed ${earliestHireStr} (28d after schedule start).`);
            }
        }

        for (const [team, hires] of hiresByTeam.entries()) {
            const added = hires.length;
            if (team === 'Metal' && added > METAL_MAX_ADD) {
                errors.push(`Metal cannot hire (Tech hybrid covers). Proposal adds ${added}.`);
            } else if (team === 'Kitting' && added > KITTING_MAX_ADD) {
                errors.push(`Kitting limited to +${KITTING_MAX_ADD} hire with strong justification. Proposal adds ${added}.`);
            } else if (team === 'CNC') {
                const baseCnc = baseHC.get('CNC') || 0;
                if (baseCnc + added > CNC_MAX_TOTAL) {
                    errors.push(`CNC headcount cap: ${baseCnc} baseline + ${added} hires > ${CNC_MAX_TOTAL}. Request weekend shift instead.`);
                }
            } else if (added > 3) {
                errors.push(`Too many hires for ${team}: ${added} exceeds max +3.`);
            }

            // Same-team stagger
            const dates = hires
                .map(h => h.date)
                .filter(Boolean)
                .map(d => new Date(d))
                .sort((a, b) => a - b);
            for (let i = 1; i < dates.length; i++) {
                const diffDays = Math.floor((dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24));
                if (diffDays < HIRE_STAGGER_DAYS) {
                    errors.push(`Same-team hires on ${team} must be staggered >=${HIRE_STAGGER_DAYS} days. Got ${diffDays}d between ${dates[i - 1].toISOString().slice(0,10)} and ${dates[i].toISOString().slice(0,10)}.`);
                }
            }
        }
    }

    return errors;
}

module.exports = {
    validateOptimizeRunProposal,
    ALLOWED_FLEX_ROUTES,
    LOCKED_HORIZON_MONTHS,
    CNC_MAX_TOTAL,
    KITTING_MAX_ADD,
    METAL_MAX_ADD,
    HIRE_STAGGER_DAYS,
};
