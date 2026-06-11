import { type Capability, type Role, can } from '@thalermark/validation';
import { type ReactNode, createContext, useContext } from 'react';

// The active workspace membership's role, resolved once in the (app) gate
// (lib/active-account.ts) alongside the active account and provided to every
// feature screen. The web equivalent is hooks.server.ts → locals.role →
// page.data.role; mobile has no SSR hook, so a React context carries it.
//
// UX gating only — the API is always authoritative (every mutating route 403s
// a role lacking the capability). An undefined role (gate not yet resolved)
// reads as no access, so a control is never shown to someone we can't authorize.
const RoleContext = createContext<Role | undefined>(undefined);

export function RoleProvider({
  role,
  children,
}: {
  role: Role | undefined;
  children: ReactNode;
}) {
  return <RoleContext.Provider value={role}>{children}</RoleContext.Provider>;
}

export function useRole(): Role | undefined {
  return useContext(RoleContext);
}

// Convenience: does the active role hold this capability? Mirrors web's
// `may()` helper. Use to hide New/Send/Edit/Delete and settings entries.
export function useMay(capability: Capability): boolean {
  const role = useContext(RoleContext);
  return role !== undefined && can(role, capability);
}
