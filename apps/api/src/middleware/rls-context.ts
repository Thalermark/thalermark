import { type Database, type Transaction, memberships, withAccountContext } from '@thalermark/db';
import { scheduleTelemetryFlush } from '@thalermark/telemetry';
import type { Role } from '@thalermark/validation';
import { and, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import type { ApiAuth } from '../lib/auth.js';
import { type AuditWriter, createAuditWriter } from './audit.js';

export type RlsContextDeps = {
  auth: ApiAuth;
  db: Database;
  // Superuser handle for the pre-tenant-context membership probe below. The
  // memberships RLS policy gates SELECT on `app.current_account_id`, which
  // isn't set yet here, so under the tenant role the lookup would always
  // return zero rows and every authenticated request would 403. Defaults to
  // `db` for integration tests that run as the testcontainer superuser.
  bootstrapDb?: Database;
  scheduleFlush?: (db: Database, accountId: string) => void;
};

export type RlsVariables = {
  tx: Transaction;
  accountId: string;
  userId: string;
  // The caller's role in the active account, loaded by the membership probe
  // below. Drives the requireCapability gate (see middleware/authz.ts). Only
  // set on tenant routes; bootstrap/public paths return before the probe and
  // never read it.
  role: Role;
  audit: AuditWriter;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Bootstrap endpoints: authenticated but not yet (or never) account-scoped. The
// picker reads from /api/me to learn which accounts the user can pick from, then
// sets x-account-id on every subsequent request. Invitation accept is also
// bootstrap because the user is not yet a member of the target account.
// /api/locations/autocomplete is account-agnostic (it proxies an external
// geocoder and touches no tenant data) — listing it here keeps it behind auth
// while skipping the x-account-id requirement + the tenant tx, so it never pins
// a DB connection across the upstream HTTP call.
const BOOTSTRAP_PATH_PATTERNS: RegExp[] = [
  /^\/api\/me$/,
  /^\/api\/me\/memberships$/,
  // The session user's pending invitations + accept/decline. All three run
  // before the user is a member of the inviting account, so no x-account-id /
  // tenant tx — the handler reads/writes via bootstrapDb, gated by the session
  // email matching the invitation.
  /^\/api\/me\/invitations$/,
  /^\/api\/invitations\/[^/]+\/accept$/,
  /^\/api\/invitations\/[^/]+\/decline$/,
  /^\/api\/locations\/autocomplete$/,
];

// Unauthed public endpoints: no session, no tenant context. Token in the URL
// is the only thing gating access — by design, because the recipient of an
// invoice email has no account here. The handler is on the hook for treating
// the token as the only credential and reading via bootstrapDb (RLS would
// hide everything under the missing app.current_account_id setting).
//
// /api/public/* — invoice-recipient-facing reads / Stripe Checkout session
//                  mints, gated by the random invoice publicToken.
// /api/webhooks/* — server-to-server callbacks (Stripe, future providers),
//                  gated by the provider's signature scheme on the raw body.
// /api/files/* — local-FS receipt downloads, gated by the HMAC-signed token
//                in the URL (slice 8.9g). No session: the token is the sole
//                credential, same model as the public invoice routes.
const PUBLIC_PATH_PATTERNS: RegExp[] = [
  /^\/api\/public\//,
  /^\/api\/webhooks\//,
  /^\/api\/files\//,
  // GET /api/invitations/:token — the invite preview. No session: the invitee
  // may not have signed up yet (the sign-up form reads it to prefill the
  // email). Token in the URL is the credential. Does NOT match the
  // `/accept` sub-path (that stays a bootstrap path, session-gated).
  /^\/api\/invitations\/[^/]+$/,
];

function isBootstrapPath(path: string): boolean {
  return BOOTSTRAP_PATH_PATTERNS.some((p) => p.test(path));
}

function isPublicPath(path: string): boolean {
  return PUBLIC_PATH_PATTERNS.some((p) => p.test(path));
}

export function rlsContext({
  auth,
  db,
  bootstrapDb,
  scheduleFlush = scheduleTelemetryFlush,
}: RlsContextDeps): MiddlewareHandler {
  const probeDb = bootstrapDb ?? db;
  return async (c, next) => {
    // Public paths skip auth entirely — token in URL is the sole credential
    // and the handler does its own lookup (necessarily via bootstrapDb).
    if (isPublicPath(c.req.path)) return next();

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'unauthorized' }, 401);

    c.set('userId', session.user.id);

    if (isBootstrapPath(c.req.path)) return next();

    const accountId = c.req.header('x-account-id');
    if (!accountId || !UUID_RE.test(accountId)) {
      return c.json({ error: 'account_required' }, 400);
    }

    const found = await probeDb
      .select({ id: memberships.id, role: memberships.role })
      .from(memberships)
      .where(and(eq(memberships.userId, session.user.id), eq(memberships.accountId, accountId)))
      .limit(1);
    const membership = found[0];
    if (!membership) return c.json({ error: 'account_revoked' }, 403);
    // role is text in the DB but the CHECK constraint guarantees it's one of the
    // five Role values; cast rather than re-validate on every request.
    c.set('role', membership.role as Role);

    let didWrite = false;
    try {
      await withAccountContext(db, { accountId, userId: session.user.id }, async (tx) => {
        c.set('tx', tx);
        c.set('accountId', accountId);
        c.set(
          'audit',
          createAuditWriter({
            tx,
            accountId,
            actorUserId: session.user.id,
            onWrite: () => {
              didWrite = true;
            },
          }),
        );
        await next();
        // Hono swallows handler throws into c.error so the response can be
        // rendered. Re-throw here to roll back the tenant tx (and the audit
        // row written before the handler exploded).
        if (c.error) throw c.error;
      });
      // Fire-and-forget: drain the telemetry staging queue after a write
      // commits. Reads skip this so list endpoints don't pay a per-request
      // opt-in lookup. Only reached if the tx committed (no throw).
      if (didWrite) scheduleFlush(db, accountId);
    } catch (_err) {
      // Already captured by Hono as c.error; the throw above only existed to
      // signal drizzle to rollback. Don't double-render.
    }
  };
}
