import type { InviteRole } from '@thalermark/validation';
import { getActiveAccountId, getAuthToken } from './secure-store';
import { getServerUrl } from './server-url';

const APP_ORIGIN = 'thalermark://';

// Team mutations that the typed hc client can't cleanly carry — POST
// /api/invitations has no json validator, and PATCH .../role uses a custom
// validator whose Input doesn't survive into hc — so we raw-fetch them, the
// same escape hatch web's settings/team server actions use. Same auth contract
// as api.ts: bearer + Origin + x-account-id from secure-store, read at call
// time (getServerUrl is a runtime value — see the mobile CLAUDE.md).
export type TeamMutationResult = { ok: true } | { ok: false; error: string };

async function teamHeaders(): Promise<Record<string, string>> {
  const token = await getAuthToken();
  const accountId = await getActiveAccountId();
  const headers: Record<string, string> = {
    Origin: APP_ORIGIN,
    'content-type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (accountId) headers['x-account-id'] = accountId;
  return headers;
}

async function teamPost(path: string, body?: unknown): Promise<TeamMutationResult> {
  try {
    const res = await fetch(`${getServerUrl()}${path}`, {
      method: 'POST',
      headers: await teamHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: parsed?.error ?? 'send_failed' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

// Invite a teammate, optionally with a role (defaults to member on the server).
export function sendInvite(email: string, role?: InviteRole): Promise<TeamMutationResult> {
  return teamPost('/api/invitations', role ? { email, role } : { email });
}

// Change another member's role. team:manage on the API; the owner's role is
// fixed (use transferOwnership). inviteRoleSchema rejects 'owner' here.
export async function changeMemberRole(
  userId: string,
  role: InviteRole,
): Promise<TeamMutationResult> {
  try {
    const res = await fetch(`${getServerUrl()}/api/team/${userId}/role`, {
      method: 'PATCH',
      headers: await teamHeaders(),
      body: JSON.stringify({ role }),
    });
    if (res.ok) return { ok: true };
    const parsed = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: parsed?.error ?? 'send_failed' };
  } catch {
    return { ok: false, error: 'network' };
  }
}

// Transfer workspace ownership to another member (owner-only on the API). The
// current owner becomes an admin.
export function transferOwnership(userId: string): Promise<TeamMutationResult> {
  return teamPost(`/api/team/${userId}/transfer-ownership`);
}
