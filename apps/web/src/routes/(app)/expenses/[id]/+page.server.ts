import { apiBaseUrl, serverApiClient, serverApiHeaders } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';

type AuditEvent = {
  id: string;
  action: string;
  actorName: string;
  createdAt: string;
  before: unknown;
  after: unknown;
};

export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const expenseRes = await client.api.expenses[':id'].$get({ param: { id: event.params.id } });
  if (expenseRes.status === 404) throw error(404, 'expense not found');
  if (!expenseRes.ok) throw error(expenseRes.status, 'failed to load expense');
  const expense = await expenseRes.json();

  // Resolve the category + payment account ids to human labels. Best-effort:
  // a failed accounts fetch falls back to the raw ids rather than blanking
  // the page.
  const [expenseAccRes, assetAccRes] = await Promise.all([
    client.api.companies[':id'].accounts.$get({
      param: { id: expense.companyId },
      query: { type: 'expense' },
    }),
    client.api.companies[':id'].accounts.$get({
      param: { id: expense.companyId },
      query: { type: 'asset' },
    }),
  ]);
  const labelById = new Map<string, string>();
  if (expenseAccRes.ok) {
    for (const a of (await expenseAccRes.json()).accounts)
      labelById.set(a.id, `${a.code} · ${a.name}`);
  }
  if (assetAccRes.ok) {
    for (const a of (await assetAccRes.json()).accounts)
      labelById.set(a.id, `${a.code} · ${a.name}`);
  }

  // Audit trail (slice 8.8a pattern). Best-effort — a non-OK response renders
  // an empty history rather than failing the whole page.
  const auditRes = await client.api['audit-events'].$get({
    query: { entityType: 'expense', entityId: event.params.id },
  });
  const auditEvents = auditRes.ok
    ? ((await auditRes.json()) as { events: AuditEvent[] }).events
    : [];

  // When a receipt is attached, fetch a signed download URL so the page can
  // preview it. For s3 this is a presigned object-store URL the browser hits
  // directly; for local-FS it's a relative /api/files/<token> the api serves.
  // Best-effort — a failure just hides the preview, the record still renders.
  let receipt: { url: string; contentType: string } | null = null;
  if (expense.receiptStorageKey) {
    const rres = await client.api.expenses[':id'].receipt.$get({
      param: { id: event.params.id },
    });
    if (rres.ok) receipt = (await rres.json()) as { url: string; contentType: string };
  }

  return {
    expense,
    categoryLabel: labelById.get(expense.categoryAccountId) ?? expense.categoryAccountId,
    paymentLabel: labelById.get(expense.paymentAccountId) ?? expense.paymentAccountId,
    receipt,
    auditEvents,
  };
};

export const actions: Actions = {
  // Soft delete (the API sets deleted_at + posts a reversal). Redirect to the
  // list, where the row no longer appears.
  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.expenses[':id'].$delete({ param: { id: event.params.id } });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { deleteError: body?.error ?? 'delete_failed' });
    }
    redirect(303, '/expenses');
  },

  // Forward the multipart receipt to the api. Goes through a raw fetch rather
  // than the typed client because the hc client has no typed `form` surface
  // for this route — apiBaseUrl + serverApiHeaders reuse the same base URL and
  // auth headers the client would. FormData sets its own content-type.
  uploadReceipt: async (event) => {
    const formData = await event.request.formData();
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return fail(400, { receiptError: 'Choose a file to upload.' });
    }
    const fd = new FormData();
    fd.set('file', file);
    const res = await event.fetch(`${apiBaseUrl()}/api/expenses/${event.params.id}/receipt`, {
      method: 'POST',
      headers: serverApiHeaders(event),
      body: fd,
    });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = body?.error ?? 'upload_failed';
      const msg =
        code === 'unsupported_media_type'
          ? 'Receipts must be a JPEG, PNG, or PDF.'
          : code === 'file_too_large'
            ? 'Receipt must be under 10 MB.'
            : code === 'storage_not_configured'
              ? 'Receipt storage is not configured on this server.'
              : code;
      return fail(res.status, { receiptError: msg });
    }
    redirect(303, `/expenses/${event.params.id}`);
  },

  deleteReceipt: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.expenses[':id'].receipt.$delete({
      param: { id: event.params.id },
    });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { receiptError: body?.error ?? 'delete_failed' });
    }
    redirect(303, `/expenses/${event.params.id}`);
  },
};
