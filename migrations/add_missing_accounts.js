/**
 * Migration: add_missing_accounts.js
 *
 * Safely seeds the 8 new accounts added in Phase 1 (CoA Unification) to all
 * existing businesses. These accounts are required by the upgraded NLP parser
 * and journal generator:
 *
 *   1120  Prepaid Expenses         — Asset     / Current Assets
 *   1150  Inventory                — Asset     / Current Assets
 *   1250  Accumulated Depreciation — Asset     / Non-current Assets (contra)
 *   2125  WHT Payable              — Liability / Current Liabilities
 *   2170  Unearned Revenue         — Liability / Current Liabilities
 *   2230  Loan Payable             — Liability / Non-current Liabilities
 *   6230  Depreciation Expense     — Expense   / Expenses
 *   6240  Interest Expense         — Expense   / Expenses
 *
 * Safety guarantees:
 *   - Checks by accountCode AND accountName (case-insensitive) before inserting.
 *   - Never deletes or modifies existing accounts.
 *   - Idempotent: safe to run multiple times.
 *   - Each business is processed independently — a failure for one does not
 *     stop processing the others.
 *
 * Usage:
 *   node migrations/add_missing_accounts.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/vousfin';

// ── The 8 new accounts to seed ───────────────────────────────────────────────
const NEW_ACCOUNTS = [
  {
    accountCode:    '1120',
    accountName:    'Prepaid Expenses',
    accountType:    'Asset',
    accountSubtype: 'Current Assets',
    normalBalance:  'Debit',
    isDefault:      true,
    description:    'Expenses paid in advance (insurance, subscriptions)',
  },
  {
    accountCode:    '1150',
    accountName:    'Inventory',
    accountType:    'Asset',
    accountSubtype: 'Current Assets',
    normalBalance:  'Debit',
    isDefault:      true,
    description:    'Goods held for resale or raw materials',
  },
  {
    accountCode:    '1250',
    accountName:    'Accumulated Depreciation',
    accountType:    'Asset',
    accountSubtype: 'Non-current Assets',
    normalBalance:  'Credit',
    isDefault:      true,
    description:    'Contra-asset: cumulative depreciation on fixed assets',
  },
  {
    accountCode:    '2125',
    accountName:    'WHT Payable',
    accountType:    'Liability',
    accountSubtype: 'Current Liabilities',
    normalBalance:  'Credit',
    isDefault:      true,
    description:    'Withholding tax collected and payable to FBR/SRB',
  },
  {
    accountCode:    '2170',
    accountName:    'Unearned Revenue',
    accountType:    'Liability',
    accountSubtype: 'Current Liabilities',
    normalBalance:  'Credit',
    isDefault:      true,
    description:    'Advance payments received before service delivery',
  },
  {
    accountCode:    '2230',
    accountName:    'Loan Payable',
    accountType:    'Liability',
    accountSubtype: 'Non-current Liabilities',
    normalBalance:  'Credit',
    isDefault:      true,
    description:    'General-purpose long-term loans (bank, NBFC, informal)',
  },
  {
    accountCode:    '6230',
    accountName:    'Depreciation Expense',
    accountType:    'Expense',
    accountSubtype: 'Expenses',
    normalBalance:  'Debit',
    isDefault:      true,
    description:    'Periodic depreciation charge on fixed assets',
  },
  {
    accountCode:    '6240',
    accountName:    'Interest Expense',
    accountType:    'Expense',
    accountSubtype: 'Expenses',
    normalBalance:  'Debit',
    isDefault:      true,
    description:    'Interest on loans, credit facilities, and financing',
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check whether an account already exists for a given business.
 * Matches by accountCode (exact) OR accountName (case-insensitive).
 */
async function accountExists(collection, businessId, account) {
  const orConditions = [
    { accountName: { $regex: `^${escapeRegex(account.accountName)}$`, $options: 'i' } },
  ];
  if (account.accountCode) {
    orConditions.push({ accountCode: account.accountCode });
  }

  const existing = await collection.findOne({
    businessId,
    $or: orConditions,
  });
  return !!existing;
}

/** Escape special regex characters in a string */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Main migration ───────────────────────────────────────────────────────────

async function migrate() {
  console.log(`\n[add_missing_accounts] Connecting to MongoDB...`);
  await mongoose.connect(MONGO_URI);
  console.log('[add_missing_accounts] Connected.\n');

  const db = mongoose.connection.db;
  const accounts   = db.collection('chartofaccounts');
  const businesses = db.collection('businesses');

  // Fetch all business IDs
  const allBusinesses = await businesses.find({}, { projection: { _id: 1, businessName: 1 } }).toArray();
  console.log(`[add_missing_accounts] Found ${allBusinesses.length} business(es) to process.\n`);

  let totalInserted = 0;
  let totalSkipped  = 0;
  let totalErrors   = 0;

  for (const biz of allBusinesses) {
    const bizId   = biz._id;
    const bizName = biz.businessName || bizId.toString();

    try {
      const toInsert = [];

      for (const acct of NEW_ACCOUNTS) {
        const exists = await accountExists(accounts, bizId, acct);
        if (exists) {
          totalSkipped++;
        } else {
          toInsert.push({
            ...acct,
            businessId:  bizId,
            balance:     0,
            isActive:    true,
            createdAt:   new Date(),
            updatedAt:   new Date(),
          });
        }
      }

      if (toInsert.length > 0) {
        await accounts.insertMany(toInsert, { ordered: false });
        totalInserted += toInsert.length;
        const names = toInsert.map((a) => a.accountName).join(', ');
        console.log(`  ✓ [${bizName}] Inserted ${toInsert.length} account(s): ${names}`);
      } else {
        console.log(`  – [${bizName}] All 8 accounts already present, nothing to insert.`);
      }
    } catch (bizErr) {
      totalErrors++;
      console.error(`  ✗ [${bizName}] Error: ${bizErr.message}`);
    }
  }

  console.log('\n── Summary ──────────────────────────────────────────────────');
  console.log(`  Businesses processed : ${allBusinesses.length}`);
  console.log(`  Accounts inserted    : ${totalInserted}`);
  console.log(`  Accounts skipped     : ${totalSkipped} (already existed)`);
  console.log(`  Errors               : ${totalErrors}`);
  console.log('─────────────────────────────────────────────────────────────\n');

  await mongoose.disconnect();
  console.log('[add_missing_accounts] Done. Connection closed.');
}

migrate().catch((err) => {
  console.error('[add_missing_accounts] Fatal error:', err);
  process.exit(1);
});
