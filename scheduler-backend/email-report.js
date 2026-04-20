/**
 * email-report.js — Optimization report generation and email delivery.
 *
 * Uses nodemailer with Gmail SMTP.
 * Env vars: GMAIL_USER, GMAIL_APP_PASSWORD
 */

const nodemailer = require('nodemailer');

function createTransporter() {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) {
        throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD environment variables are required for email delivery.');
    }
    return nodemailer.createTransport({
        service: 'gmail',
        auth: { user, pass },
    });
}

// --- Date formatting helpers ---
// Convert ISO YYYY-MM-DD or engine dates to M/D/YYYY for readability.
function formatDateUS(dateStr) {
    if (!dateStr || dateStr === '—') return dateStr || '—';
    const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${parseInt(m[2])}/${parseInt(m[3])}/${m[1]}`;
    return dateStr; // already in US format or other — pass through
}

// Simple markdown-to-HTML: ## headings, **bold**, - bullets, paragraphs.
function markdownToHtml(md) {
    if (!md) return '';
    return md
        .replace(/^## (.+)$/gm, '<h4 style="margin: 14px 0 6px; color: #1e293b; font-size: 15px;">$1</h4>')
        .replace(/^### (.+)$/gm, '<h5 style="margin: 10px 0 4px; color: #334155; font-size: 14px;">$1</h5>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^- (.+)$/gm, '<div style="margin: 3px 0; padding-left: 14px;">&#8226; $1</div>')
        .replace(/\n\n/g, '</p><p style="margin: 8px 0;">')
        .replace(/\n/g, ' ');
}

/**
 * Render a brief glossary of the tunable parameters so non-technical readers
 * understand what each knob does.
 */
function renderParameterGlossary() {
    const params = [
        ['NSO Multiplier', 'How aggressively NSO stores are prioritized over other work. Higher = NSO finishes earlier.'],
        ['INFILL Multiplier', 'Priority boost for INFILL stores relative to Reno/PC work.'],
        ['Due Date Numerator', 'Controls urgency as a store approaches its due date. Higher = tasks ramp up priority sooner.'],
        ['Past Due Base', 'Penalty multiplier when work falls behind schedule. Higher = more aggressive catch-up.'],
        ['Assembly Lead Boost', 'Extra priority for the lead SKU going into Assembly, since it gates the whole store.'],
        ['In-Progress Boost', 'Priority for tasks already started. Higher = less task-switching, faster completion.'],
        ['Dwell Threshold', 'Days a task can sit idle before getting a priority bump to keep it moving.'],
    ];
    const rows = params.map(([name, desc]) => `
        <tr>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-weight: 600; font-size: 12px; white-space: nowrap;">${name}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; color: #475569; font-size: 12px;">${desc}</td>
        </tr>`).join('');
    return `
    <details style="margin-bottom: 16px;">
        <summary style="cursor: pointer; color: #3b82f6; font-size: 13px; font-weight: 600; margin-bottom: 6px;">What do these parameters mean?</summary>
        <table style="width: 100%; border-collapse: collapse; margin-top: 4px;">
            <tbody>${rows}</tbody>
        </table>
    </details>`;
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Generate the executive summary HTML section.
 */
function renderExecutiveSummary(baseline, best, totalIterations, durationMinutes) {
    const baseScore = baseline.compositeScore || baseline.score || 0;
    const bestScoreVal = best.compositeScore || best.score || 0;
    const improvement = baseScore === 0
        ? 'N/A'
        : `${baseScore.toFixed(1)} → ${bestScoreVal.toFixed(1)} / 100`;

    // Grade badge color
    const gradeColors = { 'A+': '#16a34a', 'A': '#16a34a', 'A-': '#22c55e', 'B+': '#3b82f6', 'B': '#3b82f6', 'B-': '#60a5fa', 'C': '#f59e0b', 'D+': '#f97316', 'D': '#ef4444', 'F': '#dc2626' };
    const gradeColor = gradeColors[best.grade] || '#64748b';

    // NSO status line
    let nsoLine;
    if (best.feasible && (best.nsoWithinTolerance || 0) === 0) {
        nsoLine = '<span style="color: #16a34a; font-weight: bold;">ALL NSO ON TIME</span>';
    } else if (best.feasible) {
        nsoLine = `<span style="color: #16a34a; font-weight: bold;">ALL NSO WITHIN TOLERANCE</span> <span style="color: #64748b;">(${best.nsoWithinTolerance} store(s) late but within allowed window)</span>`;
    } else {
        nsoLine = `<span style="color: #dc2626; font-weight: bold;">${best.nsoViolations.length} NSO STORE(S) EXCEED TOLERANCE</span>`;
        if ((best.nsoWithinTolerance || 0) > 0) {
            nsoLine += ` <span style="color: #64748b;">(${best.nsoWithinTolerance} other(s) within tolerance)</span>`;
        }
    }

    return `
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-bottom: 24px;">
        <div style="display: flex; align-items: center; margin-bottom: 16px;">
            <div style="background: ${gradeColor}; color: white; font-size: 28px; font-weight: bold; width: 56px; height: 56px; border-radius: 8px; display: flex; align-items: center; justify-content: center; margin-right: 16px;">${best.grade || '?'}</div>
            <div>
                <h2 style="margin: 0; color: #1e293b; font-size: 18px;">Schedule Optimization Results</h2>
                <p style="margin: 2px 0 0; color: #64748b; font-size: 14px;">${best.gradeSummary || ''}</p>
            </div>
        </div>
        <table style="width: 100%; border-collapse: collapse;">
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">Composite Score</td>
                <td style="padding: 8px 0; font-weight: bold;">${improvement}</td>
            </tr>
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">On-Time Delivery</td>
                <td style="padding: 8px 0; font-weight: bold;">${best.onTimeRate || 'N/A'}</td>
            </tr>
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">NSO/Infill Status</td>
                <td style="padding: 8px 0;">${nsoLine}</td>
            </tr>
            ${best.categories ? `
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">NSO/Infill Buffer</td>
                <td style="padding: 8px 0;">${best.categories.buffer}/${best.categories.bufferMax} pts</td>
            </tr>
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">Labor Efficiency</td>
                <td style="padding: 8px 0;">${best.categories.laborEfficiency}/${best.categories.laborEfficiencyMax} pts${best.labor ? ` ($${best.labor.efficiencyPerHour}/hr vs $${best.labor.efficiencyBaseline} target)` : ''}</td>
            </tr>
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">Labor Cost (OT)</td>
                <td style="padding: 8px 0;">${best.categories.laborCost}/${best.categories.laborCostMax} pts${best.labor ? ` (${best.labor.overtimeHours}h OT, $${(best.labor.overtimeCost || 0).toLocaleString()})` : ''}</td>
            </tr>
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">Reno/PC Adherence</td>
                <td style="padding: 8px 0;">${best.categories.adherence}/${best.categories.adherenceMax} pts</td>
            </tr>` : ''}
            <tr>
                <td style="padding: 8px 16px 8px 0; color: #64748b;">Optimization Runs</td>
                <td style="padding: 8px 0;">${totalIterations} iterations in ${durationMinutes} min</td>
            </tr>
        </table>
        <p style="margin: 12px 0 0; padding: 8px 12px; background: #fefce8; border-radius: 4px; font-size: 12px; color: #854d0e;">${best.nsoToleranceNote || ''}</p>
    </div>`;
}

// Compact variance label for store table cells.
function renderVarianceCompact(s) {
    if (!s) return '<span style="color: #94a3b8;">—</span>';
    if (s.nsoStatus === 'WITHIN_TOLERANCE') {
        return `<span style="color: #f59e0b; font-weight: bold;">+${s.latenessDays}d</span> <span style="font-size: 10px; color: #92400e;">(within ${s.toleranceDays}d)</span>`;
    }
    if (s.nsoStatus === 'EXCEEDS_TOLERANCE') {
        return `<span style="color: #dc2626; font-weight: bold;">+${s.latenessDays}d</span> <span style="font-size: 10px; color: #dc2626;">(over)</span>`;
    }
    if (s.latenessDays > 0) return `<span style="color: #dc2626; font-weight: bold;">+${s.latenessDays}d</span>`;
    if (s.daysEarly > 0) return `<span style="color: #16a34a; font-weight: bold;">-${s.daysEarly}d</span>`;
    if (s.status === 'ON_TIME') return '<span style="color: #16a34a;">On Time</span>';
    return '<span style="color: #94a3b8;">—</span>';
}

// Render a combined "finish date + variance" cell to keep columns narrow.
function renderFinishCell(s) {
    if (!s || !s.finishDate) return '<td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #94a3b8; font-size: 12px;">—</td>';
    return `<td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px;">
        ${formatDateUS(s.finishDate)}<br/>${renderVarianceCompact(s)}
    </td>`;
}

/**
 * Render the schedule comparison table: baseline + top-N optimized runs.
 * Each run gets ONE column (finish + variance stacked) to keep width under 700px.
 */
function renderScheduleComparison(baselineBreakdown, baselineScore, topRuns) {
    if (!topRuns || topRuns.length === 0) return '';
    const runs = topRuns.slice(0, 3);
    const baseline = baselineBreakdown || [];

    // Collect all stores (once each) and the best-known due date for each.
    const dueDateByStore = new Map();
    const addStores = (arr) => {
        for (const s of (arr || [])) {
            if (s.store && !dueDateByStore.has(s.store)) {
                dueDateByStore.set(s.store, s.dueDate || null);
            }
        }
    };
    addStores(baseline);
    for (const r of runs) addStores(r.storeBreakdown);

    // Sort ascending by due date. Stores with no due date go to the bottom.
    const storeOrder = [...dueDateByStore.keys()].sort((a, b) => {
        const da = dueDateByStore.get(a);
        const db = dueDateByStore.get(b);
        if (!da && !db) return a.localeCompare(b);
        if (!da) return 1;   // a has no due date → bottom
        if (!db) return -1;  // b has no due date → bottom
        return String(da).localeCompare(String(db));
    });

    const baseByStore = new Map();
    for (const s of baseline) baseByStore.set(s.store, s);
    const runsByStore = runs.map(r => {
        const map = new Map();
        for (const s of r.storeBreakdown || []) map.set(s.store, s);
        return map;
    });

    const basScoreLabel = baselineScore ? `${baselineScore.compositeScore ?? baselineScore.score ?? '?'}/100` : '';
    const runColors = ['#dbeafe', '#dcfce7', '#fef9c3'];

    const runHeaders = runs.map((r, i) => `
        <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1; background: ${runColors[i] || '#f1f5f9'}; font-size: 12px;">
            <div style="font-weight: bold;">#${r.iteration} — ${r.score}/100</div>
            <div style="font-weight: normal; font-size: 11px; color: #475569; margin-top: 2px;">${escapeHtml(r.paramChanges || '')}</div>
        </th>`).join('');

    const rows = storeOrder.map(storeName => {
        const baseS = baseByStore.get(storeName);
        const refForMeta = baseS || runsByStore.map(m => m.get(storeName)).find(Boolean);
        const nsoTag = refForMeta?.isNso ? ' <span style="background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-size: 10px;">NSO</span>' : '';
        const runCells = runsByStore.map(m => renderFinishCell(m.get(storeName))).join('');
        return `
        <tr>
            <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px;">${storeName}${nsoTag}</td>
            <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; font-size: 12px;">${formatDateUS(refForMeta?.dueDate)}</td>
            ${renderFinishCell(baseS)}
            ${runCells}
        </tr>`;
    }).join('');

    return `
    <h3 style="color: #1e293b; margin-top: 24px;">Schedule Comparison — Baseline vs Top Runs</h3>
    <p style="color: #64748b; font-size: 13px; margin: 0 0 8px;">Predicted finish and variance for each in-scope store. Each column is one engine run with different parameters.</p>
    <div style="overflow-x: auto;">
    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
            <tr style="background: #f1f5f9;">
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Store</th>
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Due</th>
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1; background: #e2e8f0;">
                    <div style="font-weight: bold;">Baseline</div>
                    <div style="font-size: 11px; color: #475569;">${basScoreLabel}</div>
                </th>
                ${runHeaders}
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>
    </div>`;
}

/**
 * Render the per-run OT breakdown section.
 *
 * Expects `bestScore.labor.overtimeBreakdown` — produced by scoring.js from
 * engineResult.overtimeBreakdown. Each entry: { team, hours, startDate, endDate,
 * hoursPerDay, source: 'config' | 'llm' | 'both' }.
 */
function renderOvertimeSection(bestScore, baselineOtBreakdown) {
    const bestBreakdown = (bestScore && bestScore.labor && bestScore.labor.overtimeBreakdown) || [];
    const totalOt = (bestScore && bestScore.labor && bestScore.labor.overtimeHours) || 0;

    if (bestBreakdown.length === 0 && (baselineOtBreakdown || []).length === 0) {
        return `<h3 style="color: #1e293b; margin-top: 24px;">Overtime</h3>
                <p style="color: #475569; font-size: 13px;">No OT windows in best run. ✅</p>`;
    }

    const baselineKeys = new Set(
        (baselineOtBreakdown || []).map(b => `${b.team}|${b.startDate}|${b.endDate}`)
    );

    const rows = bestBreakdown.map(w => {
        const key = `${w.team}|${w.startDate}|${w.endDate}`;
        const source = baselineKeys.has(key) ? 'config' : 'llm';
        const sourceBadge = source === 'config'
            ? '<span style="background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 11px;">config</span>'
            : '<span style="background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-size: 11px;">llm</span>';
        return `<tr>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px;">${escapeHtml(w.team)}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px;">${formatDateUS(w.startDate)} → ${formatDateUS(w.endDate)}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px; text-align: right;">${w.hoursPerDay ?? '?'}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px; text-align: right;">${w.hours}</td>
            <td style="padding: 4px 8px; border-bottom: 1px solid #f1f5f9; font-size: 12px;">${sourceBadge}</td>
        </tr>`;
    }).join('');

    const violations = findCooldownViolations(bestBreakdown);
    const violationHtml = violations.length === 0 ? '' : `
        <div style="margin-top: 8px; padding: 8px 12px; background: #fef2f2; border-left: 3px solid #ef4444; font-size: 13px; color: #7f1d1d;">
            ${violations.map(v => `⚠ ${escapeHtml(v)}`).join('<br>')}
        </div>`;

    return `
    <h3 style="color: #1e293b; margin-top: 24px;">Overtime — Best Run</h3>
    <p style="color: #64748b; font-size: 13px; margin: 0 0 8px;">Total: <strong>${totalOt.toFixed(1)}h</strong></p>
    <table style="width: 100%; border-collapse: collapse; font-size: 12px;">
        <thead>
            <tr style="background: #f1f5f9;">
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Team</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Window</th>
                <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #cbd5e1;">Hrs/day</th>
                <th style="padding: 6px 8px; text-align: right; border-bottom: 2px solid #cbd5e1;">Total OT hrs</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Source</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>
    ${violationHtml}`;
}

/**
 * Flag teams with back-to-back OT windows <1 month apart.
 * Returns an array of human-readable strings.
 */
function findCooldownViolations(breakdown) {
    const byTeam = new Map();
    for (const w of breakdown) {
        if (!byTeam.has(w.team)) byTeam.set(w.team, []);
        byTeam.get(w.team).push(w);
    }
    const violations = [];
    const parseIso = s => { const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
    for (const [team, windows] of byTeam.entries()) {
        const sorted = windows
            .map(w => ({ ...w, start: parseIso(w.startDate), end: parseIso(w.endDate) }))
            .filter(w => w.start && w.end)
            .sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
            const gapDays = Math.floor((sorted[i].start - sorted[i - 1].end) / (1000 * 60 * 60 * 24));
            if (gapDays < 30) {
                violations.push(`${team}: OT windows ${sorted[i - 1].startDate}→${sorted[i - 1].endDate} and ${sorted[i].startDate}→${sorted[i].endDate} — gap is ${gapDays}d (needs ≥30d).`);
            }
        }
    }
    return violations;
}

/**
 * Generate parameter diff table.
 * Only shows parameters that actually differ between baseline and optimized.
 */
function renderParamDiff(baselineConfig, bestConfig) {
    if (!baselineConfig || !bestConfig) return '';

    const diffs = [];

    // Compare headcounts
    const baseHeadcounts = (baselineConfig.headcounts || []).reduce((m, h) => { m[h.name] = h.count; return m; }, {});
    const bestHeadcounts = (bestConfig.headcounts || []).reduce((m, h) => { m[h.name] = h.count; return m; }, {});
    for (const [team, bestCount] of Object.entries(bestHeadcounts)) {
        const baseCount = baseHeadcounts[team];
        if (baseCount !== undefined && baseCount !== bestCount) {
            diffs.push({ param: `Headcount: ${team}`, baseline: baseCount, optimized: bestCount });
        }
    }

    // Compare priority weights (flatten nested projectTypeMultipliers)
    const flattenWeights = (obj, prefix = '') => {
        const out = {};
        for (const [k, v] of Object.entries(obj || {})) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
                Object.assign(out, flattenWeights(v, prefix ? `${prefix}.${k}` : k));
            } else {
                out[prefix ? `${prefix}.${k}` : k] = v;
            }
        }
        return out;
    };
    const baseWeights = flattenWeights(baselineConfig.priorityWeights || {});
    const bestWeights = flattenWeights(bestConfig.priorityWeights || {});
    for (const [key, val] of Object.entries(bestWeights)) {
        if (baseWeights[key] !== val) {
            diffs.push({ param: `Weight: ${key}`, baseline: baseWeights[key] ?? 'default', optimized: val });
        }
    }

    // Compare params — only show params that exist on BOTH sides or that changed
    const baseParams = baselineConfig.params || {};
    const bestParams = bestConfig.params || {};
    for (const key of ['productivityAssumption', 'globalBuffer', 'maxIdleDays', 'hoursPerDay']) {
        const bv = bestParams[key];
        const basv = baseParams[key];
        if (bv !== undefined && basv !== undefined && bv !== basv) {
            diffs.push({ param: key, baseline: basv, optimized: bv });
        }
    }

    // Compare overtime — only if counts actually differ
    const baseOT = (baselineConfig.workHourOverrides || []).length;
    const bestOT = (bestConfig.workHourOverrides || []).length;
    if (bestOT !== baseOT && baseOT !== undefined) {
        diffs.push({ param: 'Overtime Windows', baseline: `${baseOT} periods`, optimized: `${bestOT} periods` });
    }

    if (diffs.length === 0) return '<p style="color: #64748b;">No parameter changes from baseline.</p>';

    const rows = diffs.map(d => `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${d.param}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b;">${d.baseline}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0; font-weight: bold; color: #1e293b;">${d.optimized}</td>
        </tr>`).join('');

    return `
    <h3 style="color: #1e293b;">Parameter Changes</h3>
    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
            <tr style="background: #f1f5f9;">
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Parameter</th>
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Baseline</th>
                <th style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Optimized</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Build the full HTML email.
 */
function buildReportHtml(data, includeDetails) {
    const { baselineScore, bestScore, bestConfig, runHistory, topRuns, strategistNotes, totalIterations, durationMinutes } = data;

    let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; color: #1e293b;">
        <div style="background: #0f172a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 20px;">TEG Schedule Optimization Report</h1>
            <p style="margin: 4px 0 0; color: #94a3b8; font-size: 14px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>
        <div style="padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            ${renderExecutiveSummary(baselineScore, bestScore, totalIterations, durationMinutes)}
            ${renderParameterGlossary()}`;

    if (includeDetails) {
        // Single unified schedule comparison: baseline (with score) + top runs
        if (topRuns && topRuns.length > 0) {
            if (bestScore && bestScore.cncWeekendShiftAdvisory) {
                html += `
                <div style="margin: 16px 0; padding: 12px 16px; background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 4px;">
                    <strong style="color: #1e40af;">💡 CNC Weekend-Shift Advisory</strong><br>
                    <span style="color: #334155; font-size: 13px;">
                        CNC is running at sustained high utilization and NSO/Infill dates are slipping.
                        The optimizer cannot open a weekend shift — this requires a human decision.
                        Consider authorizing a Sat-Sun CNC shift if the schedule still shows misses.
                    </span>
                </div>`;
            }
            html += renderScheduleComparison(baselineScore?.storeBreakdown, baselineScore, topRuns);
            html += renderOvertimeSection(bestScore, baselineScore?.labor?.overtimeBreakdown);
        }

        html += renderParamDiff(
            { headcounts: bestConfig?.headcounts || [], priorityWeights: {}, params: bestConfig?.params || {}, workHourOverrides: [] },
            bestConfig
        );

        // Workload ratio peaks (teams over capacity)
        if (bestScore.teamHealth?.peaks?.length > 0) {
            const topPeaks = bestScore.teamHealth.peaks.slice(0, 15);
            const peakRows = topPeaks.map(p => {
                const ratioColor = p.workloadRatio >= 300 ? '#dc2626' : p.workloadRatio >= 200 ? '#f97316' : '#f59e0b';
                return `
                <tr>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${p.team}</td>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${formatDateUS(p.week)}</td>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: ${ratioColor}; font-weight: bold;">${p.workloadRatio}%</td>
                </tr>`;
            }).join('');
            html += `
            <h3 style="color: #1e293b;">Workload Peaks <span style="font-weight: normal; color: #64748b; font-size: 13px;">(teams over 150% capacity, excl. Receiving &amp; QC)</span></h3>
            <p style="color: #64748b; font-size: 13px; margin-top: 0;">Teams with more work assigned than they can handle in a given week. Higher % = more backlog building up.</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead><tr style="background: #f1f5f9;">
                    <th style="padding: 6px 8px; text-align: left;">Team</th>
                    <th style="padding: 6px 8px; text-align: left;">Week</th>
                    <th style="padding: 6px 8px; text-align: left;">Workload Ratio</th>
                </tr></thead>
                <tbody>${peakRows}</tbody>
            </table>`;
        }

        // Utilization valleys (teams with low utilization)
        if (bestScore.teamHealth?.valleys?.length > 0) {
            const topValleys = bestScore.teamHealth.valleys.slice(0, 15);
            const valleyRows = topValleys.map(v => `
                <tr>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${v.team}</td>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${formatDateUS(v.week)}</td>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #3b82f6; font-weight: bold;">${v.utilization}%</td>
                </tr>`).join('');
            html += `
            <h3 style="color: #1e293b;">Utilization Valleys <span style="font-weight: normal; color: #64748b; font-size: 13px;">(teams below 40%, excl. Receiving &amp; QC)</span></h3>
            <p style="color: #64748b; font-size: 13px; margin-top: 0;">Mid-schedule weeks where teams have significant idle capacity. Potential flex or cross-training opportunities.</p>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                <thead><tr style="background: #f1f5f9;">
                    <th style="padding: 6px 8px; text-align: left;">Team</th>
                    <th style="padding: 6px 8px; text-align: left;">Week</th>
                    <th style="padding: 6px 8px; text-align: left;">Utilization</th>
                </tr></thead>
                <tbody>${valleyRows}</tbody>
            </table>`;
        }

        if (strategistNotes) {
            html += `
            <h3 style="color: #1e293b;">Agent Analysis</h3>
            <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 12px 16px; border-radius: 0 4px 4px 0; font-size: 13px; line-height: 1.5;"><p style="margin: 0;">${markdownToHtml(strategistNotes)}</p></div>`;
        }

        if (runHistory && runHistory.length > 0) {
            const topFeasible = runHistory
                .filter(r => r.score > 0 && r.feasible)
                .sort((a, b) => b.score - a.score)
                .slice(0, 5);
            if (topFeasible.length > 0) {
                const runRows = topFeasible.map(r => `
                    <tr>
                        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">#${r.iteration}</td>
                        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${r.score}/100</td>
                        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${r.paramChanges || '-'}</td>
                    </tr>`).join('');
                html += `
                <h3 style="color: #1e293b;">Top 5 Runs</h3>
                <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <thead><tr style="background: #f1f5f9;">
                        <th style="padding: 6px 8px; text-align: left;">Iteration</th>
                        <th style="padding: 6px 8px; text-align: left;">Score</th>
                        <th style="padding: 6px 8px; text-align: left;">Changes</th>
                    </tr></thead>
                    <tbody>${runRows}</tbody>
                </table>`;
            }
        }
    }

    html += `
        <p style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 12px;">
            Generated by TEG Schedule Optimization Agent
        </p>
        </div>
    </div>`;

    return html;
}

