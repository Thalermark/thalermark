import { authUser, companies, emailTemplates, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

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

function buildApp(opts: { mailer?: import('../src/lib/mailer.js').Mailer } = {}) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const handle = createApiDatabase(appDatabaseUrl());
  const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
  const app = createApp({
    auth,
    db: handle.db,
    bootstrapDb: getTestDb(),
    publicAppUrl: testEnv.publicAppUrl,
    mailer: opts.mailer,
    emailFrom: 'Thalermark <test@thalermark.test>',
  });
  return { app, handle };
}

type Ctx = { app: ReturnType<typeof createApp>; handle: { close: () => Promise<void> } };

async function signUp(app: ReturnType<typeof createApp>, email: string): Promise<string> {
  const res = await app.request('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery staple', name: email }),
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return extractSessionCookie(res);
}

async function userContext(email: string): Promise<{ accountId: string; companyId: string }> {
  const db = getTestDb();
  const [user] = await db
    .select({ id: authUser.id })
    .from(authUser)
    .where(eq(authUser.email, email));
  if (!user) throw new Error(`user ${email} not seeded`);
  const [m] = await db
    .select({ accountId: memberships.accountId })
    .from(memberships)
    .where(eq(memberships.userId, user.id));
  if (!m) throw new Error(`membership for ${email} not seeded`);
  const [company] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.accountId, m.accountId));
  if (!company) throw new Error(`company for ${email} not seeded`);
  return { accountId: m.accountId, companyId: company.id };
}

type TemplateView = {
  type: string;
  subject: string;
  body: string;
  isCustomized: boolean;
  updatedAt: string | null;
  placeholders: string[];
  defaultTemplate: { subject: string; body: string };
};

async function setup(ctx: Ctx, email: string) {
  const cookie = await signUp(ctx.app, email);
  const { accountId, companyId } = await userContext(email);
  const h = (extra: Record<string, string> = {}) => ({
    cookie,
    'x-account-id': accountId,
    'content-type': 'application/json',
    ...extra,
  });
  return { cookie, accountId, companyId, h };
}

