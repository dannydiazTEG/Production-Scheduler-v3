const test = require('node:test');
const assert = require('node:assert/strict');
const { computeOvertimeHours } = require('../overtime-calc');

const emptyPto = {};
const noHolidays = new Set();
const noChanges = [];

test('computeOvertimeHours: single window, 10h/day, 2 people, 5 weekdays', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-08', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 20);
    assert.equal(result.breakdown.length, 1);
    assert.equal(result.breakdown[0].team, 'Paint');
    assert.equal(result.breakdown[0].hours, 20);
    assert.equal(result.breakdown[0].source, 'config');
});

test('computeOvertimeHours: 9h/day = 1h OT per person per day', () => {
    const overrides = [
        { team: 'Assembly', hours: 9, startDate: '2026-05-04', endDate: '2026-05-04', source: 'llm' },
    ];
    const teamDefs = { headcounts: [{ name: 'Assembly', count: 3 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 3);
});

test('computeOvertimeHours: skips weekends', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-02', endDate: '2026-05-04', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 1 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-02' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 2);
});

test('computeOvertimeHours: skips holidays', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-06', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 1 }] };
    const holidays = new Set(['2026-05-05']);
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, holidays, noChanges);
    assert.equal(result.totalHours, 4);
});

test('computeOvertimeHours: accounts for PTO', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    const pto = { '2026-05-04': new Set(['Paint1']) };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, pto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 2);
});

test('computeOvertimeHours: overrides with hours <= standard are ignored', () => {
    const overrides = [
        { team: 'Paint', hours: 8, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
        { team: 'Paint', hours: 7, startDate: '2026-05-05', endDate: '2026-05-05', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 0);
});

test('computeOvertimeHours: splits breakdown by team', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
        { team: 'Assembly', hours: 9, startDate: '2026-05-04', endDate: '2026-05-04', source: 'llm' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 1 }, { name: 'Assembly', count: 1 }] };
    const result = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, emptyPto, teamDefs, noHolidays, noChanges);
    assert.equal(result.totalHours, 3);
    assert.equal(result.breakdown.length, 2);
});

test('computeOvertimeHours: excludes hybrid workers from base team roster', () => {
    const overrides = [
        { team: 'Paint', hours: 10, startDate: '2026-05-04', endDate: '2026-05-04', source: 'config' },
    ];
    const teamDefs = { headcounts: [{ name: 'Paint', count: 2 }] };
    // Hybrid worker "Jane" appears in teamMemberChanges as joining Paint but is really flex
    const teamMemberChanges = [
        { team: 'Paint', name: 'Jane', date: '2026-05-01', type: 'Starts' },
    ];
    const hybridWorkers = [{ name: 'Jane', primaryTeam: 'Scenic', secondaryTeam: 'Paint' }];
    const resultWithHybrid = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, {}, teamDefs, new Set(), teamMemberChanges, hybridWorkers);
    // Base Paint roster = 2 (Paint1, Paint2). Jane excluded because hybrid. Result = 2 people × 2h = 4h.
    assert.equal(resultWithHybrid.totalHours, 4);

    // Without hybridWorkers param, Jane IS counted (backward compat) — 3 × 2 = 6h.
    const resultWithoutHybrid = computeOvertimeHours(overrides, { hoursPerDay: 8, startDate: '2026-05-04' }, {}, teamDefs, new Set(), teamMemberChanges);
    assert.equal(resultWithoutHybrid.totalHours, 6);
});
