import { describe, expect, it } from 'vitest';
import { businessTypeSchema, companyUpdateSchema } from './company.js';

describe('businessTypeSchema', () => {
  it('accepts each of the five enum values', () => {
    for (const v of ['sole_prop', 'llc_single_member', 'partnership', 's_corp', 'c_corp']) {
      expect(businessTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it('rejects unknown values', () => {
    expect(businessTypeSchema.safeParse('soleprop').success).toBe(false);
    expect(businessTypeSchema.safeParse('').success).toBe(false);
    expect(businessTypeSchema.safeParse(null).success).toBe(false);
  });
});

describe('companyUpdateSchema', () => {
  it('accepts name only', () => {
    expect(companyUpdateSchema.safeParse({ name: 'New name' }).success).toBe(true);
  });

  it('accepts businessType only', () => {
    expect(companyUpdateSchema.safeParse({ businessType: 's_corp' }).success).toBe(true);
  });

  it('accepts both', () => {
    expect(companyUpdateSchema.safeParse({ name: 'Co', businessType: 'sole_prop' }).success).toBe(
      true,
    );
  });

  it('rejects empty object (at_least_one_field_required)', () => {
    const r = companyUpdateSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('rejects empty-string name', () => {
    expect(companyUpdateSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects unknown businessType', () => {
    expect(companyUpdateSchema.safeParse({ businessType: 'partnership_general' }).success).toBe(
      false,
    );
  });

  it('accepts a valid replyToEmail', () => {
    const r = companyUpdateSchema.safeParse({ replyToEmail: 'hello@biz.test' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.replyToEmail).toBe('hello@biz.test');
  });

  it('coerces empty-string replyToEmail to null (clears the field)', () => {
    const r = companyUpdateSchema.safeParse({ replyToEmail: '' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.replyToEmail).toBeNull();
  });

  it('accepts null replyToEmail', () => {
    const r = companyUpdateSchema.safeParse({ replyToEmail: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.replyToEmail).toBeNull();
  });

  it('rejects a malformed replyToEmail', () => {
    expect(companyUpdateSchema.safeParse({ replyToEmail: 'not-an-email' }).success).toBe(false);
  });

  it('accepts offline payment fields (booleans + handles)', () => {
    const r = companyUpdateSchema.safeParse({
      paymentCashEnabled: true,
      paymentCheckEnabled: true,
      paymentCheckPayableTo: 'Razzle Dazzle LLC',
      paymentVenmoHandle: '@razzle-dazzle',
      paymentZelleContact: 'pay@razzle.test',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.paymentCashEnabled).toBe(true);
      expect(r.data.paymentVenmoHandle).toBe('@razzle-dazzle');
    }
  });

  it('coerces empty-string offline text fields to null (clears them)', () => {
    const r = companyUpdateSchema.safeParse({ paymentVenmoHandle: '', paymentZelleContact: '  ' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.paymentVenmoHandle).toBeNull();
      expect(r.data.paymentZelleContact).toBeNull();
    }
  });

  it('accepts a single offline boolean as the only field (sparse refine)', () => {
    expect(companyUpdateSchema.safeParse({ paymentCashEnabled: false }).success).toBe(true);
  });
});
