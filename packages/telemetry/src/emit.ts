import { type Transaction, accounts, telemetryEvents } from '@thalermark/db';
import { v7 as uuidv7 } from 'uuid';
import { isTelemetryDisabled } from './config.js';
import type { Event } from './events.js';

// Write a telemetry event to the local staging queue. Gated by the current
// account's opt-in: if `accounts.telemetry_enabled` is false (the default)
// the call is a silent no-op. RLS scopes both the read and the write to the
// account context set by withAccountContext, so callers don't pass account_id.
//
// Without an account context set on `tx`, the accounts SELECT returns zero
// rows and the call is also a no-op — fine for system-initiated work that
// shouldn't be attributed to a tenant.
//
// TELEMETRY_DISABLED short-circuits before any DB work: a deployment that
// forbids telemetry stages nothing even if an account's opt-in flag is stale.
export async function emit(tx: Transaction, event: Event): Promise<void> {
  if (isTelemetryDisabled()) return;

  const rows = await tx
    .select({ id: accounts.id, enabled: accounts.telemetryEnabled })
    .from(accounts)
    .limit(1);
  const account = rows[0];
  if (!account?.enabled) return;

  await tx.insert(telemetryEvents).values({
    id: uuidv7(),
    accountId: account.id,
    eventName: event.name,
    payload: event,
  });
}
