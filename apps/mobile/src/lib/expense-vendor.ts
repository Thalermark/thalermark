import { api } from './api';

// The VendorField's link state, mirrored from web's VendorPicker:
//   ''         → unlinked (free-text merchant)
//   <uuid>     → linked to an existing contact
//   VENDOR_NEW → create a vendor contact from the typed name on save
export const VENDOR_NEW = '__new__';

// Resolve that state to the value the expense create/update API expects. The
// caller decides whether to OMIT the field entirely (the edit form, when the
// vendor wasn't touched, so the API leaves the link + needs-review flag alone).
// A linked contact's name is mirrored into merchant by the API.
export async function resolveVendor(
  companyId: string,
  vendorRaw: string,
  merchant: string,
): Promise<{ ok: true; value: string | null } | { ok: false }> {
  if (vendorRaw === '') return { ok: true, value: null };
  if (vendorRaw === VENDOR_NEW) {
    const name = merchant.trim();
    if (!name) return { ok: true, value: null };
    const res = await api.api.contacts.$post({
      json: { companyId, name, isCustomer: false, isVendor: true },
    });
    if (!res.ok) return { ok: false };
    return { ok: true, value: (await res.json()).id };
  }
  return { ok: true, value: vendorRaw };
}
