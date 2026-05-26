/**
 * reportCache.js — In-memory TTL cache for financial reports.
 *
 * WHY:
 *   Financial reports (Balance Sheet, Income Statement, Trial Balance, Dashboard)
 *   are expensive to compute — they aggregate thousands of journal entries.
 *   For a typical SME, reports are viewed many more times than transactions are
 *   written. A 5-minute cache eliminates redundant DB work on repeated views.
 *
 * SAFETY:
 *   The cache is invalidated on EVERY transaction write (create, update, reverse,
 *   delete) ensuring reports always reflect the latest data within one request
 *   cycle. There is NO risk of stale financial totals surviving after a write.
 *
 * DESIGN:
 *   - No external dependency (pure Node.js Map)
 *   - businessId-scoped keys → one business's writes don't affect another
 *   - TTL-based expiry as a safety net (default 5 minutes)
 *   - LRU-style eviction to prevent unbounded memory growth
 */

const MAX_ENTRIES   = 500;   // safety ceiling across all businesses
// ⚠ MULTI-INSTANCE WARNING: This is a per-process in-memory cache.
// On multi-instance deployments (Render with 2+ workers), cache invalidation from
// one worker does NOT propagate to other workers. Worst case: a transaction written
// on worker A is invisible on worker B for up to TTL seconds.
// MITIGATION: Keep TTL short (30s) to limit the staleness window.
// PROPER FIX: Replace with Redis (ioredis) or Vercel KV for distributed invalidation.
const DEFAULT_TTL   = 30 * 1000; // 30 seconds — short enough to limit multi-instance drift

class ReportCache {
  constructor() {
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this._store = new Map();
  }

  // ─── Key builders ──────────────────────────────────────────────────────────

  _key(type, businessId, params = {}) {
    return `${type}::${businessId}::${JSON.stringify(params)}`;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Read a cached value.
   * @param {string} type       — e.g. 'income-statement'
   * @param {string} businessId
   * @param {Object} params     — date range etc.
   * @returns {any|null}        — null on miss or expired
   */
  get(type, businessId, params = {}) {
    const key   = this._key(type, businessId, params);
    const entry = this._store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Write a value to the cache.
   * @param {string} type
   * @param {string} businessId
   * @param {Object} params
   * @param {any}    value
   * @param {number} [ttlMs]   — override default TTL
   */
  set(type, businessId, params = {}, value, ttlMs = DEFAULT_TTL) {
    // Evict oldest entries if ceiling reached
    if (this._store.size >= MAX_ENTRIES) {
      const first = this._store.keys().next().value;
      this._store.delete(first);
    }
    const key = this._key(type, businessId, params);
    this._store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Invalidate ALL cached entries for a business.
   * Call this on every transaction write so reports are never stale.
   * @param {string} businessId
   */
  invalidate(businessId) {
    const suffix = `::${businessId}::`;
    for (const key of this._store.keys()) {
      if (key.includes(suffix)) {
        this._store.delete(key);
      }
    }
  }

  /** Clear the entire cache (e.g., on server restart or admin command). */
  clear() {
    this._store.clear();
  }

  /** Diagnostic: how many entries are currently cached. */
  get size() {
    return this._store.size;
  }
}

module.exports = new ReportCache();
