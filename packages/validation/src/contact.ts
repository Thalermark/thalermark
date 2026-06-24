import { z } from 'zod';

// Input schema for POST /api/customers. accountId is inferred from the
// rls-context middleware (x-account-id header); the client only supplies
// the company scope and the visible fields. Address is flat — the
// Mapbox/Nominatim autocomplete in @thalermark/location maps its structured
// response 1:1 onto these columns.
export const customerCreateSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(50).optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  // ISO 3166-1 alpha-2; not strictly enforced here so self-hosters serving
  // non-US jurisdictions can use whatever country codes their locale needs.
  country: z.string().max(2).optional(),
  notes: z.string().max(5000).optional(),
});

export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;

// Input schema for PATCH /api/customers/:id. Same shape as create minus
// companyId — a customer cannot move between companies because their
// invoices are scoped to the original company (would invalidate the
// invoice↔customer↔company invariant the create endpoint enforces). The
// edit form re-submits every field, so undefined optionals clear the
// existing value rather than leaving it untouched; this keeps the wire
// format symmetric with create and avoids the "did the user mean blank or
// unchanged" ambiguity of sparse PATCH.
export const customerUpdateSchema = customerCreateSchema.omit({ companyId: true });

export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;
