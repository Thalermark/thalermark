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

export type Membership = { accountId: string; name: string };

export type ActiveAccountResult =
  | { status: 'ok'; accountId: string }
  | { status: 'select'; memberships: Membership[] }
  | { status: 'none' };

export async function resolveActiveAccount(): Promise<ActiveAccountResult> {
  const res = await api.api.me.$get();
  if (!res.ok) return { status: 'none' };
  const { memberships } = await res.json();

  // 0 memberships: sign-up never finished wiring an account. Web sends these
  // users to /select-company's empty state; mobile surfaces the same copy.
  if (memberships.length === 0) return { status: 'none' };

  // Exactly one: auto-pick and persist, no detour. The common case.
  if (memberships.length === 1) {
    const only = memberships[0];
    if (!only) return { status: 'none' };
    await setActiveAccountId(only.accountId);
    return { status: 'ok', accountId: only.accountId };
  }

  // Several: honor a previously stored choice if it's still a valid membership,
  // otherwise make the user pick.
  const stored = await getActiveAccountId();
  if (stored && memberships.some((m) => m.accountId === stored)) {
    return { status: 'ok', accountId: stored };
  }
  return { status: 'select', memberships };
}
