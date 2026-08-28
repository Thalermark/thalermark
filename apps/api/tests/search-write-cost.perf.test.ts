import { randomUUID } from 'node:crypto';
import { contacts, memberships } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Env } from '../src/env.js';
import { createApiAuth } from '../src/lib/auth.js';
import { createApiDatabase } from '../src/lib/db.js';
import { reindexEntities } from '../src/lib/search/reindex.js';
import { appDatabaseUrl, getTestDb, resetDb } from './test-helper.js';

// What does keeping search fresh actually cost a save? (TMC-205)
//
// Global search reprojects an entity inside the same transaction as the
// mutation, so saving an invoice also re-reads that invoice with its contact,
// re-reads its line items, and upserts one search_documents row. The ticket
// asks whether that is perceptible before anyone changes the design, because
// the alternative (moving it post-commit) buys response time by spending a
// second pool checkout, and would look free if you only timed the response.
//
// OPT-IN, same as reports-at-scale — this is a tool for answering "did that
// change make saving slower?", not a per-commit gate:
//
//     SCALE_TEST=1 pnpm --filter @thalermark/api test search-write-cost
//
// WHAT THIS CAN AND CANNOT SAY. It measures the projector's share of a save on
// an idle, single-connection database. That is the honest lower bound on the
// benefit of removing it. It CANNOT measure pool-wait time, which is the thing
// that decides between shapes B and C — one process against a warm local
// Postgres has no contention to observe, and a benchmark that pretends
// otherwise would argue for B on evidence it does not have.
const SCALE = process.env.SCALE_TEST === '1';
const ITERATIONS = 40;

const testEnv: Env = {
  nodeEnv: 'test',
  port: 3000,
  logLevel: 'error',
  errorTrackingDsn: undefined,
  release: undefined,
  databaseUrl: '',
  appDatabaseUrl: '',
  appRolePassword: undefined,
  migrateOnBoot: false,
  betterAuthSecret: 'test-secret-at-least-32-characters-long',
  betterAuthUrl: 'http://localhost:3000',
  trustedOrigins: [],
  publicAppUrl: '',
  resendApiKey: undefined,
  emailFrom: 'Thalermark <test@thalermark.test>',
  stripeSecretKey: undefined,
  stripePublishableKey: undefined,
  stripeWebhookSecret: undefined,
  recurringSweepCron: '0 6 * * *',
};

