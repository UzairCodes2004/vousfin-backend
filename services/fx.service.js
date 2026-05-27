// services/fx.service.js
// Centralised FX conversion service (IAS 21 compliant).
// Looks up CurrencyRate records stored per-business and converts amounts.
// In-memory cache (1h TTL) prevents repeated DB hits per request.
const CurrencyRate = require('../models/CurrencyRate.model');
const Business     = require('../models/Business.model');
const logger       = require('../config/logger');

// ISO 4217 non-standard decimal places
const ZERO_DECIMAL  = new Set(['JPY','KRW','VND','IDR','TWD','BIF','CLP','GNF','MGA','PYG','RWF','UGX','XAF','XOF','XPF']);
const THREE_DECIMAL = new Set(['KWD','BHD','OMR','JOD','TND','IQD','LYD']);

// Simple in-process cache: cacheKey → { rate, expiresAt }
const _cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

class FxService {
  // ── Rounding ────────────────────────────────────────────────────────────────

  /** Number of decimal places for a given ISO 4217 currency code. */
  decimals(currency = 'PKR') {
    const c = currency.toUpperCase();
    if (ZERO_DECIMAL.has(c))  return 0;
    if (THREE_DECIMAL.has(c)) return 3;
    return 2;
  }

  /** Round an amount to the correct decimal precision for the target currency. */
  round(amount, currency = 'PKR') {
    const dp = this.decimals(currency);
    const f  = Math.pow(10, dp);
    return Math.round(amount * f) / f;
  }

  // ── Cache helpers ────────────────────────────────────────────────────────────

  _key(businessId, from, to, dateStr) {
    return `${businessId}|${from}|${to}|${dateStr}`;
  }

  _get(key) {
    const e = _cache.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { _cache.delete(key); return null; }
    return e.rate;
  }

  _set(key, rate) {
    _cache.set(key, { rate, expiresAt: Date.now() + CACHE_TTL });
  }

  /** Invalidate all cached rates for a business (call after upsert/delete). */
  invalidate(businessId) {
    const prefix = String(businessId);
    for (const k of _cache.keys()) {
      if (k.startsWith(prefix + '|')) _cache.delete(k);
    }
  }

  // ── Core rate lookup ─────────────────────────────────────────────────────────

  /**
   * Get exchange rate: fromCurrency → toCurrency, valid on or before asOfDate.
   *
   * Strategy:
   *   1. Same currency → 1
   *   2. Direct rate lookup in CurrencyRate collection
   *   3. Reverse lookup (1 / inverse rate)
   *   4. Graceful fallback → 1 (logs a warning; existing transactions stay valid)
   *
   * @param {string|ObjectId} businessId
   * @param {string}          fromCurrency  e.g. 'USD'
   * @param {string}          toCurrency    e.g. 'PKR'
   * @param {Date|string}     [asOfDate]    defaults to today
   * @returns {Promise<number>}
   */
  async getRate(businessId, fromCurrency, toCurrency, asOfDate = new Date()) {
    const from = (fromCurrency || '').toUpperCase();
    const to   = (toCurrency   || '').toUpperCase();
    if (!from || !to || from === to) return 1;

    const dateStr = new Date(asOfDate).toISOString().split('T')[0];
    const key     = this._key(String(businessId), from, to, dateStr);

    const cached = this._get(key);
    if (cached !== null) return cached;

    // Direct rate
    const direct = await CurrencyRate.findOne({
      businessId,
      fromCurrency: from,
      toCurrency:   to,
      rateDate: { $lte: new Date(asOfDate) },
    }).sort({ rateDate: -1 }).lean();

    if (direct) {
      this._set(key, direct.rate);
      return direct.rate;
    }

    // Inverse rate
    const inverse = await CurrencyRate.findOne({
      businessId,
      fromCurrency: to,
      toCurrency:   from,
      rateDate: { $lte: new Date(asOfDate) },
    }).sort({ rateDate: -1 }).lean();

    if (inverse) {
      const r = this.round(1 / inverse.rate, from);
      this._set(key, r);
      return r;
    }

    logger.warn(`[FX] No rate ${from}→${to} on ${dateStr} for business ${businessId} — defaulting to 1`);
    return 1;
  }

  /**
   * Convert amount from one currency to another.
   */
  async convert(amount, fromCurrency, toCurrency, asOfDate, businessId) {
    const rate = await this.getRate(businessId, fromCurrency, toCurrency, asOfDate);
    return this.round(amount * rate, toCurrency);
  }

  /**
   * Return the base (functional) currency for a business.
   */
  async getBaseCurrency(businessId) {
    const biz = await Business.findById(businessId).select('currency').lean();
    return biz?.currency || 'PKR';
  }

  /**
   * Return the reporting currency for a business (falls back to base currency).
   */
  async getReportingCurrency(businessId) {
    const biz = await Business.findById(businessId).select('currency reportingCurrency').lean();
    return biz?.reportingCurrency || biz?.currency || 'PKR';
  }

  // ── Convenience: prepare FX fields for a transaction ────────────────────────

  /**
   * Given a transaction amount + currency, return the FX fields to persist.
   * If txnCurrency matches baseCurrency, rate=1 and baseCurrencyAmount=amount.
   *
   * @returns {{ currencyCode, exchangeRate, baseCurrencyAmount }}
   */
  async prepareFxFields(amount, txnCurrency, businessId, txnDate) {
    const base = await this.getBaseCurrency(businessId);
    const code = (txnCurrency || base).toUpperCase();
    if (code === base) {
      return { currencyCode: code, exchangeRate: 1, baseCurrencyAmount: this.round(amount, code) };
    }
    const rate = await this.getRate(businessId, code, base, txnDate || new Date());
    return {
      currencyCode:       code,
      exchangeRate:       rate,
      baseCurrencyAmount: this.round(amount * rate, base),
    };
  }
}

module.exports = new FxService();
