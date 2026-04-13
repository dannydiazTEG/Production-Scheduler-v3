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
                <td style="padding: 8px 0;">${best.categories.laborCost}/${best.categories.laborCostMax} pts${best.labor ? ` (${best.labor.overtimeHours}h OT, $${best.labor.overtimeCost.toLocaleString()})` : ''}</td>
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

/**
 * Generate the store breakdown table HTML.
 */
// Compact status summary for one store's row (variance cell).
function renderVarianceCell(s) {
    if (!s) return '<td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #94a3b8;">—</td>';
    let color, text;
    if (s.nsoStatus === 'WITHIN_TOLERANCE') {
        color = '#f59e0b';
        text = `+${s.latenessDays}d <span style="font-size: 11px; font-weight: normal; color: #92400e;">(within ${s.toleranceDays}d)</span>`;
    } else if (s.nsoStatus === 'EXCEEDS_TOLERANCE') {
        color = '#dc2626';
        text = `+${s.latenessDays}d <span style="font-size: 11px; font-weight: normal; color: #dc2626;">(over ${s.toleranceDays}d)</span>`;
    } else if (s.latenessDays > 0) {
        color = '#dc2626';
        text = `+${s.latenessDays}d`;
    } else if (s.daysEarly > 0) {
        color = '#16a34a';
        text = `-${s.daysEarly}d early`;
    } else if (s.status === 'ON_TIME') {
        color = '#16a34a';
        text = 'On Time';
    } else {
        color = '#94a3b8';
        text = '—';
    }
    return `<td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: ${color}; font-weight: bold;">${text}</td>`;
}

// Delta in days between best and baseline (negative = best finished earlier).
function renderDeltaCell(baselineStore, bestStore) {
    if (!baselineStore || !bestStore || !baselineStore.finishDate || !bestStore.finishDate) {
        return '<td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #94a3b8;">—</td>';
    }
    const parse = (s) => {
        const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    };
    const a = parse(baselineStore.finishDate);
    const b = parse(bestStore.finishDate);
    if (!a || !b) return '<td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #94a3b8;">—</td>';
    const days = Math.round((b - a) / (24 * 60 * 60 * 1000));
    if (days === 0) {
        return '<td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b;">no change</td>';
    }
    const color = days < 0 ? '#16a34a' : '#dc2626';
    const sign = days < 0 ? '' : '+';
    const label = days < 0 ? `${Math.abs(days)}d earlier` : `${days}d later`;
    return `<td style="padding: 8px; border-bottom: 1px solid #e2e8f0; color: ${color}; font-weight: bold;">${sign}${days}d <span style="font-size: 11px; font-weight: normal;">(${label})</span></td>`;
}

// Render a side-by-side store breakdown: baseline vs best.
// If baselineBreakdown is missing/empty, falls back to just showing best (legacy behaviour).
function renderStoreComparison(baselineBreakdown, bestBreakdown) {
    const best = bestBreakdown || [];
    const baseline = baselineBreakdown || [];
    if (best.length === 0 && baseline.length === 0) return '';

    // Build a map by store name so we can align rows even if order/count differs.
    const baselineByStore = new Map();
    for (const s of baseline) baselineByStore.set(s.store, s);

    // Primary row order follows the best-run breakdown; append any baseline-only stores at the end.
    const seen = new Set();
    const orderedStores = [];
    for (const s of best) {
        orderedStores.push(s.store);
        seen.add(s.store);
    }
    for (const s of baseline) {
        if (!seen.has(s.store)) orderedStores.push(s.store);
    }

    const bestByStore = new Map();
    for (const s of best) bestByStore.set(s.store, s);

    const rows = orderedStores.map(storeName => {
        const bestS = bestByStore.get(storeName);
        const baseS = baselineByStore.get(storeName);
        const refForMeta = bestS || baseS;
        const nsoTag = refForMeta.isNso ? ' <span style="background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-size: 11px;">NSO</span>' : '';
        return `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${storeName}${nsoTag}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${(refForMeta.projectTypes || []).join(', ')}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${refForMeta.dueDate || 'N/A'}</td>
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${baseS?.finishDate || '—'}</td>
            ${renderVarianceCell(baseS)}
            <td style="padding: 8px; border-bottom: 1px solid #e2e8f0;">${bestS?.finishDate || '—'}</td>
            ${renderVarianceCell(bestS)}
            ${renderDeltaCell(baseS, bestS)}
        </tr>`;
    }).join('');

    const hasBaseline = baseline.length > 0;
    return `
    <h3 style="color: #1e293b;">Store Breakdown — Baseline vs Optimized</h3>
    ${hasBaseline ? '' : '<p style="color: #94a3b8; font-size: 12px;">Baseline data unavailable — showing optimized only.</p>'}
    <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
            <tr style="background: #f1f5f9;">
                <th rowspan="2" style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Store</th>
                <th rowspan="2" style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Types</th>
                <th rowspan="2" style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Due</th>
                <th colspan="2" style="padding: 8px; text-align: left; border-bottom: 1px solid #cbd5e1; background: #e2e8f0;">Baseline</th>
                <th colspan="2" style="padding: 8px; text-align: left; border-bottom: 1px solid #cbd5e1; background: #dbeafe;">Optimized</th>
                <th rowspan="2" style="padding: 8px; text-align: left; border-bottom: 2px solid #cbd5e1;">Shift</th>
            </tr>
            <tr style="background: #f1f5f9;">
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1; background: #e2e8f0; font-size: 12px;">Finish</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1; background: #e2e8f0; font-size: 12px;">Variance</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1; background: #dbeafe; font-size: 12px;">Finish</th>
                <th style="padding: 6px 8px; text-align: left; border-bottom: 2px solid #cbd5e1; background: #dbeafe; font-size: 12px;">Variance</th>
            </tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>`;
}

