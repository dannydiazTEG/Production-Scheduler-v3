/**
 * cache.js — Postgres-backed cache layer for the scheduling engine.
 *
 * Caches three things:
 *   1. Completed operations query results (short TTL, default 5 min)
 *   2. SKU prices (longer TTL, default 1 hour)
 *   3. Full run results keyed by inputHash (default 30 min)
 *
 * Design goals:
 *   - Zero ops setup: schema is auto-created via CREATE ... IF NOT EXISTS on
 *     the first call. Additive-only, safe to deploy repeatedly.
 *   - Graceful degradation: if pgPool is null or the DB is unreachable,
 *     every cache operation logs a warning and falls back to "no cache".
 *   - Scaffolding for future user/session features: run_results has a
 *     nullable user_id column so per-user history becomes additive later.
 *
 * Not a general-purpose cache. Tightly coupled to the scheduling endpoints.
 */

const crypto = require('crypto');

// --- TTLs (seconds) — tune in one place ---
const DEFAULTS = {
    completedOpsTtlSec: 5 * 60,
    inProgressOpsTtlSec: 5 * 60,  // shares lifecycle with completed ops
    skuPricesTtlSec: 60 * 60,
    runResultsTtlSec: 30 * 60,
};

// --- Schema DDL. Idempotent; safe to run on every startup. ---
const SCHEMA_DDL = [
    `CREATE SCHEMA IF NOT EXISTS sched_cache`,
    `CREATE TABLE IF NOT EXISTS sched_cache.completed_operations (
        snapshot_key    TEXT PRIMARY KEY,
        data            JSONB NOT NULL,
        in_progress     JSONB NOT NULL,
        row_count       INT NOT NULL,
        refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sched_cache.sku_prices (
        cache_key       TEXT PRIMARY KEY,
        data            JSONB NOT NULL,
        row_count       INT NOT NULL,
        refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sched_cache.run_results (
        input_hash      TEXT PRIMARY KEY,
        run_type        TEXT NOT NULL,
        user_id         TEXT,
        result          JSONB NOT NULL,
        score           NUMERIC,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS run_results_expires_idx ON sched_cache.run_results (expires_at)`,
    `CREATE INDEX IF NOT EXISTS run_results_user_created_idx ON sched_cache.run_results (user_id, created_at DESC) WHERE user_id IS NOT NULL`,
];

// sched_cache instead of cache — some pg clients treat "cache" as reserved-ish.
// Sticking to a project-specific namespace avoids collisions if anyone else
// adds a cache schema to the same database later.

let schemaReadyPromise = null;   // memoized so concurrent callers share work
let schemaReadyState = 'pending'; // 'pending' | 'ready' | 'failed'
let disabledReason = null;       // human-readable when cache is unavailable

/**
 * Ensure schema exists. Called lazily from each public API so the module
 * has no startup-order requirement. Idempotent; memoized.
 */
async function ensureSchema(pgPool) {
    if (!pgPool) {
        disabledReason = 'DATABASE_URL not configured';
        schemaReadyState = 'failed';
        return false;
    }
    if (schemaReadyPromise) return schemaReadyPromise;
    schemaReadyPromise = (async () => {
        try {
            for (const stmt of SCHEMA_DDL) {
                await pgPool.query(stmt);
            }
            schemaReadyState = 'ready';
            console.log('[cache] sched_cache schema ready');
            return true;
        } catch (err) {
            disabledReason = `schema init failed: ${err.message}`;
            schemaReadyState = 'failed';
            console.warn(`[cache] disabled — ${disabledReason}`);
            return false;
        }
    })();
    return schemaReadyPromise;
}

/**
 * Canonical JSON — stable key ordering and stable primitive representation
 * so the same logical input always hashes to the same string.
 */
function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    const keys = Object.keys(value).sort();
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function computeInputHash(inputs) {
    const h = crypto.createHash('sha256');
    h.update(canonicalize(inputs));
    return h.digest('hex');
}

/**
 * Build a cache snapshot key from a sorted project-name list. Snapshots are
 * partitioned per project list so a run for { P1, P2 } doesn't leak into a
 * run for { P1, P2, P3 }.
 */
function completedOpsKey(projectNames) {
    const sorted = [...new Set(projectNames)].sort();
    const h = crypto.createHash('sha256');
    h.update(sorted.join('\x00'));
    return h.digest('hex').slice(0, 32);
}

