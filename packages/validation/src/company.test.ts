import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TYPES,
  TAX_FORM_BY_BUSINESS_TYPE,
  businessTypeSchema,
  companyUpdateSchema,
  filesScheduleC,
  timezoneOptions,
} from './company.js';

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

describe('TAX_FORM_BY_BUSINESS_TYPE', () => {
  it('names the return every business type files', () => {
    expect(TAX_FORM_BY_BUSINESS_TYPE).toEqual({
      sole_prop: 'Schedule C (Form 1040)',
      llc_single_member: 'Schedule C (Form 1040)',
      partnership: 'Form 1065',
      s_corp: 'Form 1120-S',
      c_corp: 'Form 1120',
    });
  });

  it('covers every stored-value enum member', () => {
    for (const bt of BUSINESS_TYPES) {
      expect(TAX_FORM_BY_BUSINESS_TYPE[bt]).toBeTruthy();
    }
  });
});

describe('filesScheduleC', () => {
  // A single-member LLC is a disregarded entity — it files the same Schedule C a
  // sole proprietor does. Everything else files a return of its own.
  it('is true for the two disregarded-entity types', () => {
    expect(filesScheduleC('sole_prop')).toBe(true);
    expect(filesScheduleC('llc_single_member')).toBe(true);
  });

  it('is false for the entity types with their own return', () => {
    expect(filesScheduleC('partnership')).toBe(false);
    expect(filesScheduleC('s_corp')).toBe(false);
    expect(filesScheduleC('c_corp')).toBe(false);
  });

  // Not captured yet — the provisional chart seeded at signup is the sole-prop
  // one, so the Schedule C surfaces match what's actually in the books.
  it('is true when the type is unset', () => {
    expect(filesScheduleC(null)).toBe(true);
    expect(filesScheduleC(undefined)).toBe(true);
    expect(filesScheduleC('')).toBe(true);
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

// The picker showed Africa/Abidjan for every untouched company, because
// Intl.supportedValuesOf('timeZone') omits 'UTC' and 'UTC' is what
// companies.timezone defaults to. A select whose value matches no option falls
// back to the first one, so saving without touching the field would have filed
// a business's books in Côte d'Ivoire.
describe('timezoneOptions', () => {
  it("includes 'UTC', which Intl's own list does not", () => {
    expect(Intl.supportedValuesOf('timeZone')).not.toContain('UTC');
    expect(timezoneOptions()).toContain('UTC');
  });

  it('puts the fallback first so an unmatched value cannot silently pick Abidjan', () => {
    expect(timezoneOptions()[0]).toBe('UTC');
  });

  it('carries a stored zone that is a valid alias but absent from the list', () => {
    // The schema accepts anything Intl can build a formatter for, which is a
    // wider set than supportedValuesOf returns.
    const opts = timezoneOptions('US/Central');
    expect(opts).toContain('US/Central');
    expect(opts).toContain('UTC');
  });

  it('does not duplicate a zone already in the list', () => {
    const opts = timezoneOptions('America/Chicago');
    expect(opts.filter((z) => z === 'America/Chicago')).toHaveLength(1);
  });

  it('still offers the real zones', () => {
    expect(timezoneOptions().length).toBeGreaterThan(400);
    expect(timezoneOptions()).toContain('America/Chicago');
  });
});