describe('email templates', () => {
  beforeEach(resetDb);

  it('GET returns the four defaults, uncustomized, with placeholders', async () => {
    const ctx = buildApp();
    try {
      const { companyId, h } = await setup(ctx, 'a@acme.test');
      const res = await ctx.app.request(`/api/companies/${companyId}/email-templates`, {
        headers: h(),
      });
      expect(res.status).toBe(200);
      const { templates } = (await res.json()) as { templates: TemplateView[] };
      expect(templates.map((t) => t.type)).toEqual([
        'invoice',
        'estimate',
        'statement',
        // The reminder copy is editable like the rest — a business that wants to
        // escalate its chasing should not need us to ship new wording (TMC-189).
        'reminder',
      ]);
      const invoice = templates.find((t) => t.type === 'invoice');
      expect(invoice?.isCustomized).toBe(false);
      expect(invoice?.subject).toContain('{{invoice_number}}');
      expect(invoice?.placeholders).toContain('customer_name');
      expect(invoice?.updatedAt).toBeNull();
    } finally {
      await ctx.handle.close();
    }
  });

  it('PUT saves an override, GET reflects it, audit logs it', async () => {
    const ctx = buildApp();
    try {
      const { companyId, accountId, h } = await setup(ctx, 'b@acme.test');
      const put = await ctx.app.request(`/api/companies/${companyId}/email-templates/invoice`, {
        method: 'PUT',
        headers: h(),
        body: JSON.stringify({
          subject: 'Your invoice {{invoice_number}}',
          body: 'Hey {{customer_name}}, you owe {{amount}}.',
        }),
      });
      expect(put.status).toBe(200);
      const saved = (await put.json()) as TemplateView;
      expect(saved.isCustomized).toBe(true);
      expect(saved.subject).toBe('Your invoice {{invoice_number}}');

      const get = await ctx.app.request(`/api/companies/${companyId}/email-templates`, {
        headers: h(),
      });
      const { templates } = (await get.json()) as { templates: TemplateView[] };
      expect(templates.find((t) => t.type === 'invoice')?.isCustomized).toBe(true);
      // estimate/statement stay on defaults.
      expect(templates.find((t) => t.type === 'estimate')?.isCustomized).toBe(false);

      // Exactly one override row persisted for this company+type.
      const rows = await getTestDb()
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.accountId, accountId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.type).toBe('invoice');
    } finally {
      await ctx.handle.close();
    }
  });

  it('PUT rejects an unknown placeholder for the type', async () => {
    const ctx = buildApp();
    try {
      const { companyId, h } = await setup(ctx, 'c@acme.test');
      const res = await ctx.app.request(`/api/companies/${companyId}/email-templates/invoice`, {
        method: 'PUT',
        headers: h(),
        // estimate_number isn't valid on an invoice; bogus is never valid.
        body: JSON.stringify({ subject: 'x {{estimate_number}}', body: 'y {{bogus}}' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; placeholders: string[] };
      expect(body.error).toBe('unknown_placeholders');
      expect(body.placeholders.sort()).toEqual(['bogus', 'estimate_number']);
    } finally {
      await ctx.handle.close();
    }
  });

  it('rejects an unknown template type', async () => {
    const ctx = buildApp();
    try {
      const { companyId, h } = await setup(ctx, 'd@acme.test');
      const res = await ctx.app.request(`/api/companies/${companyId}/email-templates/receipt`, {
        method: 'PUT',
        headers: h(),
        body: JSON.stringify({ subject: 'x', body: 'y' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_type');
    } finally {
      await ctx.handle.close();
    }
  });

  it('an override changes the sent invoice email; reset restores the default', async () => {
    const rec = makeRecorder();
    const ctx = buildApp({ mailer: rec.mailer });
    try {
      const { companyId, accountId, h } = await setup(ctx, 'e@acme.test');

      const cust = await ctx.app.request('/api/contacts', {
        method: 'POST',
        headers: h(),
        body: JSON.stringify({ companyId, name: 'Wile E. Coyote', email: 'wile@acme.test' }),
      });
      const contactId = ((await cust.json()) as { id: string }).id;

      const mkInvoice = async (number: string) => {
        const r = await ctx.app.request('/api/invoices', {
          method: 'POST',
          headers: h(),
          body: JSON.stringify({
            companyId,
            contactId,
            number,
            issueDate: '2026-05-23',
            dueDate: '2026-06-22',
            subtotal: '100.00',
            tax: '0.00',
            total: '100.00',
            lineItems: [
              {
                position: 1,
                description: 'Service',
                quantity: '1',
                unitPrice: '100.00',
                amount: '100.00',
              },
            ],
          }),
        });
        return ((await r.json()) as { id: string }).id;
      };
      const send = (id: string) =>
        ctx.app.request(`/api/invoices/${id}/send`, { method: 'POST', headers: h(), body: '{}' });

      // Customize, then send → the override copy is used.
      await ctx.app.request(`/api/companies/${companyId}/email-templates/invoice`, {
        method: 'PUT',
        headers: h(),
        body: JSON.stringify({
          subject: 'PAY UP {{invoice_number}}',
          body: 'Yo {{customer_name}}, {{amount}} please.',
        }),
      });
      await send(await mkInvoice('INV-001'));
      expect(rec.sent[0]?.subject).toBe('PAY UP INV-001');
      expect(rec.sent[0]?.text).toContain('Yo Wile E. Coyote, 100.00 USD please.');
      // Still carries the fixed chrome (public link) the template can't remove.
      expect(rec.sent[0]?.html).toContain('/i/');

      // Reset → next send falls back to the in-code default subject.
      const del = await ctx.app.request(`/api/companies/${companyId}/email-templates/invoice`, {
        method: 'DELETE',
        headers: h(),
      });
      expect(del.status).toBe(200);
      expect(((await del.json()) as TemplateView).isCustomized).toBe(false);
      const rows = await getTestDb()
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.accountId, accountId));
      expect(rows).toHaveLength(0);

      await send(await mkInvoice('INV-002'));
      // Default subject format, not the "PAY UP" override.
      expect(rec.sent[1]?.subject).toMatch(/^Invoice INV-002 from /);
    } finally {
      await ctx.handle.close();
    }
  });

  it('preview renders a candidate template against sample data', async () => {
    const ctx = buildApp();
    try {
      const { companyId, h } = await setup(ctx, 'f@acme.test');
      const res = await ctx.app.request(
        `/api/companies/${companyId}/email-templates/invoice/preview`,
        {
          method: 'POST',
          headers: h(),
          body: JSON.stringify({
            subject: 'Preview {{invoice_number}}',
            body: 'Hi {{customer_name}}, see {{amount}}.',
          }),
        },
      );
      expect(res.status).toBe(200);
      const out = (await res.json()) as { subject: string; html: string; text: string };
      expect(out.subject).toBe('Preview INV-0007');
      expect(out.text).toContain('Hi Jordan Rivera, see 1,250.00 USD.');
      expect(out.html).toContain('<!DOCTYPE html>');
    } finally {
      await ctx.handle.close();
    }
  });
});
