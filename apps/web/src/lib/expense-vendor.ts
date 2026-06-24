import type { serverApiClient } from '$lib/api.server';

// The hidden `vendorContactId` field the VendorPicker posts carries one of four
// states; this maps it to the value the expense create/update API expects:
//
//   '__unchanged__' → undefined  (the field was never touched — the API leaves
//                                  the link AND the needs-review flag alone, so
//                                  an unrelated edit can't resurrect a dismiss)
//   ''              → null       (actively cleared → unlink to free-text)
//   '__new__'       → create a vendor contact from the typed name, return its id
//   <uuid>          → that id    (link an existing contact; the API validates)
//
// Returns `value: undefined` to OMIT vendorContactId from the payload entirely
// (the create/update schema treats undefined as "not provided").
export const VENDOR_UNCHANGED = '__unchanged__';
export const VENDOR_NEW = '__new__';

type Client = ReturnType<typeof serverApiClient>;

export async function resolveVendorField(
  client: Client,
  companyId: string,
  vendorRaw: string,
  merchant: string,
): Promise<{ ok: true; value: string | null | undefined } | { ok: false; error: string }> {
  if (vendorRaw === VENDOR_UNCHANGED || vendorRaw === '') {
    return { ok: true, value: vendorRaw === '' ? null : undefined };
  }
  if (vendorRaw === VENDOR_NEW) {
    const name = merchant.trim();
    if (!name) return { ok: true, value: null };
    // Inline "Add vendor": create a vendor-role contact (not a customer) and
    // link it. The API mirrors the name back into merchant on link.
    const res = await client.api.contacts.$post({
      json: { companyId, name, isCustomer: false, isVendor: true },
    });
    if (!res.ok) return { ok: false, error: 'vendor_create_failed' };
    return { ok: true, value: (await res.json()).id };
  }
  // A contact UUID picked from the type-ahead — the API validates it belongs to
  // the account + company.
  return { ok: true, value: vendorRaw };
}
