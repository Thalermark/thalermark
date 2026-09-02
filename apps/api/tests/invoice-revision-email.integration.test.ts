import { authUser, companies, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// The email a corrected document goes out with (TMC-227).
//
// The customer already has a wrong invoice in their inbox. A resend that looks
// byte-for-byte like the original leaves them to spot the difference — or worse,
// to pay the first one because it is the message they open. So a re-issue leads
// with what changed and says so in the subject line.
//
// The framing is earned by TWO facts together: this send performed the
// draft → sent flip, and the document has been pulled back at least once.
// Neither alone is enough, and the tests below pin both directions.

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'info',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '',
  appDatabaseUrl: '',
  appRolePassword: undefined,
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: 'http://localhost:5173',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

type SentMail = { to: string; subject: string; html: string; text: string; from?: string };

function makeRecorder() {
  const sent: SentMail[] = [];
  return {
    sent,
    mailer: {
      async send(msg: SentMail) {
        sent.push(msg);
      },
    },
  };
}

function extractSessionCookie(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

function buildApp(mailer: import('../src/lib/mailer.js').Mailer) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer,
    emailFrom: 'Thalermark <test@thalermark.test>',
  });
  return { app, handle };
}

async function setup(email: string) {
  const rec = makeRecorder();
  const { app, handle } = buildApp(rec.mailer);
  const signUp = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status}`);
  const cookie = extractSessionCookie(signUp);

  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error('user not seeded');
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error('membership not seeded');
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error('company not seeded');

  const headers = {
    cookie,
    'x-account-id': m.accountId,
    'content-type': 'application/json',
  };
  return { app, handle, rec, headers, companyId: company.id };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function makeCustomer(ctx: Ctx): Promise<string> {
  const res = await ctx.app.request('/api/contacts', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      name: 'Wile E. Coyote',
      email: 'wile@acme.test',
    }),
  });
  if (res.status !== 201) throw new Error(`contact create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

