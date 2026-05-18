import { accounts, telemetryEvents, withAccountContext } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAppDb, getTestDb, resetDb } from '../tests/db-test-helper.js';
import { emit } from './emit.js';
import type { Event, EventName } from './events.js';
import { disableTelemetry, enableTelemetry } from './opt-in.js';

// One canonical example per event name. The Record<EventName, Event> typing
// makes adding an event to the union without a fixture a compile error.
const SAMPLES: Record<EventName, Event> = {
  session_start: { name: 'session_start', deployment_type: 'cloud', product_version: '0.1.0' },
  session_end: { name: 'session_end', duration_seconds: 60 },
  invoice_created: { name: 'invoice_created', line_item_count: 3 },
  invoice_sent: { name: 'invoice_sent', delivery_method: 'email' },
  invoice_marked_paid: { name: 'invoice_marked_paid' },
  expense_logged: { name: 'expense_logged', has_receipt_attached: true },
  expense_categorised: { name: 'expense_categorised', method: 'ai_suggested' },
  report_viewed: { name: 'report_viewed', report_type: 'income' },
  client_created: { name: 'client_created' },
  company_created: { name: 'company_created' },
  estimate_created: { name: 'estimate_created' },
  estimate_converted: { name: 'estimate_converted' },
  ai_insight_viewed: { name: 'ai_insight_viewed', insight_type: 'cashflow' },
  ai_insight_dismissed: { name: 'ai_insight_dismissed', insight_type: 'anomaly' },
  ai_query_submitted: { name: 'ai_query_submitted', query_length_bucket: 'short' },
  ai_suggestion_accepted: { name: 'ai_suggestion_accepted', suggestion_type: 'category' },
  ai_suggestion_rejected: { name: 'ai_suggestion_rejected', suggestion_type: 'client' },
  onboarding_step_completed: { name: 'onboarding_step_completed', step: 'first_invoice' },
  onboarding_abandoned: { name: 'onboarding_abandoned', last_completed_step: 'company_setup' },
  invoice_flow_abandoned: { name: 'invoice_flow_abandoned', step_reached: 'line_items' },
  expense_flow_abandoned: { name: 'expense_flow_abandoned', step_reached: 'receipt' },
  page_load_time: { name: 'page_load_time', page: 'dashboard', duration_ms: 200 },
  api_response_time: { name: 'api_response_time', endpoint_category: 'invoices', duration_ms: 100 },
  error_occurred: {
    name: 'error_occurred',
    error_code: 'E_OCR_TIMEOUT',
    component: 'receipts',
    product_version: '0.1.0',
  },
};

let accountId: string;

async function seedAccount(opts: { telemetryEnabled?: boolean } = {}) {
  accountId = uuidv7();
  await getTestDb()
    .insert(accounts)
    .values({
      id: accountId,
      name: 'Acct',
      telemetryEnabled: opts.telemetryEnabled ?? false,
      telemetryInstallId: opts.telemetryEnabled ? uuidv7() : null,
    });
}

describe('emit — opt-in gating', () => {
  beforeEach(resetDb);

  it('is a no-op when the account has not opted in (default)', async () => {
    await seedAccount();
    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 3 });
    });
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows).toEqual([]);
  });

  it('writes a row when the account has opted in', async () => {
    await seedAccount({ telemetryEnabled: true });
    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 3 });
    });
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountId).toBe(accountId);
    expect(rows[0]?.eventName).toBe('invoice_created');
    expect(rows[0]?.payload).toEqual({ name: 'invoice_created', line_item_count: 3 });
  });

  it('is a no-op when invoked without an account context', async () => {
    await seedAccount({ telemetryEnabled: true });
    // No withAccountContext — emit's SELECT returns zero rows under RLS.
    await getAppDb().transaction(async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 3 });
    });
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows).toEqual([]);
  });

  it('round-trips every event variant through jsonb without loss', async () => {
    await seedAccount({ telemetryEnabled: true });
    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      for (const event of Object.values(SAMPLES)) {
        await emit(tx, event);
      }
    });
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows).toHaveLength(Object.keys(SAMPLES).length);
    for (const row of rows) {
      const original = SAMPLES[row.eventName as EventName];
      expect(row.payload).toEqual(original);
    }
  });
});

describe('enableTelemetry / disableTelemetry', () => {
  beforeEach(resetDb);

  it('enable sets telemetry_enabled and populates a fresh install_id', async () => {
    await seedAccount();
    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await enableTelemetry(tx);
    });
    const rows = await getTestDb().select().from(accounts).where(eq(accounts.id, accountId));
    expect(rows[0]?.telemetryEnabled).toBe(true);
    expect(rows[0]?.telemetryInstallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('enable rotates the install_id on re-opt-in (fresh "install")', async () => {
    await seedAccount();
    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await enableTelemetry(tx);
    });
    const firstId = (
      await getTestDb()
        .select({ id: accounts.telemetryInstallId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
    )[0]?.id;

    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await disableTelemetry(tx);
      await enableTelemetry(tx);
    });
    const secondId = (
      await getTestDb()
        .select({ id: accounts.telemetryInstallId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
    )[0]?.id;

    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(firstId);
  });

  it('disable purges the staging queue and clears opt-in state', async () => {
    await seedAccount({ telemetryEnabled: true });
    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 1 });
      await emit(tx, { name: 'invoice_created', line_item_count: 2 });
    });
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(2);

    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await disableTelemetry(tx);
    });

    expect(await getTestDb().select().from(telemetryEvents)).toEqual([]);
    const account = (
      await getTestDb().select().from(accounts).where(eq(accounts.id, accountId))
    )[0];
    expect(account?.telemetryEnabled).toBe(false);
    expect(account?.telemetryInstallId).toBeNull();
  });

  it('disable only purges the calling account, not others', async () => {
    await seedAccount({ telemetryEnabled: true });
    const otherAccountId = uuidv7();
    await getTestDb().insert(accounts).values({
      id: otherAccountId,
      name: 'Other',
      telemetryEnabled: true,
      telemetryInstallId: uuidv7(),
    });

    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 1 });
    });
    await withAccountContext(getAppDb(), { accountId: otherAccountId }, async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 7 });
    });
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(2);

    await withAccountContext(getAppDb(), { accountId }, async (tx) => {
      await disableTelemetry(tx);
    });

    const remaining = await getTestDb().select().from(telemetryEvents);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.accountId).toBe(otherAccountId);
  });
});