/**
 * Generate parameter diff table.
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

    // Compare priority weights
    const baseWeights = baselineConfig.priorityWeights || {};
    const bestWeights = bestConfig.priorityWeights || {};
    for (const [key, val] of Object.entries(bestWeights)) {
        if (typeof val === 'object') continue; // Skip nested objects like tiers
        if (baseWeights[key] !== val) {
            diffs.push({ param: `Weight: ${key}`, baseline: baseWeights[key] ?? 'default', optimized: val });
        }
    }

    // Compare params
    const baseParams = baselineConfig.params || {};
    const bestParams = bestConfig.params || {};
    for (const key of ['productivityAssumption', 'globalBuffer', 'maxIdleDays', 'hoursPerDay']) {
        if (bestParams[key] !== undefined && bestParams[key] !== baseParams[key]) {
            diffs.push({ param: key, baseline: baseParams[key], optimized: bestParams[key] });
        }
    }

    // Compare overtime
    const baseOT = (baselineConfig.workHourOverrides || []).length;
    const bestOT = (bestConfig.workHourOverrides || []).length;
    if (bestOT !== baseOT) {
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
    const { baselineScore, bestScore, bestConfig, runHistory, strategistNotes, totalIterations, durationMinutes } = data;

    let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto; color: #1e293b;">
        <div style="background: #0f172a; color: white; padding: 20px 24px; border-radius: 8px 8px 0 0;">
            <h1 style="margin: 0; font-size: 20px;">TEG Schedule Optimization Report</h1>
            <p style="margin: 4px 0 0; color: #94a3b8; font-size: 14px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
        </div>
        <div style="padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 8px 8px;">
            ${renderExecutiveSummary(baselineScore, bestScore, totalIterations, durationMinutes)}`;

    if (includeDetails) {
        html += renderStoreComparison(baselineScore?.storeBreakdown, bestScore.storeBreakdown);
        html += renderParamDiff(
            { headcounts: baselineScore._baselineHeadcounts, priorityWeights: {}, params: baselineScore._baselineParams, workHourOverrides: [] },
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
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${p.week}</td>
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
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${v.week}</td>
                    <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0; color: #3b82f6; font-weight: bold;">${v.utilization}%</td>
                </tr>`).join('');
            html += `
            <h3 style="color: #1e293b;">Utilization Valleys <span style="font-weight: normal; color: #64748b; font-size: 13px;">(teams below 40%, excl. Receiving &amp; QC)</span></h3>
            <p style="color: #64748b; font-size: 13px; margin-top: 0;">Weeks where teams have significant idle capacity. Potential flex or cross-training opportunities.</p>
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
            <div style="background: #f8fafc; border-left: 4px solid #3b82f6; padding: 16px; border-radius: 0 4px 4px 0; white-space: pre-wrap; font-size: 14px; line-height: 1.6;">${strategistNotes}</div>`;
        }

        if (runHistory && runHistory.length > 0) {
            const topRuns = runHistory
                .filter(r => r.score !== Infinity && r.feasible)
                .sort((a, b) => a.score - b.score)
                .slice(0, 5);
            if (topRuns.length > 0) {
                const runRows = topRuns.map(r => `
                    <tr>
                        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">#${r.iteration}</td>
                        <td style="padding: 6px 8px; border-bottom: 1px solid #e2e8f0;">${r.score.toLocaleString()}</td>
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
 * Send the optimization report email.
 *
 * @param {Object} data - Report data (baselineScore, bestScore, bestConfig, runHistory, strategistNotes, totalIterations, durationMinutes)
 * @param {Object} recipients - { detailed: [emails], summary: [emails] }
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

    // Send detailed report
    if (detailedRecipients.length > 0) {
        const html = buildReportHtml(data, true);
        const info = await transporter.sendMail({ from, to: detailedRecipients.join(', '), subject, html });
        results.push({ type: 'detailed', to: detailedRecipients, messageId: info.messageId });
    }

    // Send summary-only report
    if (summaryRecipients.length > 0) {
        const html = buildReportHtml(data, false);
        const info = await transporter.sendMail({ from, to: summaryRecipients.join(', '), subject, html });
        results.push({ type: 'summary', to: summaryRecipients, messageId: info.messageId });
    }

    return results;
}

module.exports = { sendOptimizationReport, buildReportHtml };
