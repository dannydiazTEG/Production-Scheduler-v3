import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronUp, Lock, RefreshCw, Upload, Download, AlertTriangle, CheckCircle, Save, Trash2, PlusCircle, FileText, Database } from 'lucide-react';
import {
    getLatestRaw, getHistory,
    patchTasksCsv, patchDatesCsv, patchStoreDates,
    patchConfigMerge, patchConfigReplace,
    getAdminToken, setAdminToken,
} from './adminApi';

const inputStyles = 'block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 bg-slate-100 text-sm p-2';
const smallInputStyles = 'block w-full rounded-md border-gray-300 shadow-sm text-sm p-1';
const btnPrimary = 'inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium';
const btnGhost = 'inline-flex items-center px-3 py-1.5 bg-slate-200 text-slate-700 rounded-md hover:bg-slate-300 text-sm font-medium';
const btnDanger = 'inline-flex items-center px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 text-sm font-medium';

// --- CSV helpers (self-contained, not imported from App.js) ---
function parseCsvToRows(csvText) {
    const lines = csvText.replace(/\r/g, '').split('\n').filter(l => l.length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].split(',').map(h => h.trim());
    const rows = lines.slice(1).map(line => {
        const cols = line.split(',');
        const row = {};
        headers.forEach((h, i) => { row[h] = (cols[i] ?? '').trim(); });
        return row;
    });
    return { headers, rows };
}
function rowsToCsv(headers, rows) {
    const header = headers.join(',');
    const body = rows.map(r => headers.map(h => (r[h] ?? '')).join(',')).join('\n');
    return header + '\n' + body;
}
function downloadBlob(filename, text, mime = 'text/csv') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================================
// Token prompt (shown at the top of the section when no token is stored)
// ============================================================================
function AdminTokenPrompt({ onSaved }) {
    const [value, setValue] = useState('');
    const save = () => {
        const trimmed = value.trim();
        if (!trimmed) return;
        setAdminToken(trimmed);
        onSaved(trimmed);
    };
    return (
        <div className="bg-amber-50 border border-amber-200 rounded-md p-4">
            <div className="flex items-center mb-2">
                <Lock className="w-4 h-4 mr-2 text-amber-700" />
                <span className="font-semibold text-amber-900">Admin token required</span>
            </div>
            <p className="text-sm text-amber-800 mb-3">
                Baseline file edits require the <code className="bg-amber-100 px-1 rounded">ADMIN_TOKEN</code> configured on the backend.
                Your browser stores this locally; you only enter it once per device.
            </p>
            <div className="flex items-center gap-2">
                <input
                    type="password"
                    value={value}
                    onChange={e => setValue(e.target.value)}
                    placeholder="Paste ADMIN_TOKEN"
                    className={inputStyles}
                    onKeyDown={e => { if (e.key === 'Enter') save(); }}
                />
                <button onClick={save} className={btnPrimary} disabled={!value.trim()}>Save</button>
            </div>
        </div>
    );
}

