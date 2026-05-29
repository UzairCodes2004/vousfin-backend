/**
 * tests/unit/services/ledgerPosting.service.test.js
 *
 * ERP Integration Refactor — Step 4.
 * Validates the shared balanced-journal poster: it creates the JournalEntry and
 * moves BOTH Chart-of-Accounts running balances with the correct debit/credit
 * sign (so the trial balance never drifts), and honours { updateBalances:false }.
 */
'use strict';

jest.mock('../../../models/JournalEntry.model', () => ({ create: jest.fn() }));
jest.mock('../../../repositories/account.repository', () => ({
  findById: jest.fn(),
  updateRunningBalance: jest.fn(),
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { postBalancedJournal, applyRunningBalance } = require('../../../services/ledgerPosting.service');
const JournalEntry = require('../../../models/JournalEntry.model');
const accountRepository = require('../../../repositories/account.repository');

const ID_DR = 'acc-debit-normal';   // e.g. Accounts Receivable / Inventory (Debit normal)
const ID_CR = 'acc-credit-normal';  // e.g. Accounts Payable / Sales        (Credit normal)

beforeEach(() => {
  jest.clearAllMocks();
  // Account normal-balance map.
  accountRepository.findById.mockImplementation((id) =>
    Promise.resolve({ _id: id, normalBalance: id === ID_DR ? 'Debit' : 'Credit' })
  );
  accountRepository.updateRunningBalance.mockResolvedValue(undefined);
  // create() echoes the payload back with an _id (mirrors Mongoose .create()).
  JournalEntry.create.mockImplementation((doc) => Promise.resolve({ _id: 'je-1', ...doc }));
});

describe('ledgerPosting.postBalancedJournal()', () => {
  it('creates the JE and increases both a debit-normal debit and a credit-normal credit', async () => {
    const je = await postBalancedJournal({
      businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR,
    });

    expect(JournalEntry.create).toHaveBeenCalledTimes(1);
    expect(je._id).toBe('je-1');

    // Debit side hits a Debit-normal account → +100
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_DR, 100);
    // Credit side hits a Credit-normal account → +100
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_CR, 100);
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledTimes(2);
  });

  it('decreases a credit-normal account when it is debited, and vice-versa', async () => {
    // DR the credit-normal account, CR the debit-normal account (a reversal-shaped entry).
    await postBalancedJournal({
      businessId: 'b1', amount: 40, debitAccountId: ID_CR, creditAccountId: ID_DR,
    });

    // Debit on a Credit-normal account → -40
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_CR, -40);
    // Credit on a Debit-normal account → -40
    expect(accountRepository.updateRunningBalance).toHaveBeenCalledWith(ID_DR, -40);
  });

  it('skips running-balance updates when updateBalances is false', async () => {
    await postBalancedJournal(
      { businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR },
      { updateBalances: false }
    );
    expect(JournalEntry.create).toHaveBeenCalledTimes(1);
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  it('never throws when a running-balance update fails — the JE is still returned', async () => {
    accountRepository.updateRunningBalance.mockRejectedValue(new Error('db down'));
    const je = await postBalancedJournal({
      businessId: 'b1', amount: 100, debitAccountId: ID_DR, creditAccountId: ID_CR,
    });
    expect(je._id).toBe('je-1'); // ledger write survived a balance-cache failure (Rule 3)
  });
});

describe('ledgerPosting.applyRunningBalance()', () => {
  it('is a no-op for a null account id', async () => {
    await applyRunningBalance(null, 100, 'debit');
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });

  it('logs and skips when the account is not found', async () => {
    accountRepository.findById.mockResolvedValue(null);
    await applyRunningBalance('missing', 100, 'debit');
    expect(accountRepository.updateRunningBalance).not.toHaveBeenCalled();
  });
});
