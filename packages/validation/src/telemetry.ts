import { z } from 'zod';

// Body for PATCH /api/account/telemetry — the per-account consent toggle.
// `enabled: true` is "Yes, help improve the product"; `false` is "No thanks".
// Either answer stamps telemetry_decided_at server-side so the first-run
// prompt never reappears. See TELEMETRY.md for the consent flow.
export const telemetryUpdateSchema = z.object({
  enabled: z.boolean(),
});

export type TelemetryUpdate = z.infer<typeof telemetryUpdateSchema>;
