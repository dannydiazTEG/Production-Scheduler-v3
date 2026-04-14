/**
 * timings.js — Lightweight per-phase timer for scheduling runs.
 *
 * Goal: answer "where does a schedule run spend its time?" with near-zero overhead.
 * Meant to be created once per run, passed through the call chain, and attached
 * to the job record for later inspection via /api/diagnostics/last-run.
 *
 * Usage:
 *   const t = createTimings();
 *   t.mark('dbCompletedOps.start');
 *   ... query ...
 *   t.mark('dbCompletedOps.end');                // span auto-computed
 *
 *   // Hot-path cumulative counters (no object allocation per call):
 *   t.inc('isReady', perCallMs);
 *   t.bump('isReady.calls');
 *
 *   // Scoped wrapper for async/sync work:
 *   const rows = await t.time('dbCompletedOps', () => pool.query(...));
 *
 *   t.report();  // returns a stable JSON-friendly object
 *
 * Design notes:
 *   - performance.now() is used for sub-millisecond precision.
 *   - Cumulative counters use a Map<string, number> — O(1) increments.
 *   - Nothing is logged or written automatically; the caller owns disposition.
 *   - Safe to call in any order; missing .end() leaves the span open and is
 *     surfaced in report() as { open: true }.
 */

const { performance } = require('perf_hooks');

function createTimings() {
    const runStart = performance.now();
    const spans = new Map();        // name -> { start, end?, ms? }
    const cumulative = new Map();   // name -> ms total
    const counters = new Map();     // name -> integer count
    const notes = [];               // free-form observations

    const now = () => performance.now();

    return {
        /**
         * Mark a point in time. `key` should look like 'phaseName.start' or
         * 'phaseName.end'. When both ends exist, the span duration is computed.
         */
        mark(key) {
            // Split on the LAST dot so names like "engine.total.start" parse to
            // name="engine.total", phase="start".
            const dot = key.lastIndexOf('.');
            const name = dot > 0 ? key.slice(0, dot) : '';
            const phase = dot > 0 ? key.slice(dot + 1) : '';
            if (!name || !phase) {
                throw new Error(`timings.mark: key must be "name.start" or "name.end", got "${key}"`);
            }
            const existing = spans.get(name) || {};
            if (phase === 'start') {
                existing.start = now();
            } else if (phase === 'end') {
                existing.end = now();
                if (existing.start != null) {
                    existing.ms = existing.end - existing.start;
                }
            } else {
                throw new Error(`timings.mark: unknown phase "${phase}"`);
            }
            spans.set(name, existing);
        },

        /** Wrap any function (sync or async) with start/end marks. */
        async time(name, fn) {
            this.mark(`${name}.start`);
            try {
                return await fn();
            } finally {
                this.mark(`${name}.end`);
            }
        },

        /** Add milliseconds to a cumulative counter (hot-path friendly). */
        inc(name, ms) {
            cumulative.set(name, (cumulative.get(name) || 0) + ms);
        },

        /** Increment an integer counter (e.g. call counts). */
        bump(name, by = 1) {
            counters.set(name, (counters.get(name) || 0) + by);
        },

        /** Record a free-form note (task count, day count, etc.). */
        note(key, value) {
            notes.push({ key, value });
        },

        /** Current total wall-clock since this timings instance was created. */
        totalMs() {
            return now() - runStart;
        },

        /**
         * Stable JSON-friendly snapshot. Rounded to 2 decimal ms for readability.
         * Spans missing an end are reported with { open: true }.
         */
        report() {
            const round = (n) => (n == null ? null : Math.round(n * 100) / 100);

            const spansOut = {};
            for (const [name, s] of spans) {
                spansOut[name] = s.end == null
                    ? { open: true, startedAt: round(s.start - runStart) }
                    : { ms: round(s.ms), startedAt: round(s.start - runStart) };
            }

            const cumulativeOut = {};
            for (const [name, ms] of cumulative) cumulativeOut[name] = round(ms);

            const countersOut = {};
            for (const [name, c] of counters) countersOut[name] = c;

            const spansTotal = Array.from(spans.values())
                .filter(s => s.ms != null)
                .reduce((sum, s) => sum + s.ms, 0);

            return {
                totalMs: round(this.totalMs()),
                spans: spansOut,
                cumulativeMs: cumulativeOut,
                counters: countersOut,
                notes,
                // Sum of (non-overlapping) top-level spans — useful for the
                // "timings sum to within 5% of total" verification check.
                spansSumMs: round(spansTotal),
            };
        },
    };
}

/**
 * No-op instance used when a caller doesn't want or need timing.
 * Keeps call sites uniform without sprinkling null-checks.
 */
const NOOP_TIMINGS = {
    mark() {},
    time(_, fn) { return fn(); },
    inc() {},
    bump() {},
    note() {},
    totalMs() { return 0; },
    report() { return null; },
};

module.exports = { createTimings, NOOP_TIMINGS };