function cookieOf(res: Response): string {
  const list =
    (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [res.headers.get('set-cookie') ?? ''].filter(Boolean);
  return list.map((c) => c.split(';')[0]).join('; ');
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return 0;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

describe.skipIf(!SCALE)('search reprojection: what it costs a save', () => {
  it('reports the projector share of an invoice save', async () => {
    await resetDb();
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL not set');
    const handle = createApiDatabase(appDatabaseUrl());
    const auth = createApiAuth(getTestDb(), { ...testEnv, databaseUrl: url });
    const app = createApp({ auth, db: handle.db, bootstrapDb: getTestDb() });

    try {
      const signUpRes = await app.request('/api/auth/sign-up/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'perf@example.com',
          password: 'correct horse battery staple',
          name: 'Perf',
        }),
      });
      const cookie = cookieOf(signUpRes);
      const db = getTestDb();
      const [m] = await db.select().from(memberships).limit(1);
      const accountId = m?.accountId as string;
      const h = { cookie, 'x-account-id': accountId, 'content-type': 'application/json' };

      const companiesRes = await app.request('/api/companies', { headers: h });
      const { companies } = (await companiesRes.json()) as { companies: { id: string }[] };
      const companyId = companies[0]?.id as string;

      const contactRes = await app.request('/api/contacts', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, name: 'Halvorsen Property Group' }),
      });
      const contactId = ((await contactRes.json()) as { id: string }).id;

      // Ten line items: enough that the projector's separate line-item read is
      // doing real work rather than hitting an empty set.
      const lineItems = Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        description: `Spring cleanup, visit ${i + 1}`,
        quantity: '1',
        unitPrice: '150.00',
        amount: '150.00',
      }));
      const invoiceRes = await app.request('/api/invoices', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({
          companyId,
          contactId,
          number: `INV-${randomUUID().slice(0, 8)}`,
          issueDate: '2026-03-01',
          dueDate: '2026-03-31',
          subtotal: '1500.00',
          tax: '0.00',
          total: '1500.00',
          lineItems,
        }),
      });
      const invoiceId = ((await invoiceRes.json()) as { id: string }).id;

      // The update schema is the create schema minus companyId, so a save sends
      // the WHOLE document — which is what a real one does, and is the shape
      // whose cost is being measured.
      const savePayload = (note: string) =>
        JSON.stringify({
          contactId,
          number: `INV-${randomUUID().slice(0, 8)}`,
          issueDate: '2026-03-01',
          dueDate: '2026-03-31',
          subtotal: '1500.00',
          tax: '0.00',
          total: '1500.00',
          notes: note,
          lineItems,
        });

      // Warm up: first calls pay for plan caching and connection setup, and
      // would otherwise land entirely in the "save" column and flatter the
      // projector.
      for (let i = 0; i < 5; i++) {
        const warm = await app.request(`/api/invoices/${invoiceId}`, {
          method: 'PATCH',
          headers: h,
          body: savePayload(`warmup ${i}`),
        });
        if (warm.status !== 200) {
          throw new Error(`warmup PATCH failed: ${warm.status} ${await warm.text()}`);
        }
      }

      // A. The whole save, through the real HTTP surface, reprojection included.
      const saves: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        const res = await app.request(`/api/invoices/${invoiceId}`, {
          method: 'PATCH',
          headers: h,
          body: savePayload(`measured ${i}`),
        });
        saves.push(performance.now() - t0);
        expect(res.status).toBe(200);
      }

      // B. The reprojection alone, against the same row, on an already-open
      // connection — exactly how it runs inside the save.
      const reindexes: number[] = [];
      for (let i = 0; i < ITERATIONS; i++) {
        const t0 = performance.now();
        await handle.db.transaction(async (tx) => {
          await reindexEntities(tx, accountId, [{ entityType: 'invoice', entityId: invoiceId }]);
        });
        reindexes.push(performance.now() - t0);
      }

      const saveMed = median(saves);
      const reindexMed = median(reindexes);
      const share = (reindexMed / saveMed) * 100;

      // process.stdout directly: vitest captures console in this project's
      // fork pool and the numbers are the entire point of the test.
      process.stdout.write(
        [
          '',
          `TMC-205 — invoice save, ${ITERATIONS} iterations, 10 line items`,
          `  save (PATCH, incl. reprojection)  median ${saveMed.toFixed(1)}ms  p95 ${percentile(saves, 95).toFixed(1)}ms`,
          `  reprojection alone                median ${reindexMed.toFixed(1)}ms  p95 ${percentile(reindexes, 95).toFixed(1)}ms`,
          `  projector share of a save         ~${share.toFixed(0)}%`,
          '',
          '  Idle single-connection Postgres. No pool contention is measured, so',
          '  this is the LOWER bound on what removing it could buy, and it says',
          '  nothing about shape B, whose cost is a second pool checkout.',
          '',
        ].join('\n'),
      );

      // Not a threshold on the number — machines differ and this is a
      // measurement tool. It asserts only that the measurement is meaningful:
      // both phases ran and produced sane timings.
      expect(saves).toHaveLength(ITERATIONS);
      expect(reindexMed).toBeGreaterThan(0);
      expect(saveMed).toBeGreaterThan(reindexMed);
      // The worst case the ticket names: a bulk import, where one transaction
      // notes hundreds of entities and the projector runs over all of them at
      // once. Different in kind from a single save — the per-row cost is
      // amortised across one chunked query rather than paid per request.
      const ROWS = 500;
      const rows = Array.from({ length: ROWS }, (_, i) => ({
        name: `Imported Customer ${i}`,
        email: `imported${i}@example.com`,
      }));
      const tImport0 = performance.now();
      const importRes = await app.request('/api/contacts/import', {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ companyId, rows }),
      });
      const importMs = performance.now() - tImport0;

      if (importRes.status === 200 || importRes.status === 201) {
        const imported = await getTestDb()
          .select({ id: contacts.id })
          .from(contacts)
          .where(eq(contacts.companyId, companyId))
          .limit(ROWS);
        const keys = imported.map((r) => ({ entityType: 'contact' as const, entityId: r.id }));
        const tRe0 = performance.now();
        await handle.db.transaction(async (tx) => {
          await reindexEntities(tx, accountId, keys);
        });
        const reMs = performance.now() - tRe0;
        process.stdout.write(
          [
            '',
            `TMC-205 — bulk import, ${ROWS} contacts`,
            `  import (incl. reprojection)       ${importMs.toFixed(0)}ms`,
            `  reprojecting ${String(keys.length).padStart(3)} rows alone         ${reMs.toFixed(0)}ms`,
            `  projector share of the import     ~${((reMs / importMs) * 100).toFixed(0)}%`,
            '',
          ].join('\n'),
        );
      } else {
        process.stdout.write(
          `\nTMC-205 — bulk import NOT measured: /api/contacts/import returned ${importRes.status}\n\n`,
        );
      }
    } finally {
      await handle.close();
    }
  });
});
