import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test as setup } from '@playwright/test';

// Getting a browser to an in-app page costs three gates (TMC-249).
//
// A signed-up user is bounced by email verification, then by the onboarding
// wizard, then by the legal-consent clickwrap — every one of them redirects
// away from whatever page a test wanted to look at. Doing that through the UI
// would make the suite a test of the sign-up flow with the actual assertion
// stapled to the end, so it is done over the API and saved as a session.
//
// EMAIL VERIFICATION is not cleared here, it is arranged not to apply. The API
// must be started with REQUIRE_EMAIL_VERIFICATION=false:
//
//   REQUIRE_EMAIL_VERIFICATION=false pnpm --filter @thalermark/api dev
//
// Explicitly, not by omitting RESEND_API_KEY. The flag reads
// `env.requireEmailVerification ?? !!env.resendApiKey`, and the repo .env
// carries a real key that a process-level `RESEND_API_KEY=` does not displace —
// so the omission approach silently leaves verification ON, sign-up answers 200
// with `token: null`, and the failure arrives later wearing a different mask.
// Asked for by name instead, and asserted below.
const API = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:3000';

// Better Auth refuses a request with no Origin — MISSING_OR_NULL_ORIGIN, 403 —
// as CSRF protection. A browser always sends one; Node's fetch does not, which
// is the same trap the mobile client hit and solved by pinning `thalermark://`
// on every request (see apps/mobile CLAUDE.md). These calls are made from the
// test runner, not the page, so they have to say who they are too. It must be a
// value the API's TRUSTED_ORIGINS allows.
const ORIGIN = process.env.PLAYWRIGHT_ORIGIN ?? 'http://localhost:5173';
const JSON_HEADERS = { 'content-type': 'application/json', origin: ORIGIN };
const PASSWORD = 'correct horse battery staple';
const STATE_PATH = 'e2e/.auth/state.json';

// A fresh account per run. Shared fixtures rot, and a route walk that creates
// nothing is perfectly happy with an account nobody else is touching.
const email = `pw-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

type Session = { cookie: string; accountId: string; companyId: string };

async function signUp(): Promise<string> {
  const res = await fetch(`${API}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD, name: 'Playwright' }),
  });
  // The body, not just the status. A bare 403 is the kind of failure that costs
  // an afternoon; the API always says why.
  const detail = await res
    .clone()
    .text()
    .catch(() => '');
  expect(
    res.status,
    `sign-up failed (${res.status}) at ${API}: ${detail.slice(0, 300)}
     Start the API with REQUIRE_EMAIL_VERIFICATION=false.`,
  ).toBe(200);
  const setCookie =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  // No cookie means the API issued no session, which in practice means email
  // verification is still on. Named here so the failure says what to change.
  expect(
    cookie,
    'sign-up returned no session cookie — start the API with REQUIRE_EMAIL_VERIFICATION=false',
  ).toBeTruthy();
  return cookie;
}

async function resolveWorkspace(cookie: string): Promise<Session> {
  const me = await fetch(`${API}/api/me`, { headers: { cookie } });
  expect(me.status, 'GET /api/me failed after sign-up').toBe(200);
  const body = (await me.json()) as { memberships: { accountId: string }[] };
  const accountId = body.memberships[0]?.accountId;
  expect(accountId, '/api/me returned no membership').toBeTruthy();

  const companies = await fetch(`${API}/api/companies`, {
    headers: { cookie, 'x-account-id': accountId as string, origin: ORIGIN },
  });
  const { companies: list } = (await companies.json()) as { companies: { id: string }[] };
  const companyId = list[0]?.id;
  expect(companyId, 'the new account has no company').toBeTruthy();
  return { cookie, accountId: accountId as string, companyId: companyId as string };
}

// Gate 2: (app)/+layout.server.ts redirects to /welcome while any company has a
// null businessType.
async function clearOnboarding(s: Session): Promise<void> {
  const res = await fetch(`${API}/api/companies/${s.companyId}`, {
    method: 'PATCH',
    headers: { ...JSON_HEADERS, cookie: s.cookie, 'x-account-id': s.accountId },
    body: JSON.stringify({ businessType: 'sole_prop', name: 'Playwright Landscaping' }),
  });
  expect(res.ok, `setting businessType failed (${res.status})`).toBe(true);
}

// Gate 3: the "Before you continue" wall blocks every (app) route until the
// terms are accepted. A no-op on a build with no legal-consent provider, which
// is why its failure is tolerated rather than asserted.
async function acceptLegal(s: Session): Promise<void> {
  await fetch(`${API}/api/legal/accept`, {
    method: 'POST',
    headers: { ...JSON_HEADERS, cookie: s.cookie, 'x-account-id': s.accountId },
    body: JSON.stringify({}),
  }).catch(() => {});
}

setup('sign up and clear the gates', async ({ page }) => {
  const cookie = await signUp();
  const session = await resolveWorkspace(cookie);
  await clearOnboarding(session);
  await acceptLegal(session);

  // Hand the browser the same cookies. `active_account_id` is what
  // hooks.server.ts reads to stamp x-account-id on every server-side API call —
  // without it the app renders as though the user belongs to no workspace.
  const url = new URL(page.url() === 'about:blank' ? 'http://localhost' : page.url());
  await page.context().addCookies([
    ...cookie.split('; ').map((pair) => {
      const [name, ...rest] = pair.split('=');
      return {
        name: name as string,
        value: rest.join('='),
        domain: 'localhost',
        path: '/',
      };
    }),
    { name: 'active_account_id', value: session.accountId, domain: 'localhost', path: '/' },
  ]);
  void url;

  // Prove the session actually works before saving it. Without this the whole
  // suite fails later with a wall of unrelated assertion errors, and the real
  // cause — a broken sign-in — is buried.
  await page.goto('/');
  await expect(page.locator('h1').first()).toBeVisible();
  expect(page.url(), 'landed on a gate instead of the app').not.toContain('/sign-in');
  expect(page.url()).not.toContain('/welcome');

  mkdirSync('e2e/.auth', { recursive: true });
  await page.context().storageState({ path: STATE_PATH });
  writeFileSync(
    'e2e/.auth/workspace.json',
    JSON.stringify({ accountId: session.accountId, companyId: session.companyId, email }, null, 2),
  );
});
