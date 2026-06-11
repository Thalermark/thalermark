import type { Role } from '@thalermark/validation';
import { api } from './api';
import { getActiveAccountId, setActiveAccountId } from './secure-store';

// Mobile-side mirror of web's active-account resolution
// (apps/web/src/hooks.server.ts). Web runs this in the SSR hook on every
// request and persists the choice in the `active_account_id` cookie; mobile has
// no cookie jar, so the choice lives in expo-secure-store and resolution runs
// in the (app) layout gate after the session check.
//
// `/api/me` is a bootstrap route — it returns the user's memberships without a
// tenant context (no `x-account-id` needed), and is the source of truth for
// which accounts the user may pick.

// role crosses the wire as a plain string (a Drizzle text column with a CHECK);
// it's narrowed to Role at the boundary below, where the active result is built.
export type Membership = { accountId: string; name: string; role: string };

export type ActiveAccountResult =
  // role is the active membership's role — carried so the (app) gate can hand it
  // to RoleProvider for UX capability gating (the API stays authoritative).
  | { status: 'ok'; accountId: string; role: Role }
  | { status: 'select'; memberships: Membership[] }
  | { status: 'none' }
  | { status: 'error' };

export async function resolveActiveAccount(): Promise<ActiveAccountResult> {
  const res = await api.api.me.$get().catch(() => null);
  // null = network error; 401 = session gone (the gate already checked the
  // session, so this is a rare race) → fall to the picker. Any other non-OK
  // (a 5xx — e.g. the DB is a migration behind) is a SERVER fault: surface it
  // as 'error' rather than masquerading as the "workspace isn't set up" state.
  if (!res) return { status: 'error' };
  if (res.status === 401) return { status: 'none' };
  if (!res.ok) return { status: 'error' };
  const { memberships } = await res.json();

  // 0 memberships: sign-up never finished wiring an account. Web sends these
  // users to /select-company's empty state; mobile surfaces the same copy.
  if (memberships.length === 0) return { status: 'none' };

  // Exactly one: auto-pick and persist, no detour. The common case.
  if (memberships.length === 1) {
    const only = memberships[0];
    if (!only) return { status: 'none' };
    await setActiveAccountId(only.accountId);
    return { status: 'ok', accountId: only.accountId, role: only.role as Role };
  }

  // Several: honor a previously stored choice if it's still a valid membership,
  // otherwise make the user pick.
  const stored = await getActiveAccountId();
  const active = stored ? memberships.find((m) => m.accountId === stored) : undefined;
  if (active) {
    return { status: 'ok', accountId: active.accountId, role: active.role as Role };
  }
  return { status: 'select', memberships };
}
