import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  type Capability,
  INVITE_ROLES,
  ROLES,
  type Role,
  can,
  inviteRoleSchema,
  roleSchema,
} from './roles.js';

describe('role enums', () => {
  it('roleSchema accepts every role and rejects unknowns', () => {
    for (const role of ROLES) expect(roleSchema.parse(role)).toBe(role);
    expect(roleSchema.safeParse('superuser').success).toBe(false);
    expect(roleSchema.safeParse('').success).toBe(false);
  });

  it('inviteRoleSchema excludes owner', () => {
    for (const role of INVITE_ROLES) expect(inviteRoleSchema.parse(role)).toBe(role);
    expect(inviteRoleSchema.safeParse('owner').success).toBe(false);
    expect(INVITE_ROLES).not.toContain('owner');
  });
});

describe('can(role, capability) matrix', () => {
  // The full source-of-truth grid. Keep this in lockstep with ROLE_CAPABILITIES
  // — a row per role, a flag per capability. A drift here is the early warning
  // that a role's reach changed.
  const grid: Record<Role, Record<Capability, boolean>> = {
    owner: {
      'sales:write': true,
      'contacts:write': true,
      'expenses:write': true,
      'reports:export': true,
      'settings:manage': true,
      'team:manage': true,
      'billing:manage': true,
      'workspace:manage': true,
    },
    admin: {
      'sales:write': true,
      'contacts:write': true,
      'expenses:write': true,
      'reports:export': true,
      'settings:manage': true,
      'team:manage': true,
      'billing:manage': false,
      'workspace:manage': false,
    },
    member: {
      'sales:write': true,
      'contacts:write': true,
      'expenses:write': true,
      'reports:export': false,
      'settings:manage': false,
      'team:manage': false,
      'billing:manage': false,
      'workspace:manage': false,
    },
    accountant: {
      'sales:write': false,
      'contacts:write': false,
      'expenses:write': true,
      'reports:export': true,
      'settings:manage': false,
      'team:manage': false,
      'billing:manage': false,
      'workspace:manage': false,
    },
    viewer: {
      'sales:write': false,
      'contacts:write': false,
      'expenses:write': false,
      'reports:export': false,
      'settings:manage': false,
      'team:manage': false,
      'billing:manage': false,
      'workspace:manage': false,
    },
  };

  for (const role of ROLES) {
    for (const capability of CAPABILITIES) {
      it(`${role} ${grid[role][capability] ? 'can' : 'cannot'} ${capability}`, () => {
        expect(can(role, capability)).toBe(grid[role][capability]);
      });
    }
  }

  it('only owner holds billing:manage and workspace:manage', () => {
    for (const role of ROLES) {
      const ownerOnly = role === 'owner';
      expect(can(role, 'billing:manage')).toBe(ownerOnly);
      expect(can(role, 'workspace:manage')).toBe(ownerOnly);
    }
  });
});
