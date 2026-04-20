const test = require('node:test');
const assert = require('node:assert/strict');
const { businessDaysEarly, bufferScore } = require('../scoring');

test('businessDaysEarly: same day = 0', () => {
    assert.equal(businessDaysEarly('2026-05-01', '2026-05-01'), 0);
});

test('businessDaysEarly: finish 1 weekday before due = +1', () => {
    // Thu finish, Fri due
    assert.equal(businessDaysEarly('2026-05-01', '2026-04-30'), 1);
});

test('businessDaysEarly: skips weekends', () => {
    // Fri 2026-05-01 due, Mon 2026-04-27 finish → Mon, Tue, Wed, Thu = 4 business days early
    assert.equal(businessDaysEarly('2026-05-01', '2026-04-27'), 4);
});

test('businessDaysEarly: finish after due = negative', () => {
    // Fri due, next Mon finish → 1 business day late
    assert.equal(businessDaysEarly('2026-05-01', '2026-05-04'), -1);
});

test('businessDaysEarly: two full weeks early = 10', () => {
    // 2026-05-01 Fri due, 2026-04-17 Fri finish → 10 business days (M,T,W,T,F,M,T,W,T,F)
    assert.equal(businessDaysEarly('2026-05-01', '2026-04-17'), 10);
});

test('businessDaysEarly: across year boundary', () => {
    // 2026-01-05 Mon due, 2025-12-29 Mon finish → M,T,W,T,F = 5 business days
    assert.equal(businessDaysEarly('2026-01-05', '2025-12-29'), 5);
});

test('bufferScore: late = 0', () => {
    assert.equal(bufferScore(-1), 0);
    assert.equal(bufferScore(-10), 0);
});

test('bufferScore: on due date = 50', () => {
    assert.equal(bufferScore(0), 50);
});

test('bufferScore: 4 bd early = 80', () => {
    assert.equal(bufferScore(4), 80);
});

test('bufferScore: 10 bd early = peak 100', () => {
    assert.equal(bufferScore(10), 100);
});

test('bufferScore: 15 bd early = 70', () => {
    assert.equal(bufferScore(15), 70);
});

test('bufferScore: 20 bd early = 60', () => {
    // max(40, 70 - (20-15)*2) = max(40, 60) = 60
    assert.equal(bufferScore(20), 60);
});

test('bufferScore: 30 bd early = 40 floor', () => {
    // max(40, 70 - 15*2) = max(40, 40) = 40
    assert.equal(bufferScore(30), 40);
});

test('bufferScore: 100 bd early = 40 floor', () => {
    assert.equal(bufferScore(100), 40);
});

test('bufferScore: 1 bd early between 50 and 80', () => {
    const s = bufferScore(1);
    assert.ok(s > 50 && s < 80, `expected 50 < ${s} < 80`);
});

test('bufferScore: 7 bd early between 80 and 100', () => {
    const s = bufferScore(7);
    assert.ok(s > 80 && s < 100, `expected 80 < ${s} < 100`);
});
