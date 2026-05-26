/**
 * Migration: backfill accountSubtype and accountCode on existing ChartOfAccount docs.
 *
 * Safe / additive: only sets the new fields when they're missing. Never
 * overwrites an existing subtype or code. Never deletes accounts.
 *
 * Strategy:
 *   1. Try exact-name match against the Gimbla DEFAULT_ACCOUNTS template
 *      → use that template's code + subtype.
 *   2. Try alias map (old default names → new equivalents) to gracefully
 *      migrate businesses that signed up under the previous 31-account list.
 *   3. Fall back to a sensible subtype based on accountType alone (no code).
 *
 * Run:  node migrations/backfill_account_subtypes_and_codes.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const { DEFAULT_ACCOUNTS } = require('../config/constants');

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI
  || 'mongodb://localhost:27017/vousfin';

/* ── Lookup: exact name → { code, subtype } from new template ──────────── */
const exactMap = Object.fromEntries(
  DEFAULT_ACCOUNTS.map((a) => [a.accountName.toLowerCase(), {
    code: a.accountCode,
    subtype: a.accountSubtype,
  }])
);

/* ── Alias map: old default-account names → new template equivalents ──── */
const aliasMap = {
  'cash':                  { code: '1020', subtype: 'Bank and Cash'            }, // → Cash on Hand
  'bank':                  { code: '1010', subtype: 'Bank and Cash'            }, // → Cash at Bank
  'petty cash':            { code: '1020', subtype: 'Bank and Cash'            },
  'inventory':             { code: null,   subtype: 'Current Assets'            },
  'prepaid expenses':      { code: null,   subtype: 'Current Assets'            },
  'fixed assets':          { code: null,   subtype: 'Non-current Assets'        },
  'loan payable':          { code: '2210', subtype: 'Non-current Liabilities'   }, // closest match
  'tax payable':           { code: '2120', subtype: 'Current Liabilities'       }, // → GST Payable
  'salaries payable':      { code: '2140', subtype: 'Current Liabilities'       }, // → Wages Payable
  'accrued expenses':      { code: null,   subtype: 'Current Liabilities'        },
  'unearned revenue':      { code: null,   subtype: 'Current Liabilities'        },
  'interest payable':      { code: null,   subtype: 'Current Liabilities'        },
  "owner's equity":        { code: '3110', subtype: 'Equity'                    },
  'owners equity':         { code: '3110', subtype: 'Equity'                    },
  'owner drawings':        { code: '3120', subtype: 'Equity'                    },
  'sales revenue':         { code: '4110', subtype: 'Revenue'                   },
  'service revenue':       { code: null,   subtype: 'Revenue'                    },
  'other income':          { code: '4120', subtype: 'Revenue'                   },
  'cost of goods sold':    { code: '5110', subtype: 'Direct Cost'               },
  'rent expense':          { code: '6110', subtype: 'Expenses'                  },
  'utilities expense':     { code: '6150', subtype: 'Expenses'                  },
  'salaries expense':      { code: '6180', subtype: 'Expenses'                  }, // → Wages and Salaries
  'marketing expense':     { code: '6160', subtype: 'Expenses'                  }, // → Advertising
  'interest expense':      { code: null,   subtype: 'Expenses'                   },
  'depreciation expense':  { code: null,   subtype: 'Expenses'                   },
  'bank charges':          { code: '6120', subtype: 'Expenses'                  }, // → Bank Fees
  'insurance expense':     { code: null,   subtype: 'Expenses'                   },
  'miscellaneous expense': { code: null,   subtype: 'Expenses'                   },
};

/* ── Fallback subtype based on accountType ─────────────────────────────── */
function fallbackSubtype(accountType, accountName) {
  if (accountType === 'Asset')     return 'Current Assets';
  if (accountType === 'Liability') return 'Current Liabilities';
  if (accountType === 'Equity')    return 'Equity';
  if (accountType === 'Revenue')   return 'Revenue';
  if (accountType === 'Expense') {
    if ((accountName || '').toLowerCase().includes('cost of goods')) return 'Direct Cost';
    return 'Expenses';
  }
  return null;
}

/* ── Resolve subtype + code for a given account ─────────────────────────── */
function resolveAccount(acc) {
  const key = (acc.accountName || '').trim().toLowerCase();
  const exact = exactMap[key];
  if (exact) return exact;
  const alias = aliasMap[key];
  if (alias) return alias;
  return { code: null, subtype: fallbackSubtype(acc.accountType, acc.accountName) };
}

async function migrate() {
  console.log(`[migration] Connecting to ${MONGO_URI.split('@').pop()}...`);
  await mongoose.connect(MONGO_URI);
  console.log('[migration] Connected.');

  const db = mongoose.connection.db;
  const accounts = db.collection('chartofaccounts');

  /* Only touch accounts where the new fields haven't been set yet */
  const cursor = accounts.find({
    $or: [
      { accountSubtype: { $exists: false } },
      { accountSubtype: null },
    ],
  });

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let codeSet = 0;

  while (await cursor.hasNext()) {
    const acc = await cursor.next();
    scanned += 1;

    const { code, subtype } = resolveAccount(acc);

    /* Build the $set payload — never overwrite existing values */
    const set = {};
    if (!acc.accountSubtype && subtype) set.accountSubtype = subtype;
    if (!acc.accountCode    && code)    { set.accountCode = code; codeSet += 1; }

    if (Object.keys(set).length === 0) {
      skipped += 1;
      continue;
    }

    try {
      await accounts.updateOne({ _id: acc._id }, { $set: set });
      updated += 1;
    } catch (err) {
      /* Possible cause: duplicate code on the partial unique index — skip silently */
      console.warn(`[migration] Could not update ${acc.accountName} (${acc._id}): ${err.message}`);
      skipped += 1;
    }
  }

  console.log(`[migration] Done. Scanned: ${scanned}, Updated: ${updated} (codes: ${codeSet}), Skipped: ${skipped}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('[migration] Failed:', err);
    process.exit(1);
  });
}

module.exports = { migrate, resolveAccount };
