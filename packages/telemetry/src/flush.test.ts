import { accounts, telemetryEvents, withAccountContext } from '@thalermark/db';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAppDb, getTestDb, resetDb } from '../tests/db-test-helper.js';
import type { TransportConfig } from './config.js';
import { emit } from './emit.js';
import { flushTelemetry } from './flush.js';
import { signPayload } from './sign.js';

const BASE_CONFIG: TransportConfig = {
  enabled: true,
  endpointUrl: 'https://telemetry.example/v1/events',
  signingKey: 'test-secret',
  batchSize: 200,
  retryCap: 3,
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

async function seedRows(count: number) {
  await withAccountContext(getAppDb(), { accountId }, async (tx) => {
    for (let i = 0; i < count; i++) {
      await emit(tx, { name: 'invoice_created', line_item_count: i });
    }
  });
}

function mockFetch(response: { status: number } | Error) {
  const impl: typeof fetch = async () => {
    if (response instanceof Error) throw response;
    return new Response(null, { status: response.status });
  };
  return vi.fn(impl);
}

describe('flushTelemetry — config gating', () => {
  beforeEach(resetDb);

  it('no-ops when transport is disabled', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(2);
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(
      getAppDb(),
      accountId,
      { ...BASE_CONFIG, enabled: false },
      fetchImpl,
    );

    expect(result).toEqual({ status: 'transport_disabled' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(2);
  });

  it('no-ops when endpoint URL is unset', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(1);
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(
      getAppDb(),
      accountId,
      { ...BASE_CONFIG, endpointUrl: undefined },
      fetchImpl,
    );

    expect(result).toEqual({ status: 'endpoint_unset' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when signing key is unset', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(1);
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(
      getAppDb(),
      accountId,
      { ...BASE_CONFIG, signingKey: undefined },
      fetchImpl,
    );

    expect(result).toEqual({ status: 'signing_key_unset' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when the account is opted out', async () => {
    await seedAccount({ telemetryEnabled: false });
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'empty' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('no-ops when the queue is empty', async () => {
    await seedAccount({ telemetryEnabled: true });
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'empty' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('flushTelemetry — 2xx happy path', () => {
  beforeEach(resetDb);

  it('POSTs the batch with a signed body and deletes the rows on 2xx', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(3);
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'sent', count: 3 });
    expect(fetchImpl).toHaveBeenCalledOnce();

    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('expected one fetch call');
    const [url, init] = call;
    expect(url).toBe(BASE_CONFIG.endpointUrl);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-thalermark-signature']).toBe(
      signPayload(init?.body as string, BASE_CONFIG.signingKey ?? ''),
    );

    const body = JSON.parse(init?.body as string);
    const installId = (
      await getTestDb()
        .select({ id: accounts.telemetryInstallId })
        .from(accounts)
        .where(eq(accounts.id, accountId))
    )[0]?.id;
    expect(body.install_id).toBe(installId);
    expect(body.events).toHaveLength(3);
    expect(body.events[0]).toMatchObject({
      name: 'invoice_created',
      payload: { name: 'invoice_created', line_item_count: 0 },
    });
    expect(typeof body.events[0].occurred_at).toBe('string');

    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(0);
  });

  it('respects batch size and leaves overflow for the next call', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(5);
    const fetchImpl = mockFetch({ status: 200 });

    const result = await flushTelemetry(
      getAppDb(),
      accountId,
      { ...BASE_CONFIG, batchSize: 2 },
      fetchImpl,
    );

    expect(result).toEqual({ status: 'sent', count: 2 });
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(3);
  });

  it('does not leak other tenants into the batch', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(2);

    const otherId = uuidv7();
    await getTestDb().insert(accounts).values({
      id: otherId,
      name: 'Other',
      telemetryEnabled: true,
      telemetryInstallId: uuidv7(),
    });
    await withAccountContext(getAppDb(), { accountId: otherId }, async (tx) => {
      await emit(tx, { name: 'invoice_created', line_item_count: 99 });
    });

    const fetchImpl = mockFetch({ status: 200 });
    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'sent', count: 2 });
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string);
    expect(body.events).toHaveLength(2);
    for (const ev of body.events) {
      expect(ev.payload.line_item_count).not.toBe(99);
    }

    // The other tenant's row is still in the queue, untouched.
    const remaining = await getTestDb().select().from(telemetryEvents);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.accountId).toBe(otherId);
  });
});

describe('flushTelemetry — 4xx drops', () => {
  beforeEach(resetDb);

  it('drops the batch and logs on 4xx (un-fixable)', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(2);
    const fetchImpl = mockFetch({ status: 422 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'dropped_4xx', count: 2, statusCode: 422 });
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('flushTelemetry — 5xx / network retry', () => {
  beforeEach(resetDb);

  it('increments retry_count and last_attempt_at on 5xx', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(2);
    const fetchImpl = mockFetch({ status: 503 });

    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'retry', count: 2, dropped: 0 });
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.retryCount).toBe(1);
      expect(row.lastAttemptAt).not.toBeNull();
    }
  });

  it('increments retry_count on network error', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(1);
    const fetchImpl = mockFetch(new Error('connect ECONNREFUSED'));

    const result = await flushTelemetry(getAppDb(), accountId, BASE_CONFIG, fetchImpl);

    expect(result).toEqual({ status: 'retry', count: 1, dropped: 0 });
    const rows = await getTestDb().select().from(telemetryEvents);
    expect(rows[0]?.retryCount).toBe(1);
  });

  it('drops rows that reach the retry cap', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(1);
    const config = { ...BASE_CONFIG, retryCap: 2 };
    const fetchImpl = mockFetch({ status: 500 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First fail: retry_count 0 -> 1, still below cap.
    let result = await flushTelemetry(getAppDb(), accountId, config, fetchImpl);
    expect(result).toEqual({ status: 'retry', count: 1, dropped: 0 });
    expect((await getTestDb().select().from(telemetryEvents))[0]?.retryCount).toBe(1);

    // Second fail: retry_count 1 -> 2, hits cap, row is dropped.
    result = await flushTelemetry(getAppDb(), accountId, config, fetchImpl);
    expect(result).toEqual({ status: 'retry', count: 1, dropped: 1 });
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(0);
    expect(warn).toHaveBeenCalled();

    // Third call: nothing left to retry.
    result = await flushTelemetry(getAppDb(), accountId, config, fetchImpl);
    expect(result).toEqual({ status: 'empty' });

    warn.mockRestore();
  });

  it('excludes rows past the cap from subsequent reads', async () => {
    await seedAccount({ telemetryEnabled: true });
    await seedRows(1);
    // Force-set retry_count to cap so the SELECT in flush skips it.
    await getTestDb().update(telemetryEvents).set({ retryCount: 5 });

    const fetchImpl = mockFetch({ status: 200 });
    const result = await flushTelemetry(
      getAppDb(),
      accountId,
      { ...BASE_CONFIG, retryCap: 5 },
      fetchImpl,
    );

    expect(result).toEqual({ status: 'empty' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await getTestDb().select().from(telemetryEvents)).toHaveLength(1);
  });
});
