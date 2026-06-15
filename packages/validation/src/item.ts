import { z } from 'zod';
import { moneyString, quantityString } from './money.js';

// Product (goods) vs service (labor). Lives here as the canonical home — the
// catalog item carries it and each line copies it as a snapshot (the invoice /
// estimate / recurring line schemas reuse this enum). Drives the hidden ledger
// revenue split (Service Revenue 4000 vs Product Revenue 4100) at posting.
// Defaults to 'service' server-side when omitted.
export const LINE_ITEM_TYPES = ['product', 'service'] as const;
export const lineItemType = z.enum(LINE_ITEM_TYPES);
export type LineItemType = z.infer<typeof lineItemType>;

// Input schema for POST /api/items. accountId comes from the rls-context
// middleware (x-account-id header); the client supplies the company scope and
// the visible catalog fields. unitPrice / defaultQuantity ride the wire as
// decimal strings like every other money/quantity field (see money.ts) and are
// optional on the wire — the DB defaults unit_price to '0' and
// default_quantity to '1'. archived_at is not settable here; archive/restore
// are dedicated transitions (no DELETE endpoint).
export const itemCreateSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  // product | service. Optional on the wire — the DB defaults to 'service'.
  // Copied onto a picked line; drives the ledger revenue split. See lineItemType.
  type: lineItemType.optional(),
  unitPrice: moneyString.optional(),
  unitLabel: z.string().max(50).optional(),
  defaultQuantity: quantityString.optional(),
  // Whether picking this item onto a line defaults that line to taxable, and
  // under which company tax policy. Both optional — the DB defaults taxable to
  // false; taxPolicyId may be null even when taxable (the line then falls back
  // to the company default policy). Provenance + default, never re-derived.
  taxable: z.boolean().optional(),
  taxPolicyId: z.string().uuid().optional(),
});

export type ItemCreateInput = z.infer<typeof itemCreateSchema>;

// Input schema for PATCH /api/items/:id. Same shape as create minus companyId
// — an item cannot move between companies (its sales-history breadcrumbs are
// scoped to the original company). Full-replacement like customerUpdate: the
// edit form re-submits every field, so undefined optionals clear the value.
export const itemUpdateSchema = itemCreateSchema.omit({ companyId: true });

export type ItemUpdateInput = z.infer<typeof itemUpdateSchema>;
