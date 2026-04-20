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

// --- computeGrade tests with US academic scale ---
const { computeGrade } = require('../scoring');

function grade(score) {
    return computeGrade({ compositeScore: score, feasible: true, nsoViolations: [] }).grade;
}

test('computeGrade: 97 = A+', () => assert.equal(grade(97), 'A+'));
test('computeGrade: 96 = A', () => assert.equal(grade(96), 'A'));
test('computeGrade: 93 = A', () => assert.equal(grade(93), 'A'));
test('computeGrade: 92 = A-', () => assert.equal(grade(92), 'A-'));
test('computeGrade: 90 = A-', () => assert.equal(grade(90), 'A-'));
test('computeGrade: 89 = B+', () => assert.equal(grade(89), 'B+'));
test('computeGrade: 87 = B+', () => assert.equal(grade(87), 'B+'));
test('computeGrade: 86 = B', () => assert.equal(grade(86), 'B'));
test('computeGrade: 83 = B', () => assert.equal(grade(83), 'B'));
test('computeGrade: 82 = B-', () => assert.equal(grade(82), 'B-'));
test('computeGrade: 80 = B-', () => assert.equal(grade(80), 'B-'));
test('computeGrade: 79 = C+', () => assert.equal(grade(79), 'C+'));
test('computeGrade: 77 = C+', () => assert.equal(grade(77), 'C+'));
test('computeGrade: 76.4 = C', () => assert.equal(grade(76.4), 'C'));
test('computeGrade: 73 = C', () => assert.equal(grade(73), 'C'));
test('computeGrade: 72 = C-', () => assert.equal(grade(72), 'C-'));
test('computeGrade: 70 = C-', () => assert.equal(grade(70), 'C-'));
test('computeGrade: 69 = D', () => assert.equal(grade(69), 'D'));
test('computeGrade: 60 = D', () => assert.equal(grade(60), 'D'));
test('computeGrade: 59 = F', () => assert.equal(grade(59), 'F'));
test('computeGrade: 0 = F', () => assert.equal(grade(0), 'F'));

test('computeGrade: infeasible with 1 violation = D', () => {
    assert.equal(computeGrade({
        compositeScore: 80, feasible: false, nsoViolations: [{ store: 'X' }],
    }).grade, 'D');
});

test('computeGrade: infeasible with 3+ violations = F', () => {
    assert.equal(computeGrade({
        compositeScore: 80, feasible: false,
        nsoViolations: [{ store: 'X' }, { store: 'Y' }, { store: 'Z' }],
    }).grade, 'F');
});

// --- laborCostScore tests ---
const { laborCostScore } = require('../scoring');

test('laborCostScore: 0 OT = 18 pts', () => {
    assert.equal(laborCostScore(0), 18);
});

test('laborCostScore: 200h OT = 15 pts', () => {
    // 18 * (1 - 200/1200) = 18 * 5/6 = 15
    assert.equal(laborCostScore(200), 15);
});

test('laborCostScore: 600h OT = 9 pts', () => {
    // 18 * (1 - 600/1200) = 9
    assert.equal(laborCostScore(600), 9);
});

test('laborCostScore: 1200h OT = 0 pts', () => {
    assert.equal(laborCostScore(1200), 0);
});

test('laborCostScore: 1500h OT = 0 pts (floored)', () => {
    assert.equal(laborCostScore(1500), 0);
});

test('laborCostScore: negative OT input treated as 0', () => {
    assert.equal(laborCostScore(-50), 18);
});

// --- analyzeTeamHealth CNC exclusion tests ---
const { analyzeTeamHealth } = require('../scoring');

test('analyzeTeamHealth: CNC peak is excluded', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 200 }, { name: 'Paint', utilization: 50 }] },
    ];
    const teamWorkload = [
        { week: '2026-05-04', teams: [
            { name: 'CNC', workloadRatio: 400 },
            { name: 'Paint', workloadRatio: 400 },
        ] },
    ];
    const { peaks } = analyzeTeamHealth(teamUtilization, teamWorkload);
    const peakTeams = peaks.map(p => p.team);
    assert.ok(peakTeams.includes('Paint'), 'Paint peak kept');
    assert.ok(!peakTeams.includes('CNC'), 'CNC peak excluded');
});

test('analyzeTeamHealth: CNC valley is excluded', () => {
    const teamUtilization = [
        { week: '2026-05-04', teams: [{ name: 'CNC', utilization: 60 }] },
        { week: '2026-05-11', teams: [{ name: 'CNC', utilization: 20 }] },
        { week: '2026-05-18', teams: [{ name: 'CNC', utilization: 60 }] },
    ];
    const { valleys } = analyzeTeamHealth(teamUtilization, []);
    assert.equal(valleys.filter(v => v.team === 'CNC').length, 0, 'CNC valleys should be excluded');
});
