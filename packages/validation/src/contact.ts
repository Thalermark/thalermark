import { z } from 'zod';

// Input schema for POST /api/contacts. accountId is inferred from the
// rls-context middleware (x-account-id header); the client only supplies
// the company scope and the visible fields. Address is flat — the
// Mapbox/Census autocomplete in @thalermark/location maps its structured
// response 1:1 onto these columns.
//
// is_customer / is_vendor are the role flags (Xero-style: one contact can act
// as both). Optional on the wire — the server applies the table defaults
// (customer true, vendor false) when omitted, so the inline "add customer"
// flow on the invoice/estimate forms needn't send them.
export const contactCreateSchema = z.object({
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
  isCustomer: z.boolean().optional(),
  isVendor: z.boolean().optional(),
});

export type ContactCreateInput = z.infer<typeof contactCreateSchema>;

// Input schema for PATCH /api/contacts/:id. Same shape as create minus
// companyId — a contact cannot move between companies because their
// invoices are scoped to the original company (would invalidate the
// invoice↔contact↔company invariant the create endpoint enforces). The
// edit form re-submits every field, so undefined optionals clear the
// existing value rather than leaving it untouched; this keeps the wire
// format symmetric with create and avoids the "did the user mean blank or
// unchanged" ambiguity of sparse PATCH.
export const contactUpdateSchema = contactCreateSchema.omit({ companyId: true });

export type ContactUpdateInput = z.infer<typeof contactUpdateSchema>;
