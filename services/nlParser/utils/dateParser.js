/**
 * @module dateParser
 * @description Parses relative and natural date expressions into ISO-8601 format.
 * Handles expressions like "today", "yesterday", "last Friday", "2 days ago", etc.
 *
 * BUG FIX: Added plausibility guard on the Date.parse() fallback.
 * Dates more than 15 years in the past or 2 years in the future are implausible
 * for SME accounting — they indicate the AI hallucinated or misread a number.
 * Those are now rejected (returned as null) instead of being silently accepted
 * with confidence 0.7 which previously bypassed the requiresReview flag.
 *
 * Additionally, explicit ISO dates (YYYY-MM-DD) older than 10 years receive a
 * reduced confidence of 0.35 (below the 0.6 review threshold) so the user is
 * forced to verify before submitting.
 */

/**
 * Day-of-week mapping (case-insensitive match).
 */
const DAYS_OF_WEEK = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

/**
 * Normalize a date expression to ISO-8601 (YYYY-MM-DD).
 * @param {string} dateStr - Raw date string from AI extraction.
 * @param {Date} [referenceDate] - Reference date for relative calculations (defaults to now).
 * @returns {{ date: string|null, confidence: number }}
 */
function parseDate(dateStr, referenceDate = new Date()) {
  if (!dateStr || typeof dateStr !== 'string') {
    return { date: null, confidence: 0 };
  }

  const input = dateStr.trim().toLowerCase();
  const currentYear = new Date().getFullYear();

  // Already ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const year = parseInt(input.slice(0, 4), 10);
    const ageYears = currentYear - year;
    // Dates more than 10 years old are suspicious in SME accounting context —
    // lower confidence below the 0.6 requiresReview threshold so the user
    // must verify before confirming. Still return the date so they can edit it.
    if (ageYears > 10 || year > currentYear + 2) {
      return { date: input, confidence: 0.35 };
    }
    return { date: input, confidence: 1.0 };
  }

  // Common date formats: DD/MM/YYYY, MM/DD/YYYY, DD-MM-YYYY
  const slashDate = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashDate) {
    const [, a, b, year] = slashDate;
    // Assume DD/MM/YYYY for Pakistan locale
    const day = parseInt(a, 10);
    const month = parseInt(b, 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(parseInt(year, 10), month - 1, day);
      return { date: formatISO(d), confidence: 0.9 };
    }
  }

  const ref = new Date(referenceDate);

  // "today"
  if (input === 'today' || input === 'aaj' || input === 'this morning' || input === 'this evening') {
    return { date: formatISO(ref), confidence: 0.98 };
  }

  // "yesterday" / "kal" (past context)
  if (input === 'yesterday' || input === 'kal') {
    ref.setDate(ref.getDate() - 1);
    return { date: formatISO(ref), confidence: 0.97 };
  }

  // "tomorrow"
  if (input === 'tomorrow') {
    ref.setDate(ref.getDate() + 1);
    return { date: formatISO(ref), confidence: 0.95 };
  }

  // "N days/weeks/months ago"
  const agoMatch = input.match(/^(\d+)\s+(day|days|week|weeks|month|months)\s+ago$/);
  if (agoMatch) {
    const num = parseInt(agoMatch[1], 10);
    const unit = agoMatch[2];
    if (unit.startsWith('day')) {
      ref.setDate(ref.getDate() - num);
    } else if (unit.startsWith('week')) {
      ref.setDate(ref.getDate() - num * 7);
    } else if (unit.startsWith('month')) {
      ref.setMonth(ref.getMonth() - num);
    }
    return { date: formatISO(ref), confidence: 0.92 };
  }

  // "last week" / "this week"
  if (input === 'last week') {
    ref.setDate(ref.getDate() - 7);
    return { date: formatISO(ref), confidence: 0.8 };
  }
  if (input === 'this week') {
    return { date: formatISO(ref), confidence: 0.75 };
  }

  // "last month"
  if (input === 'last month') {
    ref.setMonth(ref.getMonth() - 1);
    return { date: formatISO(ref), confidence: 0.75 };
  }

  // "last <dayOfWeek>" e.g. "last friday"
  const lastDayMatch = input.match(/^last\s+(\w+)$/);
  if (lastDayMatch) {
    const targetDay = DAYS_OF_WEEK[lastDayMatch[1]];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let diff = currentDay - targetDay;
      if (diff <= 0) diff += 7;
      ref.setDate(ref.getDate() - diff);
      return { date: formatISO(ref), confidence: 0.9 };
    }
  }

  // "this <dayOfWeek>"
  const thisDayMatch = input.match(/^this\s+(\w+)$/);
  if (thisDayMatch) {
    const targetDay = DAYS_OF_WEEK[thisDayMatch[1]];
    if (targetDay !== undefined) {
      const currentDay = ref.getDay();
      let diff = targetDay - currentDay;
      if (diff < 0) diff += 7;
      ref.setDate(ref.getDate() + diff);
      return { date: formatISO(ref), confidence: 0.85 };
    }
  }

  // Try native Date.parse as last-resort fallback.
  // BUG FIX: Date.parse() is locale-dependent and can accept ambiguous strings
  // (e.g. "5/4") and map them to implausible years (the year 2001, Unix epoch
  // era, etc.).  Reject any fallback result that is more than 15 years old or
  // more than 2 years in the future — these are almost certainly parsing errors
  // rather than intentional historic dates in an SME accounting context.
  const parsed = Date.parse(dateStr);
  if (!isNaN(parsed)) {
    const d = new Date(parsed);
    const ageYears = currentYear - d.getFullYear();
    if (ageYears > 15 || d.getFullYear() > currentYear + 2) {
      // Date is implausible — return null so the caller defaults to today
      return { date: null, confidence: 0 };
    }
    return { date: formatISO(d), confidence: 0.7 };
  }

  return { date: null, confidence: 0 };
}

/**
 * Format a Date object into ISO-8601 date string (YYYY-MM-DD).
 */
function formatISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { parseDate, formatISO };
