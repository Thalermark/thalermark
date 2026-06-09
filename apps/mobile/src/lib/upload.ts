import { getActiveAccountId, getAuthToken } from './secure-store';

const baseUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const APP_ORIGIN = 'thalermark://';

export type UploadResult = { ok: true } | { ok: false; error: string };

type Asset = { uri: string; mimeType?: string | null; fileName?: string | null };

// Multipart upload to an api endpoint that expects a single `file` field. The
// typed hc client can't carry an RN file, and the SDK's global `fetch` is
// spec-compliant (rejects RN's { uri, name, type } file shim with "Unsupported
// FormDataPart implementation"). XMLHttpRequest goes through React Native's own
// networking, which DOES accept the shim — the canonical RN upload path. Same
// auth contract as api.ts: bearer + Origin + x-account-id, read from
// secure-store. Content-Type is left unset so RN generates the multipart
// boundary.
async function postMultipart(
  path: string,
  asset: Asset,
  fallbackName: string,
): Promise<UploadResult> {
  const token = await getAuthToken();
  const accountId = await getActiveAccountId();
  const type = asset.mimeType ?? 'image/jpeg';
  const name = asset.fileName ?? fallbackName;

  const form = new FormData();
  // RN's FormData/XHR accepts this file shim; the cast satisfies the DOM typings.
  form.append('file', { uri: asset.uri, name, type } as unknown as Blob);

  return new Promise<UploadResult>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}${path}`);
    xhr.setRequestHeader('Origin', APP_ORIGIN);
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    if (accountId) xhr.setRequestHeader('x-account-id', accountId);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ ok: true });
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

export function uploadReceipt(expenseId: string, asset: Asset): Promise<UploadResult> {
  const ext = (asset.mimeType ?? 'image/jpeg') === 'image/png' ? 'png' : 'jpg';
  return postMultipart(`/api/expenses/${expenseId}/receipt`, asset, `receipt.${ext}`);
}

// Company logo shown on invoices/estimates. Same endpoint shape as the receipt;
// raster-only, ≤2MB enforced server-side (file_too_large / unsupported_media_type).
export function uploadLogo(companyId: string, asset: Asset): Promise<UploadResult> {
  const ext = (asset.mimeType ?? 'image/jpeg') === 'image/png' ? 'png' : 'jpg';
  return postMultipart(`/api/companies/${companyId}/logo`, asset, `logo.${ext}`);
}
