import { getActiveAccountId, getAuthToken } from './secure-store';
import { getServerUrl } from './server-url';

const APP_ORIGIN = 'thalermark://';

// Send a team invite. POST /api/invitations has no hono `json` validator on the
// API side, so the typed hc client can't carry the body (its Input has no
// `json`) — same escape hatch web uses (settings/team's server action raw-fetches
// it). A plain JSON fetch is fine here; the RN-fetch multipart problem (see
// upload.ts) is specific to the { uri, name, type } file shim, not JSON. Same
// auth contract as api.ts: bearer + Origin + x-account-id from secure-store.
export type InviteResult = { ok: true } | { ok: false; error: string };

export async function sendInvite(email: string): Promise<InviteResult> {
  const token = await getAuthToken();
  const accountId = await getActiveAccountId();
  const headers: Record<string, string> = {
    Origin: APP_ORIGIN,
    'content-type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (accountId) headers['x-account-id'] = accountId;

  try {
    const res = await fetch(`${getServerUrl()}/api/invitations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error ?? 'send_failed' };
  } catch {
    return { ok: false, error: 'network' };
  }
}