// ============================================================================
// History tab
// ============================================================================
function HistoryTab() {
    const [history, setHistory] = useState(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');

    const load = useCallback(async () => {
        setLoading(true); setErr('');
        try {
            const res = await getHistory();
            setHistory(res.snapshots || []);
        } catch (e) { setErr(e.message); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { load(); }, [load]);

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">Snapshot history</h3>
                <button onClick={load} className={btnGhost}><RefreshCw className="w-4 h-4 mr-1" />Refresh</button>
            </div>
            <p className="text-sm text-slate-500 mb-3">The backend retains the 5 most recent uploads. Oldest are auto-deleted.</p>
            {loading && <p className="text-sm text-slate-500">Loading…</p>}
            {err && <p className="text-sm text-red-600">Error: {err}</p>}
            {history && (
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead className="bg-slate-100"><tr>
                            <th className="text-left p-2">Uploaded</th>
                            <th className="text-right p-2">Tasks CSV</th>
                            <th className="text-right p-2">Dates CSV</th>
                            <th className="text-left p-2">Start Date</th>
                            <th className="text-right p-2">Teams</th>
                            <th className="text-right p-2">Mappings</th>
                            <th className="text-right p-2">OT Windows</th>
                            <th className="text-right p-2">Hires</th>
                            <th className="text-right p-2">Flex</th>
                        </tr></thead>
                        <tbody>
                            {history.map((s, i) => (
                                <tr key={s.id} className={i === 0 ? 'bg-green-50 font-medium' : ''}>
                                    <td className="p-2">{new Date(s.uploadedAt).toLocaleString()}</td>
                                    <td className="p-2 text-right">{(s.tasksCsvLength / 1024).toFixed(0)} KB</td>
                                    <td className="p-2 text-right">{s.datesCsvLength} B</td>
                                    <td className="p-2">{s.configSummary?.startDate || '—'}</td>
                                    <td className="p-2 text-right">{s.configSummary?.teamCount ?? '—'}</td>
                                    <td className="p-2 text-right">{s.configSummary?.mappingCount ?? '—'}</td>
                                    <td className="p-2 text-right">{s.configSummary?.otWindowCount ?? '—'}</td>
                                    <td className="p-2 text-right">{s.configSummary?.hireCount ?? '—'}</td>
                                    <td className="p-2 text-right">{s.configSummary?.flexCount ?? '—'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Tasks tab: download current / upload + diff preview / replace
// ============================================================================
function TasksDiffPreview({ currentCsv, newCsv }) {
    const diff = useMemo(() => {
        if (!currentCsv || !newCsv) return null;
        const cur = parseCsvToRows(currentCsv);
        const nxt = parseCsvToRows(newCsv);
        const count = (rows, key) => {
            const m = new Map();
            for (const r of rows) m.set(r[key] || '', (m.get(r[key] || '') || 0) + 1);
            return m;
        };
        const curStores = count(cur.rows, 'Store');
        const nxtStores = count(nxt.rows, 'Store');
        const storesAdded = [...nxtStores.keys()].filter(s => !curStores.has(s));
        const storesRemoved = [...curStores.keys()].filter(s => !nxtStores.has(s));
        const storesChanged = [...curStores.keys()]
            .filter(s => nxtStores.has(s) && curStores.get(s) !== nxtStores.get(s))
            .map(s => ({ store: s, before: curStores.get(s), after: nxtStores.get(s), diff: nxtStores.get(s) - curStores.get(s) }));
        const curOps = count(cur.rows, 'Operation');
        const nxtOps = count(nxt.rows, 'Operation');
        const allOps = new Set([...curOps.keys(), ...nxtOps.keys()]);
        const opsChanged = [...allOps]
            .map(op => ({ op, before: curOps.get(op) || 0, after: nxtOps.get(op) || 0 }))
            .filter(r => r.before !== r.after)
            .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
        return {
            curRowCount: cur.rows.length, nxtRowCount: nxt.rows.length,
            netRowDelta: nxt.rows.length - cur.rows.length,
            curStoreCount: curStores.size, nxtStoreCount: nxtStores.size,
            storesAdded, storesRemoved, storesChanged,
            opsChanged,
        };
    }, [currentCsv, newCsv]);

    if (!diff) return null;
    return (
        <div className="bg-slate-50 border border-slate-200 rounded-md p-4 mt-3">
            <h4 className="font-semibold mb-2 flex items-center"><FileText className="w-4 h-4 mr-1" />Diff preview</h4>
            <div className="grid grid-cols-3 gap-4 mb-3 text-sm">
                <div><span className="text-slate-500">Total rows:</span> <span className="font-mono">{diff.curRowCount} → {diff.nxtRowCount}</span> <span className={diff.netRowDelta >= 0 ? 'text-green-700' : 'text-red-700'}>({diff.netRowDelta >= 0 ? '+' : ''}{diff.netRowDelta})</span></div>
                <div><span className="text-slate-500">Stores:</span> <span className="font-mono">{diff.curStoreCount} → {diff.nxtStoreCount}</span></div>
                <div><span className="text-slate-500">Operations changed:</span> <span className="font-mono">{diff.opsChanged.length}</span></div>
            </div>
            {diff.storesAdded.length > 0 && <div className="text-sm mb-2"><span className="font-medium text-green-700">Added stores ({diff.storesAdded.length}):</span> {diff.storesAdded.join(', ')}</div>}
            {diff.storesRemoved.length > 0 && <div className="text-sm mb-2"><span className="font-medium text-red-700">Removed stores ({diff.storesRemoved.length}):</span> {diff.storesRemoved.join(', ')}</div>}
            {diff.storesChanged.length > 0 && (
                <details className="mb-2">
                    <summary className="text-sm font-medium text-slate-700 cursor-pointer">Changed store task counts ({diff.storesChanged.length})</summary>
                    <table className="w-full text-xs mt-2"><tbody>
                        {diff.storesChanged.map(r => (
                            <tr key={r.store}><td className="p-1">{r.store}</td><td className="p-1 text-right font-mono">{r.before} → {r.after}</td><td className="p-1 text-right"><span className={r.diff >= 0 ? 'text-green-700' : 'text-red-700'}>{r.diff >= 0 ? '+' : ''}{r.diff}</span></td></tr>
                        ))}
                    </tbody></table>
                </details>
            )}
            {diff.opsChanged.length > 0 && (
                <details>
                    <summary className="text-sm font-medium text-slate-700 cursor-pointer">Changed operations ({diff.opsChanged.length})</summary>
                    <table className="w-full text-xs mt-2"><tbody>
                        {diff.opsChanged.slice(0, 20).map(r => (
                            <tr key={r.op}><td className="p-1">{r.op || '(blank)'}</td><td className="p-1 text-right font-mono">{r.before} → {r.after}</td></tr>
                        ))}
                    </tbody></table>
                </details>
            )}
        </div>
    );
}

function TasksTab({ raw, refresh, onWrite, onStatus }) {
    const [newCsv, setNewCsv] = useState(null);
    const [newFileName, setNewFileName] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const onFile = (e) => {
        const file = e.target.files[0]; if (!file) return;
        const r = new FileReader();
        r.onload = ev => { setNewCsv(ev.target.result); setNewFileName(file.name); };
        r.readAsText(file);
    };

    const commit = async () => {
        if (!newCsv) return;
        if (!window.confirm(`Replace the stored tasks_csv with ${newFileName}? This cannot be undone (the previous snapshot will fall off after 5 more uploads).`)) return;
        setSubmitting(true);
        try {
            await patchTasksCsv(newCsv);
            onStatus('success', 'Tasks CSV replaced.');
            setNewCsv(null); setNewFileName('');
            onWrite();
        } catch (e) { onStatus('error', `Replace failed: ${e.message}`); }
        finally { setSubmitting(false); }
    };

    const stats = useMemo(() => {
        if (!raw?.tasksCsv) return null;
        const { headers, rows } = parseCsvToRows(raw.tasksCsv);
        const stores = new Set(rows.map(r => r.Store));
        const ops = {}; for (const r of rows) ops[r.Operation] = (ops[r.Operation] || 0) + 1;
        return { headers, rowCount: rows.length, storeCount: stores.size, opCount: Object.keys(ops).length };
    }, [raw]);

    return (
        <div>
            <h3 className="text-lg font-semibold mb-3">Tasks CSV</h3>

            <div className="bg-slate-50 border border-slate-200 rounded-md p-4 mb-4">
                <div className="flex items-center justify-between mb-2">
                    <span className="font-medium">Current snapshot</span>
                    <button className={btnGhost} onClick={() => raw?.tasksCsv && downloadBlob('tasks.csv', raw.tasksCsv)} disabled={!raw?.tasksCsv}>
                        <Download className="w-4 h-4 mr-1" />Download
                    </button>
                </div>
                {!raw && <p className="text-sm text-slate-500">Loading…</p>}
                {stats && (
                    <div className="grid grid-cols-4 gap-4 text-sm">
                        <div><div className="text-slate-500">Uploaded</div><div className="font-mono">{new Date(raw.uploadedAt).toLocaleDateString()}</div></div>
                        <div><div className="text-slate-500">Rows</div><div className="font-mono">{stats.rowCount.toLocaleString()}</div></div>
                        <div><div className="text-slate-500">Stores</div><div className="font-mono">{stats.storeCount}</div></div>
                        <div><div className="text-slate-500">Operations</div><div className="font-mono">{stats.opCount}</div></div>
                    </div>
                )}
            </div>

            <div className="border-2 border-dashed border-slate-300 rounded-md p-4">
                <label className="flex items-center justify-center cursor-pointer">
                    <Upload className="w-5 h-5 mr-2 text-slate-500" />
                    <span className="text-sm font-medium text-slate-700">{newFileName || 'Drop or click to upload a new tasks CSV'}</span>
                    <input type="file" accept=".csv" className="hidden" onChange={onFile} />
                </label>
            </div>

            {newCsv && raw?.tasksCsv && <TasksDiffPreview currentCsv={raw.tasksCsv} newCsv={newCsv} />}

            {newCsv && (
                <div className="flex items-center gap-3 mt-4">
                    <button onClick={commit} className={btnDanger} disabled={submitting}>
                        {submitting ? 'Replacing…' : `Replace baseline with ${newFileName}`}
                    </button>
                    <button onClick={() => { setNewCsv(null); setNewFileName(''); }} className={btnGhost} disabled={submitting}>Cancel</button>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Dates tab: editable table (per-row PATCH via /store-dates) + full CSV replace
// ============================================================================
function DatesTab({ raw, refresh, onStatus }) {
    const [mode, setMode] = useState('table'); // 'table' | 'replace'
    const [rows, setRows] = useState([]);
    const [headers, setHeaders] = useState([]);
    const [dirty, setDirty] = useState(new Set()); // row indexes changed
    const [deletedProjects, setDeletedProjects] = useState([]);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        if (!raw?.datesCsv) return;
        const parsed = parseCsvToRows(raw.datesCsv);
        setHeaders(parsed.headers);
        setRows(parsed.rows.map(r => ({ ...r, __origProject: r.Project })));
        setDirty(new Set()); setDeletedProjects([]);
    }, [raw]);

    const updateCell = (idx, key, value) => {
        setRows(prev => prev.map((r, i) => i === idx ? { ...r, [key]: value } : r));
        setDirty(prev => new Set(prev).add(idx));
    };
    const addRow = () => {
        const blank = {}; headers.forEach(h => blank[h] = ''); blank.__origProject = '';
        setRows(prev => [...prev, blank]);
        setDirty(prev => new Set(prev).add(rows.length));
    };
    const removeRow = (idx) => {
        const r = rows[idx];
        if (r.__origProject) setDeletedProjects(prev => [...prev, r.__origProject]);
        setRows(prev => prev.filter((_, i) => i !== idx));
        setDirty(prev => { const n = new Set(prev); n.delete(idx); return n; });
    };

    const saveTable = async () => {
        if (!window.confirm(`Save ${dirty.size} edits and ${deletedProjects.length} deletions to baseline dates?`)) return;
        setSubmitting(true);
        try {
            // If any row was deleted OR added OR Project renamed, the /store-dates PATCH
            // isn't sufficient (it only updates existing rows by name). Fall back to
            // full CSV replace in those cases.
            const hasStructuralChange = deletedProjects.length > 0 ||
                rows.some((r, i) => dirty.has(i) && r.Project !== r.__origProject);
            if (hasStructuralChange) {
                const cleanRows = rows.map(r => { const { __origProject, ...rest } = r; return rest; });
                const csv = rowsToCsv(headers, cleanRows);
                await patchDatesCsv(csv);
                onStatus('success', 'Dates CSV replaced (structural edits detected).');
            } else {
                const updates = [...dirty].map(idx => {
                    const r = rows[idx];
                    return {
                        store: r.Project,
                        productionDueDate: r['Production Due Date'] || undefined,
                        installDate: r['Install Date'] || undefined,
                    };
                }).filter(u => u.store);
                if (updates.length) await patchStoreDates(updates);
                onStatus('success', `Updated ${updates.length} store date(s).`);
            }
            refresh();
        } catch (e) { onStatus('error', `Save failed: ${e.message}`); }
        finally { setSubmitting(false); }
    };

    const [replaceCsv, setReplaceCsv] = useState(null);
    const [replaceName, setReplaceName] = useState('');
    const onReplaceFile = (e) => {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = ev => { setReplaceCsv(ev.target.result); setReplaceName(f.name); };
        r.readAsText(f);
    };
    const commitReplace = async () => {
        if (!replaceCsv) return;
        if (!window.confirm(`Replace dates_csv entirely with ${replaceName}?`)) return;
        setSubmitting(true);
        try {
            await patchDatesCsv(replaceCsv);
            onStatus('success', 'Dates CSV replaced.');
            setReplaceCsv(null); setReplaceName(''); refresh();
        } catch (e) { onStatus('error', `Replace failed: ${e.message}`); }
        finally { setSubmitting(false); }
    };

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">Install Dates CSV</h3>
                <div className="flex items-center gap-1 bg-slate-100 rounded p-0.5">
                    <button onClick={() => setMode('table')} className={`px-3 py-1 rounded text-xs font-medium ${mode === 'table' ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>Table</button>
                    <button onClick={() => setMode('replace')} className={`px-3 py-1 rounded text-xs font-medium ${mode === 'replace' ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>Replace CSV</button>
                </div>
            </div>

            {mode === 'table' && (
                <div>
                    <div className="flex items-center justify-between mb-2">
                        <button onClick={() => raw?.datesCsv && downloadBlob('install-dates.csv', raw.datesCsv)} className={btnGhost} disabled={!raw}><Download className="w-4 h-4 mr-1" />Download current</button>
                        <div className="flex items-center gap-2">
                            <button onClick={addRow} className={btnGhost}><PlusCircle className="w-4 h-4 mr-1" />Add row</button>
                            <button onClick={saveTable} className={btnPrimary} disabled={submitting || (dirty.size === 0 && deletedProjects.length === 0)}>
                                <Save className="w-4 h-4 mr-1" />{submitting ? 'Saving…' : `Save (${dirty.size + deletedProjects.length})`}
                            </button>
                        </div>
                    </div>
                    <div className="overflow-x-auto max-h-[32rem]">
                        <table className="w-full text-xs">
                            <thead className="bg-slate-100 sticky top-0"><tr>
                                {headers.map(h => <th key={h} className="text-left p-2">{h || '(blank)'}</th>)}
                                <th className="w-8"></th>
                            </tr></thead>
                            <tbody>
                                {rows.map((row, i) => (
                                    <tr key={i} className={dirty.has(i) ? 'bg-yellow-50' : ''}>
                                        {headers.map(h => (
                                            <td key={h} className="p-1">
                                                <input type="text" value={row[h] ?? ''} onChange={e => updateCell(i, h, e.target.value)} className={smallInputStyles} />
                                            </td>
                                        ))}
                                        <td><button onClick={() => removeRow(i)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-xs text-slate-500 mt-2">Edits to existing rows go through the per-row <code>PATCH /store-dates</code> endpoint. Renaming a row's <code>Project</code>, deleting, or adding rows triggers a full CSV replace.</p>
                </div>
            )}

            {mode === 'replace' && (
                <div>
                    <div className="border-2 border-dashed border-slate-300 rounded-md p-4">
                        <label className="flex items-center justify-center cursor-pointer">
                            <Upload className="w-5 h-5 mr-2 text-slate-500" />
                            <span className="text-sm font-medium text-slate-700">{replaceName || 'Drop or click to upload a new install dates CSV'}</span>
                            <input type="file" accept=".csv" className="hidden" onChange={onReplaceFile} />
                        </label>
                    </div>
                    {replaceCsv && (
                        <div className="mt-4">
                            <div className="bg-slate-50 border p-3 rounded-md text-xs mb-3">
                                <pre className="whitespace-pre overflow-x-auto max-h-48">{replaceCsv.split('\n').slice(0, 10).join('\n')}{replaceCsv.split('\n').length > 10 ? '\n…' : ''}</pre>
                                <p className="text-slate-500 mt-2">{replaceCsv.split('\n').filter(l => l.length).length - 1} data rows</p>
                            </div>
                            <button onClick={commitReplace} className={btnDanger} disabled={submitting}>{submitting ? 'Replacing…' : `Replace dates CSV with ${replaceName}`}</button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Config tab: shared-secret form + raw JSON
// ============================================================================
function ConfigTab({ raw, refresh, onStatus }) {
    const [mode, setMode] = useState('form'); // 'form' | 'json'
    const [cfg, setCfg] = useState(null);
    const [rawJson, setRawJson] = useState('');
    const [rawJsonError, setRawJsonError] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        if (!raw?.configJson) return;
        setCfg(raw.configJson);
        setRawJson(JSON.stringify(raw.configJson, null, 2));
        setDirty(false);
    }, [raw]);

    if (!cfg) return <p className="text-sm text-slate-500">Loading…</p>;

    const updateCfg = (updater) => {
        setCfg(prev => { const next = updater(prev); setRawJson(JSON.stringify(next, null, 2)); setDirty(true); return next; });
    };
    const updateParams = (key, val) => updateCfg(c => ({ ...c, params: { ...c.params, [key]: val } }));
    const updateHeadcount = (id, val) => updateCfg(c => ({
        ...c,
        teamDefs: { ...c.teamDefs, headcounts: c.teamDefs.headcounts.map(h => h.id === id ? { ...h, count: parseFloat(val) || 0 } : h) }
    }));
    const updateMapping = (idx, key, val) => updateCfg(c => ({
        ...c,
        teamDefs: { ...c.teamDefs, mapping: c.teamDefs.mapping.map((m, i) => i === idx ? { ...m, [key]: val } : m) }
    }));
    const addMapping = () => updateCfg(c => ({
        ...c,
        teamDefs: { ...c.teamDefs, mapping: [...c.teamDefs.mapping, { id: Date.now(), team: c.teamDefs.headcounts[0]?.name || '', operation: '' }] }
    }));
    const removeMapping = (idx) => updateCfg(c => ({
        ...c,
        teamDefs: { ...c.teamDefs, mapping: c.teamDefs.mapping.filter((_, i) => i !== idx) }
    }));
    const updateOt = (idx, key, val) => updateCfg(c => ({ ...c, workHourOverrides: c.workHourOverrides.map((o, i) => i === idx ? { ...o, [key]: val } : o) }));
    const addOt = () => updateCfg(c => ({ ...c, workHourOverrides: [...(c.workHourOverrides || []), { id: Date.now(), team: c.teamDefs.headcounts[0]?.name || '', hours: '9', startDate: '', endDate: '' }] }));
    const removeOt = (idx) => updateCfg(c => ({ ...c, workHourOverrides: c.workHourOverrides.filter((_, i) => i !== idx) }));
    const updateHire = (idx, key, val) => updateCfg(c => ({ ...c, teamMemberChanges: c.teamMemberChanges.map((h, i) => i === idx ? { ...h, [key]: val } : h) }));
    const addHire = () => updateCfg(c => ({ ...c, teamMemberChanges: [...(c.teamMemberChanges || []), { id: Date.now(), name: '', team: c.teamDefs.headcounts[0]?.name || '', type: 'Starts', date: '' }] }));
    const removeHire = (idx) => updateCfg(c => ({ ...c, teamMemberChanges: c.teamMemberChanges.filter((_, i) => i !== idx) }));
    const updateFlex = (idx, key, val) => updateCfg(c => ({ ...c, hybridWorkers: c.hybridWorkers.map((h, i) => i === idx ? { ...h, [key]: val } : h) }));
    const addFlex = () => updateCfg(c => ({ ...c, hybridWorkers: [...(c.hybridWorkers || []), { id: Date.now(), name: '', primaryTeam: c.teamDefs.headcounts[0]?.name || '', secondaryTeam: c.teamDefs.headcounts[0]?.name || '' }] }));
    const removeFlex = (idx) => updateCfg(c => ({ ...c, hybridWorkers: c.hybridWorkers.filter((_, i) => i !== idx) }));
    const updatePto = (idx, key, val) => updateCfg(c => ({ ...c, ptoEntries: c.ptoEntries.map((p, i) => i === idx ? { ...p, [key]: val } : p) }));
    const addPto = () => updateCfg(c => ({ ...c, ptoEntries: [...(c.ptoEntries || []), { id: Date.now(), memberName: '', date: '' }] }));
    const removePto = (idx) => updateCfg(c => ({ ...c, ptoEntries: c.ptoEntries.filter((_, i) => i !== idx) }));

    const saveForm = async () => {
        if (!window.confirm('Save config changes to baseline?')) return;
        setSubmitting(true);
        try {
            await patchConfigMerge({
                params: cfg.params,
                teamDefs: cfg.teamDefs,
                ptoEntries: cfg.ptoEntries,
                teamMemberChanges: cfg.teamMemberChanges,
                workHourOverrides: cfg.workHourOverrides,
                hybridWorkers: cfg.hybridWorkers,
            });
            onStatus('success', 'Config saved.');
            setDirty(false); refresh();
        } catch (e) { onStatus('error', `Save failed: ${e.message}`); }
        finally { setSubmitting(false); }
    };

    const saveJson = async () => {
        setRawJsonError('');
        let parsed;
        try { parsed = JSON.parse(rawJson); }
        catch (e) { setRawJsonError(e.message); return; }
        if (!window.confirm('Replace entire config with the JSON above? Fields not present in the JSON will be removed.')) return;
        setSubmitting(true);
        try {
            await patchConfigReplace(parsed);
            onStatus('success', 'Config replaced.');
            setDirty(false); refresh();
        } catch (e) { onStatus('error', `Save failed: ${e.message}`); }
        finally { setSubmitting(false); }
    };

    const teams = cfg.teamDefs.headcounts || [];

    return (
        <div>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-lg font-semibold">Config JSON</h3>
                <div className="flex items-center gap-1 bg-slate-100 rounded p-0.5">
                    <button onClick={() => setMode('form')} className={`px-3 py-1 rounded text-xs font-medium ${mode === 'form' ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>Form</button>
                    <button onClick={() => setMode('json')} className={`px-3 py-1 rounded text-xs font-medium ${mode === 'json' ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>Raw JSON</button>
                </div>
            </div>

            {mode === 'form' && (
                <div className="space-y-4">
                    {/* Params */}
                    <details open className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">Parameters</summary>
                        <div className="grid grid-cols-2 gap-3 mt-3">
                            {['startDate', 'hoursPerDay', 'productivityAssumption', 'globalBuffer', 'maxIdleDays'].map(k => (
                                <div key={k}>
                                    <label className="block text-xs text-slate-500">{k}</label>
                                    <input type="text" value={cfg.params?.[k] ?? ''} onChange={e => updateParams(k, e.target.value)} className={smallInputStyles} />
                                </div>
                            ))}
                            <div className="col-span-2">
                                <label className="block text-xs text-slate-500">teamsToIgnore</label>
                                <input type="text" value={cfg.params?.teamsToIgnore ?? ''} onChange={e => updateParams('teamsToIgnore', e.target.value)} className={smallInputStyles} />
                            </div>
                            <div className="col-span-2">
                                <label className="block text-xs text-slate-500">holidays (comma-separated YYYY-MM-DD)</label>
                                <textarea value={cfg.params?.holidays ?? ''} onChange={e => updateParams('holidays', e.target.value)} className={`${smallInputStyles} h-16`} />
                            </div>
                        </div>
                    </details>

                    {/* Headcounts */}
                    <details className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">Team headcounts ({teams.length})</summary>
                        <div className="mt-3 space-y-1">
                            {teams.map(t => (
                                <div key={t.id} className="flex items-center gap-2">
                                    <span className="font-medium w-24">{t.name}</span>
                                    <input type="number" step="0.5" value={t.count} onChange={e => updateHeadcount(t.id, e.target.value)} className={`${smallInputStyles} w-24`} />
                                </div>
                            ))}
                        </div>
                    </details>

                    {/* Mapping */}
                    <details className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">Team → operation mapping ({cfg.teamDefs.mapping?.length || 0})</summary>
                        <div className="mt-3 space-y-1">
                            {(cfg.teamDefs.mapping || []).map((m, i) => (
                                <div key={m.id || i} className="grid grid-cols-[1fr_2fr_auto] gap-2 items-center">
                                    <select value={m.team} onChange={e => updateMapping(i, 'team', e.target.value)} className={smallInputStyles}>
                                        {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                                    </select>
                                    <input type="text" value={m.operation} onChange={e => updateMapping(i, 'operation', e.target.value)} className={smallInputStyles} placeholder="Operation name" />
                                    <button onClick={() => removeMapping(i)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            ))}
                            <button onClick={addMapping} className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center"><PlusCircle className="w-4 h-4 mr-1" />Add mapping</button>
                        </div>
                    </details>

                    {/* OT windows */}
                    <details className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">Work hour overrides ({cfg.workHourOverrides?.length || 0})</summary>
                        <div className="mt-3 space-y-1">
                            {(cfg.workHourOverrides || []).map((o, i) => (
                                <div key={o.id || i} className="grid grid-cols-[1fr_auto_1fr_1fr_auto] gap-2 items-center">
                                    <select value={o.team} onChange={e => updateOt(i, 'team', e.target.value)} className={smallInputStyles}>
                                        {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                                    </select>
                                    <input type="number" step="0.5" value={o.hours} onChange={e => updateOt(i, 'hours', e.target.value)} className={`${smallInputStyles} w-20`} placeholder="Hrs" />
                                    <input type="date" value={o.startDate} onChange={e => updateOt(i, 'startDate', e.target.value)} className={smallInputStyles} />
                                    <input type="date" value={o.endDate} onChange={e => updateOt(i, 'endDate', e.target.value)} className={smallInputStyles} />
                                    <button onClick={() => removeOt(i)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            ))}
                            <button onClick={addOt} className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center"><PlusCircle className="w-4 h-4 mr-1" />Add OT window</button>
                        </div>
                    </details>

                    {/* Hires */}
                    <details className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">Team member changes / hires ({cfg.teamMemberChanges?.length || 0})</summary>
                        <div className="mt-3 space-y-1">
                            {(cfg.teamMemberChanges || []).map((h, i) => (
                                <div key={h.id || i} className="grid grid-cols-[auto_1fr_1fr_1fr_auto] gap-2 items-center">
                                    <select value={h.type} onChange={e => updateHire(i, 'type', e.target.value)} className={smallInputStyles}><option>Starts</option><option>Leaves</option></select>
                                    <input type="text" value={h.name} onChange={e => updateHire(i, 'name', e.target.value)} className={smallInputStyles} placeholder="Name" />
                                    <select value={h.team} onChange={e => updateHire(i, 'team', e.target.value)} className={smallInputStyles}>
                                        {teams.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                                    </select>
                                    <input type="date" value={h.date} onChange={e => updateHire(i, 'date', e.target.value)} className={smallInputStyles} />
                                    <button onClick={() => removeHire(i)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            ))}
                            <button onClick={addHire} className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center"><PlusCircle className="w-4 h-4 mr-1" />Add change</button>
                        </div>
                    </details>

                    {/* Flex */}
                    <details className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">Hybrid / flex workers ({cfg.hybridWorkers?.length || 0})</summary>
                        <div className="mt-3 space-y-1">
                            {(cfg.hybridWorkers || []).map((f, i) => (
                                <div key={f.id || i} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 items-center">
                                    <input type="text" value={f.name} onChange={e => updateFlex(i, 'name', e.target.value)} className={smallInputStyles} placeholder="Name" />
                                    <select value={f.primaryTeam} onChange={e => updateFlex(i, 'primaryTeam', e.target.value)} className={smallInputStyles}>
                                        {teams.map(t => <option key={t.id} value={t.name}>Primary: {t.name}</option>)}
                                    </select>
                                    <select value={f.secondaryTeam} onChange={e => updateFlex(i, 'secondaryTeam', e.target.value)} className={smallInputStyles}>
                                        {teams.map(t => <option key={t.id} value={t.name}>Secondary: {t.name}</option>)}
                                    </select>
                                    <button onClick={() => removeFlex(i)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            ))}
                            <button onClick={addFlex} className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center"><PlusCircle className="w-4 h-4 mr-1" />Add flex worker</button>
                        </div>
                    </details>

                    {/* PTO */}
                    <details className="border rounded p-3">
                        <summary className="font-medium cursor-pointer">PTO entries ({cfg.ptoEntries?.length || 0})</summary>
                        <div className="mt-3 space-y-1">
                            {(cfg.ptoEntries || []).map((p, i) => (
                                <div key={p.id || i} className="grid grid-cols-[1fr_1fr_auto] gap-2 items-center">
                                    <input type="text" value={p.memberName} onChange={e => updatePto(i, 'memberName', e.target.value)} className={smallInputStyles} placeholder="Member name" />
                                    <input type="date" value={p.date} onChange={e => updatePto(i, 'date', e.target.value)} className={smallInputStyles} />
                                    <button onClick={() => removePto(i)} className="text-red-500 hover:text-red-700"><Trash2 className="w-4 h-4" /></button>
                                </div>
                            ))}
                            <button onClick={addPto} className="mt-2 text-sm font-medium text-blue-600 hover:text-blue-800 flex items-center"><PlusCircle className="w-4 h-4 mr-1" />Add PTO</button>
                        </div>
                    </details>

                    <div className="flex items-center gap-3 pt-3 border-t">
                        <button onClick={saveForm} className={btnPrimary} disabled={submitting || !dirty}>
                            <Save className="w-4 h-4 mr-1" />{submitting ? 'Saving…' : 'Save config'}
                        </button>
                        {dirty && <span className="text-xs text-amber-700">Unsaved changes</span>}
                    </div>
                </div>
            )}

            {mode === 'json' && (
                <div>
                    <textarea
                        value={rawJson}
                        onChange={e => { setRawJson(e.target.value); setDirty(true); setRawJsonError(''); }}
                        className="w-full h-96 font-mono text-xs p-2 border rounded"
                        spellCheck={false}
                    />
                    {rawJsonError && <p className="text-sm text-red-600 mt-1">Parse error: {rawJsonError}</p>}
                    <div className="flex items-center gap-3 mt-3">
                        <button onClick={saveJson} className={btnDanger} disabled={submitting || !dirty}>
                            {submitting ? 'Saving…' : 'Replace config with JSON above'}
                        </button>
                        <span className="text-xs text-slate-500">Full replace — fields missing from JSON will be removed.</span>
                    </div>
                </div>
            )}
        </div>
    );
}

// ============================================================================
// Top-level container
// ============================================================================
export default function BaselineFilesSection() {
    const [isOpen, setIsOpen] = useState(false);
    const [hasToken, setHasToken] = useState(!!getAdminToken());
    const [tab, setTab] = useState('tasks');
    const [raw, setRaw] = useState(null);
    const [loadErr, setLoadErr] = useState('');
    const [status, setStatus] = useState(null); // { kind: 'success'|'error', msg: string }

    const loadRaw = useCallback(async () => {
        setLoadErr('');
        try {
            const data = await getLatestRaw();
            setRaw(data);
        } catch (e) { setLoadErr(e.message); }
    }, []);

    useEffect(() => { if (isOpen && hasToken) loadRaw(); }, [isOpen, hasToken, loadRaw]);

    const showStatus = (kind, msg) => {
        setStatus({ kind, msg });
        setTimeout(() => setStatus(null), 5000);
    };

    const tabs = [
        { key: 'tasks', label: 'Tasks CSV' },
        { key: 'dates', label: 'Install Dates CSV' },
        { key: 'config', label: 'Config JSON' },
        { key: 'history', label: 'History' },
    ];

    return (
        <div className="bg-white p-5 rounded-lg shadow">
            <div className="flex justify-between items-center cursor-pointer" onClick={() => setIsOpen(v => !v)}>
                <h2 className="text-xl font-bold flex items-center">
                    <Database className="w-5 h-5 mr-2 text-slate-500" />
                    Baseline Files (Admin)
                </h2>
                {isOpen ? <ChevronUp className="w-5 h-5 text-slate-500" /> : <ChevronDown className="w-5 h-5 text-slate-500" />}
            </div>

            {isOpen && (
                <div className="mt-4 border-t pt-4">
                    {!hasToken && <AdminTokenPrompt onSaved={() => setHasToken(true)} />}
                    {hasToken && (
                        <>
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-1 bg-slate-100 rounded p-0.5">
                                    {tabs.map(t => (
                                        <button key={t.key} onClick={() => setTab(t.key)}
                                            className={`px-4 py-2 rounded text-sm font-medium ${tab === t.key ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500 hover:text-slate-700'}`}>
                                            {t.label}
                                        </button>
                                    ))}
                                </div>
                                <button onClick={() => { setAdminToken(''); setHasToken(false); }} className="text-xs text-slate-500 hover:text-red-600">Clear token</button>
                            </div>

                            {loadErr && <div className="bg-red-50 border border-red-200 p-3 rounded mb-3 text-sm text-red-700">Failed to load baseline: {loadErr}</div>}
                            {status && (
                                <div className={`p-3 rounded mb-3 text-sm flex items-center ${status.kind === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>
                                    {status.kind === 'success' ? <CheckCircle className="w-4 h-4 mr-2" /> : <AlertTriangle className="w-4 h-4 mr-2" />}
                                    {status.msg}
                                </div>
                            )}

                            {tab === 'tasks' && <TasksTab raw={raw} refresh={loadRaw} onWrite={loadRaw} onStatus={showStatus} />}
                            {tab === 'dates' && <DatesTab raw={raw} refresh={loadRaw} onStatus={showStatus} />}
                            {tab === 'config' && <ConfigTab raw={raw} refresh={loadRaw} onStatus={showStatus} />}
                            {tab === 'history' && <HistoryTab />}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
