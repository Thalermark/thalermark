import { type Transaction, accounts, telemetryEvents } from '@thalermark/db';
import { v7 as uuidv7 } from 'uuid';

// Per-account telemetry opt-in/out. Both helpers operate on the current
// account context (RLS scopes the UPDATE/DELETE to one row).
//
// Each opt-in generates a fresh `telemetry_install_id` so subsequent events
// cannot be correlated with any pre-opt-out history. Opt-out purges the
// staging queue immediately — events accumulated under the prior install_id
// must never be sent.

export async function enableTelemetry(tx: Transaction): Promise<void> {
  await tx.update(accounts).set({
    telemetryEnabled: true,
    telemetryInstallId: uuidv7(),
  });
}

export async function disableTelemetry(tx: Transaction): Promise<void> {
  await tx.delete(telemetryEvents);
  await tx.update(accounts).set({
    telemetryEnabled: false,
    telemetryInstallId: null,
  });
}