// ======================================================================
// Completed operations (and in-progress ops, which share lifecycle)
// ======================================================================

/**
 * Look up a cached completed-ops snapshot. Returns null on miss, disabled,
 * or expired.
 */
async function getCompletedOps(pgPool, projectNames, { timings } = {}) {
    if (!(await ensureSchema(pgPool))) return null;
    const key = completedOpsKey(projectNames);
    try {
        timings?.mark('cache.completedOpsLookup.start');
        const res = await pgPool.query(
            `SELECT data, in_progress, row_count, refreshed_at
             FROM sched_cache.completed_operations
             WHERE snapshot_key = $1 AND expires_at > NOW()`,
            [key]
        );
        timings?.mark('cache.completedOpsLookup.end');
        if (res.rows.length === 0) return null;
        const row = res.rows[0];
        return {
            completedRows: row.data,
            inProgressRows: row.in_progress,
            rowCount: row.row_count,
            refreshedAt: row.refreshed_at,
        };
    } catch (err) {
        console.warn(`[cache] getCompletedOps failed: ${err.message}`);
        return null;
    }
}

async function setCompletedOps(pgPool, projectNames, completedRows, inProgressRows, ttlSec = DEFAULTS.completedOpsTtlSec) {
    if (!(await ensureSchema(pgPool))) return;
    const key = completedOpsKey(projectNames);
    try {
        await pgPool.query(
            `INSERT INTO sched_cache.completed_operations
                 (snapshot_key, data, in_progress, row_count, refreshed_at, expires_at)
             VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW(), NOW() + ($5 || ' seconds')::INTERVAL)
             ON CONFLICT (snapshot_key) DO UPDATE SET
                 data = EXCLUDED.data,
                 in_progress = EXCLUDED.in_progress,
                 row_count = EXCLUDED.row_count,
                 refreshed_at = EXCLUDED.refreshed_at,
                 expires_at = EXCLUDED.expires_at`,
            [key, JSON.stringify(completedRows), JSON.stringify(inProgressRows), completedRows.length, String(ttlSec)]
        );
    } catch (err) {
        console.warn(`[cache] setCompletedOps failed: ${err.message}`);
    }
}

// ======================================================================
// SKU prices (single global snapshot — prices aren't per-project-scoped)
// ======================================================================

const SKU_PRICES_KEY = 'global';

async function getSkuPrices(pgPool, { timings } = {}) {
    if (!(await ensureSchema(pgPool))) return null;
    try {
        timings?.mark('cache.skuPricesLookup.start');
        const res = await pgPool.query(
            `SELECT data, row_count, refreshed_at
             FROM sched_cache.sku_prices
             WHERE cache_key = $1 AND expires_at > NOW()`,
            [SKU_PRICES_KEY]
        );
        timings?.mark('cache.skuPricesLookup.end');
        if (res.rows.length === 0) return null;
        // data is an array of [name, price] tuples; rebuild the Map at the edge.
        const priceMap = new Map(res.rows[0].data);
        return { priceMap, rowCount: res.rows[0].row_count, refreshedAt: res.rows[0].refreshed_at };
    } catch (err) {
        console.warn(`[cache] getSkuPrices failed: ${err.message}`);
        return null;
    }
}

async function setSkuPrices(pgPool, priceMap, ttlSec = DEFAULTS.skuPricesTtlSec) {
    if (!(await ensureSchema(pgPool))) return;
    try {
        const data = Array.from(priceMap.entries());
        await pgPool.query(
            `INSERT INTO sched_cache.sku_prices (cache_key, data, row_count, refreshed_at, expires_at)
             VALUES ($1, $2::jsonb, $3, NOW(), NOW() + ($4 || ' seconds')::INTERVAL)
             ON CONFLICT (cache_key) DO UPDATE SET
                 data = EXCLUDED.data,
                 row_count = EXCLUDED.row_count,
                 refreshed_at = EXCLUDED.refreshed_at,
                 expires_at = EXCLUDED.expires_at`,
            [SKU_PRICES_KEY, JSON.stringify(data), data.length, String(ttlSec)]
        );
    } catch (err) {
        console.warn(`[cache] setSkuPrices failed: ${err.message}`);
    }
}

// ======================================================================
// Full run result cache
// ======================================================================

