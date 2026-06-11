import { type Capability, type Role, can } from '@thalermark/validation';

// UX-only capability gate for the web app. The API is always the real
// authority (every mutating route 403s a role that lacks the capability);
// these checks just hide controls a role can't use so the UI stays honest.
// An absent role (no active workspace resolved yet) is treated as no access,
// so a gated control is never shown to someone we can't authorize.
export function may(role: Role | undefined, capability: Capability): boolean {
  return role !== undefined && can(role, capability);
}
