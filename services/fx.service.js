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
    return (await this.getRateInfo(businessId, fromCurrency, toCurrency, asOfDate)).rate;
  }

  /**
   * Like getRate, but also reports whether a stored rate was actually found.
   * `found: false` means the caller may fall back to a user-supplied rate
   * instead of the safe default of 1.
   *
   * @returns {Promise<{ rate: number, found: boolean, rateDate: Date|null }>}
   */
  async getRateInfo(businessId, fromCurrency, toCurrency, asOfDate = new Date()) {
    const from = (fromCurrency || '').toUpperCase();
    const to   = (toCurrency   || '').toUpperCase();
    if (!from || !to || from === to) return { rate: 1, found: true, rateDate: null };

    const dateStr = new Date(asOfDate).toISOString().split('T')[0];
    const key     = this._key(String(businessId), from, to, dateStr);

    const cached = this._get(key);
    if (cached !== null) return { rate: cached, found: true, rateDate: null };

    // Direct rate — most recent on or before the transaction date (FX-at-date).
    const direct = await CurrencyRate.findOne({
      businessId,
      fromCurrency: from,
      toCurrency:   to,
      rateDate: { $lte: new Date(asOfDate) },
    }).sort({ rateDate: -1 }).lean();

    if (direct) {
      this._set(key, direct.rate);
      return { rate: direct.rate, found: true, rateDate: direct.rateDate };
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
      return { rate: r, found: true, rateDate: inverse.rateDate };
    }

    logger.warn(`[FX] No stored rate ${from}→${to} on ${dateStr} for business ${businessId}`);
    return { rate: 1, found: false, rateDate: null };
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
   * `amount` is always the FCY amount (e.g. 100 USD when currencyCode='USD').
   * If txnCurrency matches baseCurrency, rate=1 and baseCurrencyAmount=amount.
   *
   * Rate selection (locks the rate as of the transaction date — IAS 21):
   *   1. A stored CurrencyRate on/before txnDate → authoritative, date-locked.
   *   2. No stored rate, but the caller supplied a positive rate → honour it
   *      (so a manual foreign-currency entry is never silently flattened to 1).
   *   3. Otherwise → 1, with a warning.
   *
   * @param {number}      providedRate             optional caller-supplied rate (units of base per 1 FCY)
   * @param {number|null} callerBaseCurrencyAmount  if the caller already knows the base-currency
   *                                               equivalent (e.g. from a locked FX deal), pass it
   *                                               here. When provided and positive it takes precedence
   *                                               over the computed amount * rate, preventing
   *                                               double-conversion if the caller already converted.
   * @returns {{ currencyCode, exchangeRate, baseCurrencyAmount, rateSource }}
   */
  async prepareFxFields(amount, txnCurrency, businessId, txnDate, providedRate = null, callerBaseCurrencyAmount = null) {
    const base = await this.getBaseCurrency(businessId);
    const code = (txnCurrency || base).toUpperCase();
    if (code === base) {
      return { currencyCode: code, exchangeRate: 1, baseCurrencyAmount: this.round(amount, code), rateSource: 'base' };
    }
    const info = await this.getRateInfo(businessId, code, base, txnDate || new Date());
    let rate = info.rate;
    let rateSource = info.found ? 'stored' : 'default';
    if (!info.found && Number(providedRate) > 0) {
      rate = Number(providedRate);
      rateSource = 'provided';
    }
    // If the caller explicitly provided a positive base-currency amount, use it directly.
    // This avoids double-conversion when the caller pre-computed the equivalent
    // (e.g. the test passes pkrAmt that was already amount * rate).
    const callerBca = Number(callerBaseCurrencyAmount);
    const baseCurrencyAmount = (callerBca > 0 && Number.isFinite(callerBca))
      ? this.round(callerBca, base)
      : this.round(amount * rate, base);
    return {
      currencyCode:       code,
      exchangeRate:       rate,
      baseCurrencyAmount,
      rateSource,
    };
  }
}

module.exports = new FxService();
