import { randomBytes } from 'node:crypto';
import { accounts, authUser, invitations, memberships } from '@thalermark/db';
import { disableTelemetry, enableTelemetry, isTelemetryDisabled } from '@thalermark/telemetry';
import { can, inviteRoleSchema, telemetryUpdateSchema } from '@thalermark/validation';
import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { v7 as uuidv7 } from 'uuid';
import type { AppDeps } from '../app.js';
import { emailFooterText, renderEmailHtml } from '../lib/email-layout.js';
import { EMAIL_RE, UUID_RE } from '../lib/route-helpers.js';
import { requireCapability } from '../middleware/authz.js';
import type { RlsVariables } from '../middleware/rls-context.js';

// account — the account / membership-administration domain, the four
// workspace-level prefixes: `/api/me` (the signed-in user + their memberships),
// `/api/account/telemetry` (account-wide telemetry consent, get + patch),
// `/api/invitations` (create + the token accept / decline / lookup), and
// `/api/team` (the member roster + remove / leave / role-change /
// transfer-ownership). A deps-taking sub-app: invite create closes over
// deps.mailer + deps.publicAppUrl to send the email. Several routes run on the
// BOOTSTRAP db (deps.bootstrapDb ?? deps.db) rather than the tenant tx —
// /api/me resolves memberships before an account is selected, and invitation
// accept / decline run before the user is a member of the target account, so
// rls-context's tenant tx isn't the right context. Mounted on createApp via
// .route() so its schema rides on its own AccountAppType instead of bloating
// AppType past TS7056.

