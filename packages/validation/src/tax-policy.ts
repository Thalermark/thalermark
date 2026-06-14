import { z } from 'zod';
import { taxRateString } from './money.js';

// Input schema for POST /api/tax-policies. accountId comes from the rls-context
// middleware (x-account-id header); the client supplies the company scope and
// the visible policy fields. ratePct rides the wire as a percent decimal string
// (see taxRateString in money.ts) and is optional — the DB defaults rate_pct to
// '0'. isDefault marks the policy auto-applied to new taxable lines; the server
// clears the flag on the company's other policies in the same tx. archived_at
// is not settable here; archive/restore are dedicated transitions (no DELETE
// endpoint), mirroring items.
export const taxPolicyCreateSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).max(200),
  ratePct: taxRateString.optional(),
  isDefault: z.boolean().optional(),
});

export type TaxPolicyCreateInput = z.infer<typeof taxPolicyCreateSchema>;

// Input schema for PATCH /api/tax-policies/:id. Same shape as create minus
// companyId — a policy cannot move between companies (its breadcrumbs on
// historical lines are scoped to the original company). Full-replacement like
// itemUpdate: the edit form re-submits every field.
export const taxPolicyUpdateSchema = taxPolicyCreateSchema.omit({ companyId: true });

export type TaxPolicyUpdateInput = z.infer<typeof taxPolicyUpdateSchema>;