async function findRunResult(pgPool, inputHash, { timings } = {}) {
    if (!(await ensureSchema(pgPool))) return null;
    try {
        timings?.mark('cache.runResultLookup.start');
        const res = await pgPool.query(
            `SELECT result, score, created_at
             FROM sched_cache.run_results
             WHERE input_hash = $1 AND expires_at > NOW()`,
            [inputHash]
        );
        timings?.mark('cache.runResultLookup.end');
        if (res.rows.length === 0) return null;
        return { result: res.rows[0].result, score: res.rows[0].score, createdAt: res.rows[0].created_at };
    } catch (err) {
        console.warn(`[cache] findRunResult failed: ${err.message}`);
        return null;
    }
}

async function saveRunResult(pgPool, inputHash, result, { runType = 'schedule', userId = null, score = null, ttlSec = DEFAULTS.runResultsTtlSec } = {}) {
    if (!(await ensureSchema(pgPool))) return;
    try {
        await pgPool.query(
            `INSERT INTO sched_cache.run_results
                 (input_hash, run_type, user_id, result, score, created_at, expires_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW() + ($6 || ' seconds')::INTERVAL)
             ON CONFLICT (input_hash) DO UPDATE SET
                 run_type = EXCLUDED.run_type,
                 user_id = EXCLUDED.user_id,
                 result = EXCLUDED.result,
                 score = EXCLUDED.score,
                 created_at = EXCLUDED.created_at,
                 expires_at = EXCLUDED.expires_at`,
            [inputHash, runType, userId, JSON.stringify(result), score, String(ttlSec)]
        );
    } catch (err) {
        console.warn(`[cache] saveRunResult failed: ${err.message}`);
    }
}

// ======================================================================
// Admin helpers
// ======================================================================

/**
 * Invalidate some or all cache entries. `scope` accepts:
 *   'all' | 'completed_ops' | 'sku_prices' | 'run_results'
 */
async function invalidate(pgPool, scope = 'all') {
    if (!(await ensureSchema(pgPool))) return { invalidated: 0, disabled: disabledReason };
    const tables = {
        completed_ops: 'sched_cache.completed_operations',
        sku_prices: 'sched_cache.sku_prices',
        run_results: 'sched_cache.run_results',
    };
    const targets = scope === 'all' ? Object.values(tables) : [tables[scope]].filter(Boolean);
    let invalidated = 0;
    for (const t of targets) {
        try {
            const r = await pgPool.query(`DELETE FROM ${t}`);
            invalidated += r.rowCount || 0;
        } catch (err) {
            console.warn(`[cache] invalidate ${t} failed: ${err.message}`);
        }
    }
    return { invalidated, scope };
}

/**
 * Cleanup expired rows — called opportunistically, not on a timer. Postgres
 * doesn't auto-evict; without this, rows accumulate (not a correctness
 * problem, just storage).
 */
async function gc(pgPool) {
    if (!(await ensureSchema(pgPool))) return { removed: 0 };
    let removed = 0;
    for (const t of ['sched_cache.completed_operations', 'sched_cache.sku_prices', 'sched_cache.run_results']) {
        try {
            const r = await pgPool.query(`DELETE FROM ${t} WHERE expires_at <= NOW()`);
            removed += r.rowCount || 0;
        } catch (err) {
            console.warn(`[cache] gc ${t} failed: ${err.message}`);
        }
    }
    return { removed };
}

async function stats(pgPool) {
    const out = { state: schemaReadyState, disabledReason, tables: {} };
    if (!(await ensureSchema(pgPool))) return out;
    for (const [label, t] of Object.entries({
        completed_ops: 'sched_cache.completed_operations',
        sku_prices: 'sched_cache.sku_prices',
        run_results: 'sched_cache.run_results',
    })) {
        try {
            const r = await pgPool.query(
                `SELECT COUNT(*)::int AS total,
                        COUNT(*) FILTER (WHERE expires_at > NOW())::int AS live,
                        MIN(refreshed_at) AS oldest, MAX(refreshed_at) AS newest
                 FROM ${t}`
            );
            out.tables[label] = r.rows[0];
        } catch (err) {
            out.tables[label] = { error: err.message };
        }
    }
    return out;
}

module.exports = {
    DEFAULTS,
    ensureSchema,
    computeInputHash,
    canonicalize,
    completedOpsKey,
    getCompletedOps,
    setCompletedOps,
    getSkuPrices,
    setSkuPrices,
    findRunResult,
    saveRunResult,
    invalidate,
    gc,
    stats,
};
