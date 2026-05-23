import { z } from 'zod';

// Input schema for POST /api/customers. accountId is inferred from the
// rls-context middleware (x-account-id header); the client only supplies
// the company scope and the visible fields. Address is flat — the
// Mapbox/Nominatim autocomplete (packages/location, deferred) will map its
// structured response 1:1 onto these columns.
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
