const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStoreWorkBreakdown } = require('../store-work-breakdown');

const TEAMS = ['Receiving', 'CNC', 'Metal', 'Scenic', 'Paint', 'Carpentry', 'Assembly', 'Tech', 'QC'];

function row(overrides) {
    return {
        store: 'X', matchedStore: 'X', projectTypes: [],
        finishDate: null, dueDate: null, latenessDays: 0, daysEarly: 0,
        isNso: false, isInfill: false, isHardGate: false,
        status: 'ON_TIME',
        ...overrides,
    };
}

test('computeStoreWorkBreakdown: single store, single team', () => {
    const preparedTasks = [
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 4.5 },
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 2 },
    ];
    const storeBreakdown = [row({
        store: 'PCB', projectTypes: ['NSO'], isNso: true,
        dueDate: '2026-04-26', finishDate: '2026-05-06', latenessDays: 10,
    })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 1);
    const r = result[0];
    assert.equal(r.store, 'PCB');
    assert.equal(r.projectType, 'NSO');
    assert.equal(r.dueDate, '2026-04-26');
    assert.equal(r.finishDate, '2026-05-06');
    assert.equal(r.latenessDays, 10);
    assert.equal(r.totalOps, 2);
    assert.equal(r.totalHours, 6.5);
    assert.equal(r.teams.Paint.ops, 2);
    assert.equal(r.teams.Paint.hours, 6.5);
    assert.equal(r.teams.Tech.ops, 0);
    assert.equal(r.teams.Tech.hours, 0);
});

test('computeStoreWorkBreakdown: single store across multiple teams', () => {
    const preparedTasks = [
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 3 },
        { Store: 'PCB', Team: 'Tech', HoursRemaining: 1.5 },
        { Store: 'PCB', Team: 'Tech', HoursRemaining: 2 },
    ];
    const storeBreakdown = [row({ store: 'PCB' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    const r = result[0];
    assert.equal(r.totalOps, 3);
    assert.equal(r.totalHours, 6.5);
    assert.equal(r.teams.Paint.ops, 1);
    assert.equal(r.teams.Paint.hours, 3);
    assert.equal(r.teams.Tech.ops, 2);
    assert.equal(r.teams.Tech.hours, 3.5);
});

test('computeStoreWorkBreakdown: multiple stores rolled up independently', () => {
    const preparedTasks = [
        { Store: 'PCB', Team: 'Paint', HoursRemaining: 3 },
        { Store: 'Dallas', Team: 'Assembly', HoursRemaining: 5 },
    ];
    const storeBreakdown = [row({ store: 'PCB' }), row({ store: 'Dallas' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 2);
    const pcb = result.find(r => r.store === 'PCB');
    const dal = result.find(r => r.store === 'Dallas');
    assert.equal(pcb.teams.Paint.ops, 1);
    assert.equal(dal.teams.Assembly.ops, 1);
    assert.equal(pcb.teams.Assembly.ops, 0);
});

test('computeStoreWorkBreakdown: ignored teams fold into totals but not per-team breakdown', () => {
    const preparedTasks = [
        { Store: 'X', Team: 'Paint', HoursRemaining: 5 },
        { Store: 'X', Team: 'Unassigned', HoursRemaining: 2 },
        { Store: 'X', Team: 'Print', HoursRemaining: 3 },
    ];
    const storeBreakdown = [row({ store: 'X' })];
    const teamsToIgnore = new Set(['Unassigned', 'Print']);
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), teamsToIgnore);
    const r = result[0];
    assert.equal(r.totalOps, 3);
    assert.equal(r.totalHours, 10);
    assert.equal(r.teams.Paint.ops, 1);
    assert.equal(r.teams.Paint.hours, 5);
    assert.ok(!('Unassigned' in r.teams));
    assert.ok(!('Print' in r.teams));
});

test('computeStoreWorkBreakdown: store in breakdown with no tasks emits zero row', () => {
    const preparedTasks = [];
    const storeBreakdown = [row({ store: 'Quiet', dueDate: '2026-06-01' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 1);
    const r = result[0];
    assert.equal(r.store, 'Quiet');
    assert.equal(r.totalOps, 0);
    assert.equal(r.totalHours, 0);
    for (const t of TEAMS) {
        assert.equal(r.teams[t].ops, 0);
        assert.equal(r.teams[t].hours, 0);
    }
});

test('computeStoreWorkBreakdown: tasks for stores outside breakdown are skipped', () => {
    const preparedTasks = [
        { Store: 'InScope', Team: 'Paint', HoursRemaining: 5 },
        { Store: 'OutOfScope', Team: 'Paint', HoursRemaining: 99 },
    ];
    const storeBreakdown = [row({ store: 'InScope' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result.length, 1);
    assert.equal(result[0].totalOps, 1);
});

test('computeStoreWorkBreakdown: projectType resolves from storeBreakdown.projectTypes', () => {
    const storeBreakdown = [
        row({ store: 'A', projectTypes: ['NSO'] }),
        row({ store: 'B', projectTypes: ['INFILL'] }),
        row({ store: 'C', projectTypes: ['RENO', 'PC'] }),
        row({ store: 'D', projectTypes: [] }),
    ];
    const result = computeStoreWorkBreakdown([], storeBreakdown, new Map(), new Set());
    const byStore = Object.fromEntries(result.map(r => [r.store, r.projectType]));
    assert.equal(byStore.A, 'NSO');
    assert.equal(byStore.B, 'INFILL');
    assert.equal(byStore.C, 'PC/RENO');
    assert.equal(byStore.D, '');
});

test('computeStoreWorkBreakdown: fractional hours round to 1 decimal', () => {
    const preparedTasks = [
        { Store: 'X', Team: 'Paint', HoursRemaining: 0.333333 },
        { Store: 'X', Team: 'Paint', HoursRemaining: 0.666666 },
    ];
    const storeBreakdown = [row({ store: 'X' })];
    const result = computeStoreWorkBreakdown(preparedTasks, storeBreakdown, new Map(), new Set());
    assert.equal(result[0].totalHours, 1);
    assert.equal(result[0].teams.Paint.hours, 1);
});
