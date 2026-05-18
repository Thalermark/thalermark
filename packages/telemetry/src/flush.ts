import { type Database, accounts, telemetryEvents, withAccountContext } from '@thalermark/db';
import { and, asc, gte, inArray, lt, sql } from 'drizzle-orm';
import { type TransportConfig, loadTransportConfig } from './config.js';
import { signPayload } from './sign.js';

// Discriminated result type so callers (and tests) can assert exact outcomes
// without parsing log output. Each branch covers a distinct exit path of
// flushTelemetry.
export type FlushResult =
  | { status: 'transport_disabled' }
  | { status: 'endpoint_unset' }
  | { status: 'signing_key_unset' }
  | { status: 'empty' }
  | { status: 'sent'; count: number }
  | { status: 'dropped_4xx'; count: number; statusCode: number }
  | { status: 'retry'; count: number; dropped: number };

// Drain the telemetry staging queue for one account.
//
// Lifecycle:
//   1. Short read tx (under RLS): pull install_id + a batch of pending rows
//      (those below the retry cap), oldest first, up to batch_size.
//   2. POST the batch to the configured endpoint OUTSIDE any tx — network
//      I/O must not hold a DB connection. Body is HMAC-signed.
//   3. Short write tx (under RLS): on 2xx, DELETE the batch; on 4xx, log +
//      DELETE (un-fixable, so drop). On 5xx/network, increment retry_count
//      + last_attempt_at, then DELETE any rows that hit the cap.
//
// Delivery is at-least-once: if step 2 succeeds but step 3 fails (e.g.
// process killed), the same rows can be re-sent on the next flush. The
// receiver should dedupe by event id.
//
// Mid-flight opt-out: disableTelemetry purges the queue in its own tx. If
// it runs between steps 1 and 3, our tx3 DELETE/UPDATE just affects zero
// rows (no-op). A POST may have already gone out for events emitted just
// before opt-out — acceptable: opt-out is "no FUTURE writes", and the
// just-emitted events were attributed to a since-rotated install_id.
export async function flushTelemetry(
  db: Database,
  accountId: string,
  config: TransportConfig = loadTransportConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<FlushResult> {
  if (!config.enabled) return { status: 'transport_disabled' };
  if (!config.endpointUrl) {
    console.warn('[telemetry] transport enabled but TELEMETRY_ENDPOINT_URL is unset');
    return { status: 'endpoint_unset' };
  }
  if (!config.signingKey) {
    console.warn('[telemetry] transport enabled but TELEMETRY_SIGNING_KEY is unset');
    return { status: 'signing_key_unset' };
  }

  const batch = await withAccountContext(db, { accountId }, async (tx) => {
    const acctRows = await tx
      .select({
        enabled: accounts.telemetryEnabled,
        installId: accounts.telemetryInstallId,
      })
      .from(accounts)
      .limit(1);
    const acct = acctRows[0];
    if (!acct?.enabled || !acct.installId) return null;

    const rows = await tx
      .select({
        id: telemetryEvents.id,
        eventName: telemetryEvents.eventName,
        payload: telemetryEvents.payload,
        createdAt: telemetryEvents.createdAt,
      })
      .from(telemetryEvents)
      .where(lt(telemetryEvents.retryCount, config.retryCap))
      .orderBy(asc(telemetryEvents.createdAt))
      .limit(config.batchSize);

    return rows.length > 0 ? { installId: acct.installId, rows } : null;
  });

  if (!batch) return { status: 'empty' };

  const body = JSON.stringify({
    install_id: batch.installId,
    events: batch.rows.map((r) => ({
      name: r.eventName,
      payload: r.payload,
      occurred_at: r.createdAt.toISOString(),
    })),
  });
  const signature = signPayload(body, config.signingKey);
  const ids = batch.rows.map((r) => r.id);

  let response: Response;
  try {
    response = await fetchImpl(config.endpointUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-thalermark-signature': signature,
      },
      body,
    });
  } catch (err) {
    return await applyRetry(db, accountId, ids, config.retryCap, 'network_error', err);
  }

  if (response.status >= 200 && response.status < 300) {
    await withAccountContext(db, { accountId }, async (tx) => {
      await tx.delete(telemetryEvents).where(inArray(telemetryEvents.id, ids));
    });
    return { status: 'sent', count: ids.length };
  }

  if (response.status >= 400 && response.status < 500) {
    console.warn(`[telemetry] dropping ${ids.length} events: endpoint returned ${response.status}`);
    await withAccountContext(db, { accountId }, async (tx) => {
      await tx.delete(telemetryEvents).where(inArray(telemetryEvents.id, ids));
    });
    return { status: 'dropped_4xx', count: ids.length, statusCode: response.status };
  }

  return await applyRetry(db, accountId, ids, config.retryCap, 'server_error', response.status);
}

// Fire-and-forget wrapper. The natural call site is right after a
// user-facing transaction commits — the caller wants telemetry to leave
// the host as soon as possible without blocking the response. Any error
// in the flush is logged but never propagated to the caller.
export function scheduleTelemetryFlush(db: Database, accountId: string): void {
  flushTelemetry(db, accountId).catch((err) => {
    console.error('[telemetry] flush failed', err);
  });
}

async function applyRetry(
  db: Database,
  accountId: string,
  ids: string[],
  retryCap: number,
  reason: 'network_error' | 'server_error',
  detail: unknown,
): Promise<FlushResult> {
  const droppedCount = await withAccountContext(db, { accountId }, async (tx) => {
    await tx
      .update(telemetryEvents)
      .set({
        retryCount: sql`${telemetryEvents.retryCount} + 1`,
        lastAttemptAt: new Date(),
      })
      .where(inArray(telemetryEvents.id, ids));

    const dropped = await tx
      .delete(telemetryEvents)
      .where(and(inArray(telemetryEvents.id, ids), gte(telemetryEvents.retryCount, retryCap)))
      .returning({ id: telemetryEvents.id });
    return dropped.length;
  });
  if (droppedCount > 0) {
    const detailText = detail instanceof Error ? detail.message : String(detail);
    console.warn(
      `[telemetry] dropping ${droppedCount} events at retry cap (${reason}): ${detailText}`,
    );
  }
  return { status: 'retry', count: ids.length, dropped: droppedCount };
}