// Invitations expire 7 days after they're sent.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function accountRoutes(deps: AppDeps) {
  const bootstrapDb = deps.bootstrapDb ?? deps.db;
  return (
    new Hono<{ Variables: RlsVariables }>()
      .get('/api/me', async (c) => {
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({
            id: authUser.id,
            email: authUser.email,
            name: authUser.name,
            lastAccountId: authUser.lastAccountId,
          })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);
        const rows = await bootstrapDb
          .select({
            accountId: memberships.accountId,
            name: accounts.name,
            role: memberships.role,
          })
          .from(memberships)
          .innerJoin(accounts, eq(memberships.accountId, accounts.id))
          .where(eq(memberships.userId, userId));
        return c.json({ user, memberships: rows });
      })
      .get('/api/me/invitations', async (c) => {
        // Pending invitations addressed to the session user's email. Bootstrap
        // path: the user is not yet a member of the inviting account, so this
        // reads via bootstrapDb (RLS would hide the rows without an account
        // context). Drives the "you have pending invitations" notice + the
        // accept/decline banners on the Workspace screen. Email is the trust
        // anchor (Better Auth lowercases it). Excludes accepted/declined/expired.
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({ email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);
        const rows = await bootstrapDb
          .select({
            token: invitations.token,
            accountName: accounts.name,
            inviterName: authUser.name,
            expiresAt: invitations.expiresAt,
          })
          .from(invitations)
          .innerJoin(accounts, eq(accounts.id, invitations.accountId))
          .innerJoin(authUser, eq(authUser.id, invitations.invitedByUserId))
          .where(
            and(
              sql`lower(${invitations.email}) = lower(${user.email})`,
              isNull(invitations.acceptedAt),
              isNull(invitations.declinedAt),
              gt(invitations.expiresAt, new Date()),
            ),
          )
          .orderBy(desc(invitations.createdAt));
        return c.json({
          invitations: rows.map((r) => ({
            token: r.token,
            accountName: r.accountName,
            inviterName: r.inviterName,
            expiresAt: r.expiresAt.toISOString(),
          })),
        });
      })
      // Per-account telemetry consent (TELEMETRY.md). The state isn't sensitive
      // and every client needs `enabled` to decide whether to emit, so GET is
      // open to any member; only PATCH (changing the account-wide decision) is
      // settings:manage. `decided` drives the first-run prompt (false → show
      // it); `disabled` reflects the deployment-wide TELEMETRY_DISABLED kill
      // switch. Reads the single account row under RLS.
      .get('/api/account/telemetry', async (c) => {
        const tx = c.get('tx');
        const [row] = await tx
          .select({
            enabled: accounts.telemetryEnabled,
            decidedAt: accounts.telemetryDecidedAt,
          })
          .from(accounts)
          .limit(1);
        return c.json({
          enabled: row?.enabled ?? false,
          decided: row?.decidedAt != null,
          disabled: isTelemetryDisabled(),
        });
      })
      .patch('/api/account/telemetry', requireCapability('settings:manage'), async (c) => {
        const parsed = telemetryUpdateSchema.safeParse(await c.req.json().catch(() => null));
        if (!parsed.success) {
          return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
        }
        const tx = c.get('tx');
        // A deployment that forbids telemetry can't be opted into — collapse any
        // enable request to a decided opt-out so the prompt still stops, but no
        // collection is ever armed.
        if (isTelemetryDisabled() || !parsed.data.enabled) {
          await disableTelemetry(tx);
          return c.json({ enabled: false, decided: true, disabled: isTelemetryDisabled() });
        }
        await enableTelemetry(tx);
        return c.json({ enabled: true, decided: true, disabled: false });
      })
      .post('/api/invitations', requireCapability('team:manage'), async (c) => {
        const body = (await c.req.json().catch(() => null)) as {
          email?: unknown;
          role?: unknown;
        } | null;
        const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
        if (!EMAIL_RE.test(email)) return c.json({ error: 'invalid_email' }, 400);
        // Default to member when the client omits a role (the prior behaviour);
        // an explicit role must be one of the four invitable ones (owner is
        // transfer-only, so inviteRoleSchema rejects it).
        const roleResult = inviteRoleSchema.safeParse(body?.role ?? 'member');
        if (!roleResult.success) return c.json({ error: 'invalid_role' }, 400);
        const role = roleResult.data;

        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const inviterId = c.get('userId');
        const id = uuidv7();
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

        await tx.insert(invitations).values({
          id,
          accountId,
          email,
          role,
          token,
          invitedByUserId: inviterId,
          expiresAt,
        });

        const path = `/accept-invite?token=${token}`;
        const url = deps.publicAppUrl ? `${deps.publicAppUrl}${path}` : path;

        if (!deps.mailer) {
          // server.ts always wires a mailer (console driver is the fallback
          // when RESEND_API_KEY is unset), so reaching this branch means the
          // caller built createApp without wiring one — misconfig, fail fast.
          return c.json({ error: 'mailer_not_configured' }, 500);
        }
        try {
          // Email I/O sits outside the tenant tx: the invitation row already
          // committed when this returns, and a mailer 5xx surfaces as 502
          // without rolling back the insert. The token is recoverable from
          // the row if the user retries; the alternative (rollback) silently
          // discards an invitation the caller saw acknowledged.
          await deps.mailer.send({
            to: email,
            subject: "You're invited to a workspace on Thalermark",
            text: `You've been invited to join a workspace on Thalermark — AI-first accounting for freelancers and tradespeople.\n\nAccept the invitation: ${url}\n\nThis invitation expires in 7 days. If you weren't expecting it, you can ignore this email.\n\n${emailFooterText(false)}\n`,
            html: renderEmailHtml({
              brandName: 'Thalermark',
              preheader: "You've been invited to join a workspace on Thalermark.",
              heading: "You're invited",
              bodyHtml:
                '<p style="margin:0;">You\'ve been invited to join a workspace on <strong>Thalermark</strong> — AI-first accounting for freelancers and tradespeople.</p>',
              cta: { label: 'Accept invitation', url },
              footnote:
                "This invitation expires in 7 days. If you weren't expecting it, you can ignore this email.",
            }),
          });
        } catch {
          return c.json({ error: 'mailer_send_failed' }, 502);
        }

        return c.json({ id, email, token, expiresAt: expiresAt.toISOString() }, 201);
      })
      .post('/api/invitations/:token/accept', async (c) => {
        // Bootstrap path: rls-context set userId from the session but did not
        // open a tenant tx (the accepting user is not yet a member, so no
        // account context is set). Read + write via bootstrapDb (RLS-bypass):
        // under the app role the invitation + membership rows are invisible
        // without app.current_account_id, so deps.db would 404 every accept and
        // the membership insert would be blocked. Token uniqueness + the
        // freshness/email checks below are the gate.
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({ id: authUser.id, email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);

        const token = c.req.param('token');
        const [invite] = await bootstrapDb
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.token, token),
              isNull(invitations.acceptedAt),
              isNull(invitations.declinedAt),
            ),
          );
        if (!invite) return c.json({ error: 'invite_not_found' }, 404);
        if (invite.expiresAt.getTime() < Date.now())
          return c.json({ error: 'invite_expired' }, 410);
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return c.json({ error: 'invite_email_mismatch' }, 403);
        }

        const acceptedAt = new Date();
        await bootstrapDb.transaction(async (tx) => {
          await tx
            .insert(memberships)
            .values({
              id: uuidv7(),
              userId: user.id,
              accountId: invite.accountId,
              role: invite.role,
            })
            .onConflictDoNothing({ target: [memberships.userId, memberships.accountId] });
          await tx
            .update(invitations)
            .set({ acceptedAt, acceptedByUserId: user.id, updatedAt: acceptedAt })
            .where(eq(invitations.id, invite.id));
        });

        return c.json({ accountId: invite.accountId });
      })
      .post('/api/invitations/:token/decline', async (c) => {
        // Bootstrap sibling of /accept: the invitee declines. Same gate (session
        // + email match) and same bootstrapDb path (the user is not a member of
        // the inviting account). Stamps declined_at so the inviter sees the
        // outcome on the team page; idempotent (a second decline returns ok).
        const userId = c.get('userId');
        const [user] = await bootstrapDb
          .select({ id: authUser.id, email: authUser.email })
          .from(authUser)
          .where(eq(authUser.id, userId));
        if (!user) return c.json({ error: 'unauthorized' }, 401);

        const token = c.req.param('token');
        const [invite] = await bootstrapDb
          .select()
          .from(invitations)
          .where(eq(invitations.token, token));
        if (!invite) return c.json({ error: 'invite_not_found' }, 404);
        if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
          return c.json({ error: 'invite_email_mismatch' }, 403);
        }
        // Already consumed the other way — surface it rather than silently
        // overwriting an acceptance with a decline.
        if (invite.acceptedAt) return c.json({ error: 'invite_already_accepted' }, 409);

        if (!invite.declinedAt) {
          const now = new Date();
          await bootstrapDb
            .update(invitations)
            .set({ declinedAt: now, updatedAt: now })
            .where(eq(invitations.id, invite.id));
        }
        return c.json({ ok: true });
      })
      .get('/api/invitations/:token', async (c) => {
        // Public invite preview (token-gated, no session — the invitee may not
        // have signed up yet). Powers the sign-up email prefill + the
        // existing-user accept prompt ("X invites you to Org"). Via bootstrapDb:
        // the viewer isn't a member, so RLS would hide the row.
        const token = c.req.param('token');
        const [row] = await bootstrapDb
          .select({
            email: invitations.email,
            accountName: accounts.name,
            inviterName: authUser.name,
            expiresAt: invitations.expiresAt,
            acceptedAt: invitations.acceptedAt,
          })
          .from(invitations)
          .innerJoin(accounts, eq(accounts.id, invitations.accountId))
          .innerJoin(authUser, eq(authUser.id, invitations.invitedByUserId))
          .where(eq(invitations.token, token))
          .limit(1);
        if (!row) return c.json({ error: 'invite_not_found' }, 404);
        return c.json({
          email: row.email,
          accountName: row.accountName,
          inviterName: row.inviterName,
          expired: row.expiresAt.getTime() < Date.now(),
          accepted: row.acceptedAt !== null,
        });
      })
      .get('/api/team', async (c) => {
        // Team management surface (settings/team): current members + the
        // still-open invitations for the active account. MVP gives every
        // member the same role, so there is no role column to return yet.
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const currentUserId = c.get('userId');

        // Members: memberships is the tenant table (RLS-scoped); join authUser
        // for the display name/email the same way /api/audit-events does.
        const memberRows = await tx
          .select({
            userId: memberships.userId,
            name: authUser.name,
            email: authUser.email,
            role: memberships.role,
            joinedAt: memberships.createdAt,
          })
          .from(memberships)
          .innerJoin(authUser, eq(authUser.id, memberships.userId))
          .where(eq(memberships.accountId, accountId))
          .orderBy(asc(memberships.createdAt));

        // Pending = not yet accepted. Expired-but-unaccepted rows still show
        // (the page flags them) so the inviter can see a stale invite and
        // re-send rather than wonder where it went.
        const pending = await tx
          .select({
            id: invitations.id,
            email: invitations.email,
            expiresAt: invitations.expiresAt,
            createdAt: invitations.createdAt,
            declinedAt: invitations.declinedAt,
          })
          .from(invitations)
          .where(and(eq(invitations.accountId, accountId), isNull(invitations.acceptedAt)))
          .orderBy(desc(invitations.createdAt));

        return c.json({
          members: memberRows.map((m) => ({
            userId: m.userId,
            name: m.name,
            email: m.email,
            role: m.role,
            joinedAt: m.joinedAt.toISOString(),
            isYou: m.userId === currentUserId,
          })),
          invitations: pending.map((p) => ({
            id: p.id,
            email: p.email,
            expiresAt: p.expiresAt.toISOString(),
            createdAt: p.createdAt.toISOString(),
            expired: p.expiresAt.getTime() < Date.now(),
            declined: p.declinedAt !== null,
          })),
        });
      })
      .delete('/api/team/:userId', async (c) => {
        // Remove a member from the current workspace, or leave it (when :userId
        // is the caller). Revokes access only — the auth_user and the workspace
        // data survive; the removed user hits account_revoked on their next
        // tenant request via the rls-context membership probe. The owner is
        // protected: cannot be removed and cannot leave — which also prevents
        // orphaning the workspace (the owner always remains). RLS permits the
        // DELETE because the membership row is account-scoped.
        //
        // No route-level requireCapability gate: this endpoint does double duty.
        // Removing SOMEONE ELSE needs team:manage; LEAVING (self-removal) is
        // self-service for any role. So the capability check below is conditional
        // on target !== caller.
        const tx = c.get('tx');
        const accountId = c.get('accountId');
        const audit = c.get('audit');
        const currentUserId = c.get('userId');
        const targetUserId = c.req.param('userId');
        if (!UUID_RE.test(targetUserId)) return c.json({ error: 'member_not_found' }, 404);
        if (targetUserId !== currentUserId && !can(c.get('role'), 'team:manage')) {
          return c.json({ error: 'forbidden', capability: 'team:manage' }, 403);
        }

        const [target] = await tx
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)))
          .limit(1);
        if (!target) return c.json({ error: 'member_not_found' }, 404);
        if (target.role === 'owner') return c.json({ error: 'cannot_remove_owner' }, 403);

        await tx
          .delete(memberships)
          .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)));

        await audit({
          entityType: 'membership',
          entityId: targetUserId,
          action: targetUserId === currentUserId ? 'leave' : 'remove',
          before: { userId: targetUserId, role: target.role },
          after: null,
        });

        return c.json({ ok: true });
      })
      // Change a member's role within the workspace. team:manage gated; the
      // owner's role is fixed (reassigning ownership is the transfer flow), and
      // inviteRoleSchema excludes 'owner' so nobody is promoted to owner here.
      .patch(
        '/api/team/:userId/role',
        requireCapability('team:manage'),
        validator('json', (value, c) => {
          const parsed = inviteRoleSchema.safeParse((value as { role?: unknown } | null)?.role);
          if (!parsed.success) return c.json({ error: 'invalid_role' }, 400);
          return { role: parsed.data };
        }),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const audit = c.get('audit');
          const targetUserId = c.req.param('userId');
          const { role } = c.req.valid('json');
          if (!UUID_RE.test(targetUserId)) return c.json({ error: 'member_not_found' }, 404);

          const [target] = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)))
            .limit(1);
          if (!target) return c.json({ error: 'member_not_found' }, 404);
          if (target.role === 'owner') return c.json({ error: 'cannot_change_owner' }, 403);

          if (target.role !== role) {
            await tx
              .update(memberships)
              .set({ role, updatedAt: new Date() })
              .where(
                and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)),
              );
            await audit({
              entityType: 'membership',
              entityId: targetUserId,
              action: 'update',
              before: { userId: targetUserId, role: target.role },
              after: { userId: targetUserId, role },
            });
          }

          return c.json({ ok: true, role });
        },
      )
      // Transfer workspace ownership to another member. workspace:manage gated,
      // which only the owner holds — so the caller is the current owner. Demote
      // the owner to admin BEFORE promoting the target so the one-owner-per-
      // account partial unique index never sees two owners mid-transaction.
      .post(
        '/api/team/:userId/transfer-ownership',
        requireCapability('workspace:manage'),
        async (c) => {
          const tx = c.get('tx');
          const accountId = c.get('accountId');
          const audit = c.get('audit');
          const currentUserId = c.get('userId');
          const targetUserId = c.req.param('userId');
          if (!UUID_RE.test(targetUserId)) return c.json({ error: 'member_not_found' }, 404);
          if (targetUserId === currentUserId) return c.json({ error: 'already_owner' }, 400);

          const [target] = await tx
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)))
            .limit(1);
          if (!target) return c.json({ error: 'member_not_found' }, 404);

          const now = new Date();
          await tx
            .update(memberships)
            .set({ role: 'admin', updatedAt: now })
            .where(
              and(eq(memberships.accountId, accountId), eq(memberships.userId, currentUserId)),
            );
          await tx
            .update(memberships)
            .set({ role: 'owner', updatedAt: now })
            .where(and(eq(memberships.accountId, accountId), eq(memberships.userId, targetUserId)));

          await audit({
            entityType: 'membership',
            entityId: targetUserId,
            action: 'transfer-ownership',
            before: { ownerUserId: currentUserId, previousTargetRole: target.role },
            after: { ownerUserId: targetUserId, demotedToAdmin: currentUserId },
          });

          return c.json({ ok: true });
        },
      )
  );
}

export type AccountAppType = ReturnType<typeof accountRoutes>;
