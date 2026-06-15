'use strict';

const TaxReturn = require('../../../models/TaxReturn.model');

describe('TaxReturn.canTransition (state machine)', () => {
  it('allows the happy path draft → validated → submitted → filed', () => {
    expect(TaxReturn.canTransition('draft', 'validated')).toBe(true);
    expect(TaxReturn.canTransition('validated', 'submitted')).toBe(true);
    expect(TaxReturn.canTransition('submitted', 'filed')).toBe(true);
  });

  it('allows re-editing (validated → draft) and rejection recovery (rejected → draft)', () => {
    expect(TaxReturn.canTransition('validated', 'draft')).toBe(true);
    expect(TaxReturn.canTransition('rejected', 'draft')).toBe(true);
  });

  it('treats filed as terminal', () => {
    expect(TaxReturn.canTransition('filed', 'submitted')).toBe(false);
    expect(TaxReturn.canTransition('filed', 'draft')).toBe(false);
  });

  it('rejects illegal jumps', () => {
    expect(TaxReturn.canTransition('draft', 'submitted')).toBe(false);
    expect(TaxReturn.canTransition('draft', 'filed')).toBe(false);
    expect(TaxReturn.canTransition('submitted', 'draft')).toBe(false);
  });

  it('treats a no-op transition as allowed', () => {
    expect(TaxReturn.canTransition('draft', 'draft')).toBe(true);
  });
});
