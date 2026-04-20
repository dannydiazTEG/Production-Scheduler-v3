const test = require('node:test');
const assert = require('node:assert/strict');
const { businessDaysEarly } = require('../scoring');

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
