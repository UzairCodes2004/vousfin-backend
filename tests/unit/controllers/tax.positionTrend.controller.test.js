'use strict';

jest.mock('../../../services/taxSnapshot.service', () => ({ getTrend: jest.fn() }));

const taxSnapshot = require('../../../services/taxSnapshot.service');
const taxCtrl     = require('../../../controllers/tax.controller');

beforeEach(() => jest.clearAllMocks());

describe('tax.controller.getPositionTrend', () => {
  it('returns the trend for the business, parsing the months query', async () => {
    const payload = { months: 6, from: '2026-01-01', points: [] };
    taxSnapshot.getTrend.mockResolvedValue(payload);

    const req  = { user: { businessId: 'biz1' }, query: { months: '6' } };
    const json = jest.fn();
    await taxCtrl.getPositionTrend(req, { json }, jest.fn());

    expect(taxSnapshot.getTrend).toHaveBeenCalledWith('biz1', 6);
    expect(json).toHaveBeenCalledWith({ success: true, data: payload });
  });

  it('defaults months to 6 when the query is absent', async () => {
    taxSnapshot.getTrend.mockResolvedValue({});
    const req = { user: { businessId: 'biz1' }, query: {} };
    await taxCtrl.getPositionTrend(req, { json: jest.fn() }, jest.fn());
    expect(taxSnapshot.getTrend).toHaveBeenCalledWith('biz1', 6);
  });

  it('forwards errors to the error handler', async () => {
    const err = new Error('boom');
    taxSnapshot.getTrend.mockRejectedValue(err);
    const next = jest.fn();
    await taxCtrl.getPositionTrend({ user: { businessId: 'b' }, query: {} }, { json: jest.fn() }, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
