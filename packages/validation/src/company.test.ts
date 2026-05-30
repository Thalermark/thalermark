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
});
