import { getActiveAccountId, getAuthToken } from './secure-store';
import { getServerUrl } from './server-url';

const APP_ORIGIN = 'thalermark://';

export type UploadResult = { ok: true } | { ok: false; error: string };
// Same shape with the parsed response body along for the ride — the
// photo-first endpoints (TMC-295) answer with content the caller needs (the
// extraction suggestion, the created expense), unlike the original
// attach-style uploads where 2xx was the whole answer.
export type UploadBodyResult<T> = { ok: true; body: T } | { ok: false; error: string };

type Asset = { uri: string; mimeType?: string | null; fileName?: string | null };

// Multipart upload to an api endpoint that expects a `file` field (plus any
// extra string fields). The typed hc client can't carry an RN file, and the
// SDK's global `fetch` is spec-compliant (rejects RN's { uri, name, type }
// file shim with "Unsupported FormDataPart implementation"). XMLHttpRequest
// goes through React Native's own networking, which DOES accept the shim —
// the canonical RN upload path. Same auth contract as api.ts: bearer + Origin
// + x-account-id, read from secure-store. Content-Type is left unset so RN
// generates the multipart boundary.
async function postMultipart<T>(
  path: string,
  asset: Asset,
  fallbackName: string,
  fields: Record<string, string> = {},
): Promise<UploadBodyResult<T>> {
  const token = await getAuthToken();
  const accountId = await getActiveAccountId();
  const type = asset.mimeType ?? 'image/jpeg';
  const name = asset.fileName ?? fallbackName;

  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  // RN's FormData/XHR accepts this file shim; the cast satisfies the DOM typings.
  form.append('file', { uri: asset.uri, name, type } as unknown as Blob);

  return new Promise<UploadBodyResult<T>>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getServerUrl()}${path}`);
    xhr.setRequestHeader('Origin', APP_ORIGIN);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (accountId) xhr.setRequestHeader('x-account-id', accountId);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let body: T | null = null;
        try {
          body = JSON.parse(xhr.responseText) as T;
        } catch {}
        if (body === null) {
          resolve({ ok: false, error: 'unknown' });
          return;
        }
        resolve({ ok: true, body });
        return;
      }
      let code = 'unknown';
      try {
        code = (JSON.parse(xhr.responseText) as { error?: string }).error ?? 'unknown';
      } catch {}
      resolve({ ok: false, error: code });
    };
    xhr.onerror = () => resolve({ ok: false, error: 'network' });
    xhr.send(form);
  });
}

const receiptName = (asset: Asset) =>
  `receipt.${(asset.mimeType ?? 'image/jpeg') === 'image/png' ? 'png' : 'jpg'}`;

export async function uploadReceipt(expenseId: string, asset: Asset): Promise<UploadResult> {
  const res = await postMultipart(`/api/expenses/${expenseId}/receipt`, asset, receiptName(asset));
  return res.ok ? { ok: true } : res;
}

// Photo-first (TMC-295): read a receipt that belongs to nothing yet. Returns
// the suggestion; the api persists nothing — the expense only exists when
// createExpenseWithReceipt saves it.
export type ExtractReceiptBody = {
  extraction: { merchant: string | null; total: string | null; expenseDate: string | null };
  suggestedCategoryAccountId: string | null;
};

export function extractLooseReceipt(
  companyId: string,
  asset: Asset,
): Promise<UploadBodyResult<ExtractReceiptBody>> {
  return postMultipart('/api/expenses/extract-receipt', asset, receiptName(asset), { companyId });
}

// Photo-first (TMC-295): create the expense AND attach the photo in one call —
// both-or-neither on the server, so a failed upload never leaves an expense
// claiming a receipt it does not have. `fields` are the expenseCreateSchema
// fields as strings (money is a decimal string on the wire anyway).
export function createExpenseWithReceipt(
  fields: Record<string, string>,
  asset: Asset,
): Promise<UploadBodyResult<{ id: string }>> {
  return postMultipart('/api/expenses/with-receipt', asset, receiptName(asset), fields);
}

// Company logo shown on invoices/estimates. Same endpoint shape as the receipt;
// raster-only, ≤2MB enforced server-side (file_too_large / unsupported_media_type).
export async function uploadLogo(companyId: string, asset: Asset): Promise<UploadResult> {
  const ext = (asset.mimeType ?? 'image/jpeg') === 'image/png' ? 'png' : 'jpg';
  const res = await postMultipart(`/api/companies/${companyId}/logo`, asset, `logo.${ext}`);
  return res.ok ? { ok: true } : res;
}
