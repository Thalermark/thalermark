import { describe, expect, it } from 'vitest';
import { businessPersona } from './persona.js';

// The five values companies.business_type may hold (the DB CHECK also allows
// NULL, covered separately below).
const BUSINESS_TYPES = ['sole_prop', 'llc_single_member', 'partnership', 's_corp', 'c_corp'];

describe('businessPersona', () => {
  // These are copy, and asserting them exactly is the point: a reworded persona
  // shifts model output, so it should have to be a deliberate edit here rather
  // than something that rides along in an unrelated change.
  it('maps each business type to its persona', () => {
    expect(businessPersona('sole_prop')).toBe('a freelancer or tradesperson');
    expect(businessPersona('llc_single_member')).toBe('a small business set up as an LLC');
    expect(businessPersona('partnership')).toBe('a small business set up as a partnership');
    expect(businessPersona('s_corp')).toBe('a small business set up as an S-corporation');
    expect(businessPersona('c_corp')).toBe('a small business set up as a C-corporation');
  });

  // business_type is nullable and the app reads null as sole prop everywhere
  // else (filesScheduleC, periodCloseEquityLabel, coaOverlayFor).
  it('falls back to the sole-prop persona for null, undefined, and empty', () => {
    const soleProp = businessPersona('sole_prop');
    expect(businessPersona(null)).toBe(soleProp);
    expect(businessPersona(undefined)).toBe(soleProp);
    expect(businessPersona('')).toBe(soleProp);
  });

  // A value straight off a company row must never be able to break a prompt.
  it('falls back rather than throwing on an unrecognised code', () => {
    expect(businessPersona('not_a_type')).toBe(businessPersona('sole_prop'));
  });

  // The prompts render `… for ${persona}.`, so a phrase that lost its article
  // would silently produce "for small business set up as an LLC." — grammatical
  // damage no type check catches. This is the guard for anything added later.
  it('gives every persona its own leading determiner', () => {
    for (const bt of BUSINESS_TYPES) {
      expect(businessPersona(bt)).toMatch(/^(a|an|the) /);
    }
  });

  it('gives corporations a persona distinct from a sole trader', () => {
    // The whole point of the change: these must not be interchangeable.
    for (const bt of ['llc_single_member', 'partnership', 's_corp', 'c_corp']) {
      expect(businessPersona(bt)).not.toBe(businessPersona('sole_prop'));
    }
  });
});