/**
 * Send the optimization report.
 */
async function sendOptimizationReport(data, recipients) {
    const transporter = createTransporter();
    const results = [];

    const from = process.env.GMAIL_USER;
    const detailedRecipients = recipients.detailed || ['danny.diaz@theescapegame.com'];
    const summaryRecipients = recipients.summary || [];

    // New 0-100 scoring uses `compositeScore`; fall back to legacy `score` for older callers.
    const scoreValue = data.bestScore.compositeScore ?? data.bestScore.score ?? 0;
    const scoreLabel = typeof scoreValue === 'number' ? `${scoreValue}/100` : String(scoreValue);
    const subject = `Schedule Optimization: ${data.bestScore.feasible ? 'All NSO On-Time' : 'NSO Violations'} | Score ${scoreLabel} | ${data.totalIterations} runs`;

    // Convert attachment objects from the API payload into nodemailer format.
    const mailAttachments = (data.attachments || []).map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.filename.endsWith('.json') ? 'application/json' : 'text/csv',
    }));

    // Send detailed report (with attachments)
    if (detailedRecipients.length > 0) {
        const html = buildReportHtml(data, true);
        const info = await transporter.sendMail({
            from, to: detailedRecipients.join(', '), subject, html,
            attachments: mailAttachments,
        });
        results.push({ type: 'detailed', to: detailedRecipients, messageId: info.messageId, attachmentCount: mailAttachments.length });
    }

    // Send summary-only report (no attachments — keep it light for stakeholders)
    if (summaryRecipients.length > 0) {
        const html = buildReportHtml(data, false);
        const info = await transporter.sendMail({ from, to: summaryRecipients.join(', '), subject, html });
        results.push({ type: 'summary', to: summaryRecipients, messageId: info.messageId });
    }

    return results;
}

module.exports = { sendOptimizationReport, buildReportHtml };