async function makeInvoice(ctx: Ctx, contactId: string, total: string): Promise<string> {
  const res = await ctx.app.request('/api/invoices', {
    method: 'POST',
    headers: ctx.headers,
    body: JSON.stringify({
      companyId: ctx.companyId,
      contactId,
      number: 'INV-001',
      issueDate: '2026-06-10',
      dueDate: '2026-07-10',
      subtotal: total,
      total,
      lineItems: [
        {
          position: 1,
          description: 'Work',
          quantity: '1',
          unitPrice: total,
          amount: total,
          type: 'service',
        },
      ],
    }),
  });
  if (res.status !== 201) throw new Error(`invoice create failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

function send(ctx: Ctx, id: string) {
  return ctx.app.request(`/api/invoices/${id}/send`, {
    method: 'POST',
    headers: ctx.headers,
    body: '{}',
  });
}

function revise(ctx: Ctx, id: string) {
  return ctx.app.request(`/api/invoices/${id}/revise`, { method: 'POST', headers: ctx.headers });
}

function editTotal(ctx: Ctx, id: string, contactId: string, total: string) {
  return ctx.app.request(`/api/invoices/${id}`, {
    method: 'PATCH',
    headers: ctx.headers,
    body: JSON.stringify({
      contactId,
      number: 'INV-001',
      issueDate: '2026-06-10',
      dueDate: '2026-07-10',
      subtotal: total,
      total,
      lineItems: [
        {
          position: 1,
          description: 'Work',
          quantity: '1',
          unitPrice: total,
          amount: total,
          type: 'service',
        },
      ],
    }),
  });
}

describe('the corrected-invoice email', () => {
  beforeEach(resetDb);

  it('leads with the apology and names both figures', async () => {
    const ctx = await setup('amended@test.com');
    try {
      const contactId = await makeCustomer(ctx);
      const id = await makeInvoice(ctx, contactId, '450.00');
      expect((await send(ctx, id)).status).toBe(200);
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, '4500.00');
      expect((await send(ctx, id)).status).toBe(200);

      const first = ctx.rec.sent[0];
      const corrected = ctx.rec.sent[1];
      expect(ctx.rec.sent).toHaveLength(2);

      // The original was an ordinary invoice email.
      expect(first?.subject).toMatch(/^Invoice INV-001 from /);
      expect(first?.text).not.toContain('the earlier invoice was wrong');

      // The re-issue is not. Prefixed rather than replaced, so the business's
      // own subject line still identifies the thread.
      expect(corrected?.subject).toMatch(/^Corrected: Invoice INV-001 from /);
      expect(corrected?.text).toContain('Sorry, the earlier invoice was wrong.');
      // Formatted for a reader, not the stored decimal string.
      expect(corrected?.text).toContain('The total changed from $450.00 to $4,500.00.');
      expect(corrected?.html).toContain('The total changed from $450.00 to $4,500.00.');
      // The preheader is what shows next to the subject in the inbox list.
      expect(corrected?.html).toContain('Corrected invoice INV-001');
      // And the fixed chrome survives — this is still a payable invoice email.
      expect(corrected?.html).toContain('/i/');
    } finally {
      await ctx.handle.close();
    }
  });

  it('omits the figures when the correction was not about the money', async () => {
    const ctx = await setup('samefigure@test.com');
    try {
      const contactId = await makeCustomer(ctx);
      const id = await makeInvoice(ctx, contactId, '450.00');
      await send(ctx, id);
      await revise(ctx, id);
      // Same total, corrected description — the common "wrong line, right
      // money" case.
      await editTotal(ctx, id, contactId, '450.00');
      await send(ctx, id);

      const corrected = ctx.rec.sent[1];
      expect(corrected?.subject).toMatch(/^Corrected: /);
      expect(corrected?.text).toContain('Sorry, the earlier invoice was wrong.');
      // "The total changed from $450.00 to $450.00" would read as a mistake in
      // its own right.
      expect(corrected?.text).not.toContain('The total changed');
    } finally {
      await ctx.handle.close();
    }
  });

  it('reverts to the ordinary email on a later plain resend', async () => {
    const ctx = await setup('plainresend@test.com');
    try {
      const contactId = await makeCustomer(ctx);
      const id = await makeInvoice(ctx, contactId, '450.00');
      await send(ctx, id);
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, '4500.00');
      await send(ctx, id);
      // Third send: the invoice is already 'sent', so nothing was re-issued —
      // this is forwarding a copy, not admitting anything. Apologising every
      // time would turn a one-off into background noise.
      await send(ctx, id);

      expect(ctx.rec.sent).toHaveLength(3);
      expect(ctx.rec.sent[2]?.subject).toMatch(/^Invoice INV-001 from /);
      expect(ctx.rec.sent[2]?.text).not.toContain('the earlier invoice was wrong');
    } finally {
      await ctx.handle.close();
    }
  });

  it('sends nothing at all when the correction is re-issued without email', async () => {
    const ctx = await setup('marksentonly@test.com');
    try {
      const contactId = await makeCustomer(ctx);
      const id = await makeInvoice(ctx, contactId, '450.00');
      await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });
      await revise(ctx, id);
      await editTotal(ctx, id, contactId, '4500.00');
      const res = await ctx.app.request(`/api/invoices/${id}/mark-sent`, {
        method: 'POST',
        headers: ctx.headers,
      });
      expect(res.status).toBe(200);

      // "Mark sent without email" is the share-a-link path — the operator is
      // handing the corrected invoice over some other way.
      expect(ctx.rec.sent).toHaveLength(0);
    } finally {
      await ctx.handle.close();
    }
  });
});

describe('the corrected-estimate email', () => {
  beforeEach(resetDb);

  it('leads with the apology and names both figures', async () => {
    const ctx = await setup('estamended@test.com');
    try {
      const contactId = await makeCustomer(ctx);
      const created = await ctx.app.request('/api/estimates', {
        method: 'POST',
        headers: ctx.headers,
        body: JSON.stringify({
          companyId: ctx.companyId,
          contactId,
          number: 'EST-001',
          issueDate: '2026-06-10',
          expiresOn: '2026-07-10',
          subtotal: '900.00',
          tax: '0.00',
          total: '900.00',
          lineItems: [
            {
              position: 1,
              description: 'Quote',
              quantity: '1',
              unitPrice: '900.00',
              amount: '900.00',
            },
          ],
        }),
      });
      const id = ((await created.json()) as { id: string }).id;
      const sendEstimate = () =>
        ctx.app.request(`/api/estimates/${id}/send`, {
          method: 'POST',
          headers: ctx.headers,
          body: '{}',
        });
      expect((await sendEstimate()).status).toBe(200);

      await ctx.app.request(`/api/estimates/${id}/revise`, {
        method: 'POST',
        headers: ctx.headers,
      });
      await ctx.app.request(`/api/estimates/${id}`, {
        method: 'PATCH',
        headers: ctx.headers,
        body: JSON.stringify({
          contactId,
          number: 'EST-001',
          issueDate: '2026-06-10',
          expiresOn: '2026-07-10',
          subtotal: '1200.00',
          tax: '0.00',
          total: '1200.00',
          lineItems: [
            {
              position: 1,
              description: 'Quote',
              quantity: '1',
              unitPrice: '1200.00',
              amount: '1200.00',
            },
          ],
        }),
      });
      expect((await sendEstimate()).status).toBe(200);

      const corrected = ctx.rec.sent[1];
      expect(corrected?.subject).toMatch(/^Corrected: Estimate EST-001 from /);
      expect(corrected?.text).toContain('Sorry, the earlier estimate was wrong.');
      expect(corrected?.text).toContain('The total changed from $900.00 to $1,200.00.');
      // The fixed "valid until" chrome still rides along under the preamble.
      expect(corrected?.html).toContain('This estimate is valid until');
    } finally {
      await ctx.handle.close();
    }
  });
});
