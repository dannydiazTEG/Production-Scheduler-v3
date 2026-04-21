const test = require('node:test');
const assert = require('node:assert/strict');
const { sortStoresByDueDate } = require('../email-report');

test('sortStoresByDueDate: ascending across month boundaries (M/D/YYYY)', () => {
    // Mixed month lengths — catches the lex-sort bug where "10/*" < "3/*".
    const m = new Map([
        ['PC Batch 10', '10/10/2026'],
        ['PC Batch 2 026', '3/10/2026'],
        ['PCB', '4/26/2026'],
        ['PC Batch 3 026', '4/3/2026'],
        ['PC Batch 5', '5/21/2026'],
    ]);
    assert.deepEqual(
        sortStoresByDueDate(m),
        ['PC Batch 2 026', 'PC Batch 3 026', 'PCB', 'PC Batch 5', 'PC Batch 10']
    );
});

test('sortStoresByDueDate: within-month day order (4/3 before 4/26)', () => {
    const m = new Map([
        ['later', '4/26/2026'],
        ['earlier', '4/3/2026'],
    ]);
    assert.deepEqual(sortStoresByDueDate(m), ['earlier', 'later']);
});

test('sortStoresByDueDate: accepts ISO dates', () => {
    const m = new Map([
        ['Dec', '2026-12-01'],
        ['Jan', '2026-01-15'],
        ['Jul', '2026-07-04'],
    ]);
    assert.deepEqual(sortStoresByDueDate(m), ['Jan', 'Jul', 'Dec']);
});

test('sortStoresByDueDate: mixes ISO and US formats', () => {
    const m = new Map([
        ['usd', '4/3/2026'],
        ['iso', '2026-01-15'],
    ]);
    assert.deepEqual(sortStoresByDueDate(m), ['iso', 'usd']);
});

test('sortStoresByDueDate: null/missing dates sink to bottom', () => {
    const m = new Map([
        ['nodate-b', null],
        ['has-date', '4/3/2026'],
        ['nodate-a', null],
    ]);
    const result = sortStoresByDueDate(m);
    assert.equal(result[0], 'has-date');
    assert.deepEqual(result.slice(1).sort(), ['nodate-a', 'nodate-b']);
});

test('sortStoresByDueDate: unparseable date strings sink to bottom', () => {
    const m = new Map([
        ['valid', '4/3/2026'],
        ['garbage', 'not-a-date'],
    ]);
    assert.deepEqual(sortStoresByDueDate(m), ['valid', 'garbage']);
});

test('sortStoresByDueDate: stable across year boundary', () => {
    const m = new Map([
        ['2027-early', '1/5/2027'],
        ['2026-late', '12/20/2026'],
    ]);
    assert.deepEqual(sortStoresByDueDate(m), ['2026-late', '2027-early']);
});
