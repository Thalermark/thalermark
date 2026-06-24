import { z } from 'zod';

// Workspace roles = authorization (what a member may DO inside a workspace),
// distinct from RLS = isolation (which workspace's data they can see at all).
// RLS stays isolation-only; these roles are enforced in the app layer via the
// capability gate below. The set is fixed and code-defined — NOT a
// user-editable permission matrix.
//
//   owner       — the workspace creator. Everything, incl. billing, workspace
//                 delete, and ownership transfer. Protected (can't be removed
//                 or leave); exactly one per workspace.
//   admin       — all operational work + team management. NOT billing, delete,
//                 or transfer.
//   member      — day-to-day: invoices/estimates/recurring, contacts, expenses.
//                 Views reports but can't export the raw GL or touch settings.
//   accountant  — the "give my CPA access at tax time" persona: manage/categorize
//                 expenses + export the GL/tax data. NOT invoicing, settings, or
//                 team. Feeds the Accountant monetization tier.
//   viewer      — read-only.
export const ROLES = ['owner', 'admin', 'member', 'accountant', 'viewer'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

// Roles assignable via an invite or a role change. Owner is excluded on
// purpose — you become owner only through the transfer-ownership flow, which
// keeps the one-owner-per-workspace invariant intact.
export const INVITE_ROLES = ['admin', 'member', 'accountant', 'viewer'] as const;
export const inviteRoleSchema = z.enum(INVITE_ROLES);
export type InviteRole = (typeof INVITE_ROLES)[number];

// Capabilities gate mutating actions. Reads are intentionally NOT represented
// here — every role (including viewer) may GET, so read routes carry no gate.
// A capability maps a cluster of related writes to the roles allowed to perform
// them; the api applies `can(role, capability)` per mutating route.
export const CAPABILITIES = [
  'sales:write', // invoices, estimates, recurring, items catalog + their state actions
  'contacts:write',
  'expenses:write', // create/edit/delete, receipts, categorize
  'reports:export', // GL / ledger export
  'settings:manage', // company profile, logo, email, payments, Stripe Connect
  'team:manage', // invite, remove, change role
  'billing:manage', // reserved — SaaS billing is out-of-band today
  'workspace:manage', // delete workspace + transfer ownership
] as const;
export type Capability = (typeof CAPABILITIES)[number];

// owner = everything. The rest are explicit subsets so a reviewer can read a
// role's full reach in one place.
export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  owner: [...CAPABILITIES],
  admin: [
    'sales:write',
    'contacts:write',
    'expenses:write',
    'reports:export',
    'settings:manage',
    'team:manage',
  ],
  member: ['sales:write', 'contacts:write', 'expenses:write'],
  accountant: ['expenses:write', 'reports:export'],
  viewer: [],
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}
