const test = require('node:test');
const assert = require('node:assert/strict');
const { validateOptimizeRunProposal } = require('../optimize-run-validation');

const baseTeamDefs = { headcounts: [
    { name: 'Paint', count: 8 }, { name: 'Scenic', count: 6 },
    { name: 'Carpentry', count: 10 }, { name: 'Assembly', count: 8 },
    { name: 'Tech', count: 5 }, { name: 'Metal', count: 3 },
    { name: 'CNC', count: 4 }, { name: 'Receiving', count: 4 }, { name: 'QC', count: 3 },
    { name: 'Kitting', count: 2 },
] };
const baseParams = { startDate: '2026-05-04' };

function body(overrides = {}) {
    return {
        params: baseParams,
        teamDefs: baseTeamDefs,
        horizonMonths: 6,
        ...overrides,
    };
}

// --- Preservation tests ---

test('preserves: bad flex route rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        hybridWorkers: [{ name: 'Flex-Paint-Tech-1', primaryTeam: 'Paint', secondaryTeam: 'Tech' }],
    }));
    assert.ok(errors.some(e => e.includes('Invalid flex route')));
});

test('preserves: OT >10h rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        workHourOverrides: [{ team: 'Paint', hours: 11, startDate: '2026-05-04', endDate: '2026-05-08' }],
    }));
    assert.ok(errors.some(e => e.includes('exceeds max 10h')));
});

test('preserves: +3 hire cap per team', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Paint-2', team: 'Paint', date: '2026-06-15' },
            { type: 'Starts', name: 'NewHire-Paint-3', team: 'Paint', date: '2026-06-29' },
            { type: 'Starts', name: 'NewHire-Paint-4', team: 'Paint', date: '2026-07-13' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('Too many hires')));
});

// --- New rule tests ---

test('horizon lock: rejects 3 months', () => {
    const errors = validateOptimizeRunProposal(body({ horizonMonths: 3 }));
    assert.ok(errors.some(e => e.includes('horizonMonths must be 6')));
});

test('horizon lock: accepts 6 months', () => {
    const errors = validateOptimizeRunProposal(body({ horizonMonths: 6 }));
    assert.ok(!errors.some(e => e.includes('horizonMonths')));
});

test('horizon lock: accepts missing (null) — optimizer-cron will set it', () => {
    const errors = validateOptimizeRunProposal(body({ horizonMonths: null }));
    assert.ok(!errors.some(e => e.includes('horizonMonths')));
});

test('Metal hire rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Metal-1', team: 'Metal', date: '2026-06-01' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('Metal cannot hire')));
});

test('Kitting: +1 accepted', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Kitting-1', team: 'Kitting', date: '2026-06-01' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('Kitting')));
});

test('Kitting: +2 rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Kitting-1', team: 'Kitting', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Kitting-2', team: 'Kitting', date: '2026-06-15' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('Kitting limited')));
});

test('CNC: baseline 4 + 1 hire = 5 total, accepted', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-CNC-1', team: 'CNC', date: '2026-06-01' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('CNC')));
});

test('CNC: baseline 4 + 2 hires = 6 total, rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-CNC-1', team: 'CNC', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-CNC-2', team: 'CNC', date: '2026-06-15' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('CNC headcount cap')));
});

test('stagger: same-team hires <14 days apart rejected', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Paint-2', team: 'Paint', date: '2026-06-10' },
        ],
    }));
    assert.ok(errors.some(e => e.includes('staggered')));
});

test('stagger: same-team hires >=14 days apart accepted', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Paint-2', team: 'Paint', date: '2026-06-15' },
            { type: 'Starts', name: 'NewHire-Paint-3', team: 'Paint', date: '2026-06-29' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('staggered')));
});

test('stagger: cross-team hires on same day are fine', () => {
    const errors = validateOptimizeRunProposal(body({
        teamMemberChanges: [
            { type: 'Starts', name: 'NewHire-Paint-1', team: 'Paint', date: '2026-06-01' },
            { type: 'Starts', name: 'NewHire-Assembly-1', team: 'Assembly', date: '2026-06-01' },
        ],
    }));
    assert.ok(!errors.some(e => e.includes('staggered')));
});
