import { apiErrorMessage } from '$lib/api-errors';
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

  // Job costing (TMC-174) — the pick list for "what was this for?". Issued
  // invoices for this company, newest first, labelled by customer so the option
  // reads like the job the user remembers. Best-effort: a failed fetch renders
  // the question with no jobs to pick rather than failing the page.
  const jobsRes = await client.api.invoices.$get({
    query: { companyId: expense.companyId, limit: '50' },
  });
  const jobs = jobsRes.ok
    ? (await jobsRes.json()).invoices
        // Allowlist, not exclusions. The old form excluded 'void' while the
        // stored value is 'voided', so cancelled invoices were still offered as
        // something to tag a cost to.
        .filter((i) => i.status === 'sent' || i.status === 'paid')
        .map((i) => ({
          id: i.id,
          number: i.number,
          issueDate: i.issueDate,
          customerName: i.customerName ?? null,
        }))
    : [];

  return {
    expense,
    categoryLabel: labelById.get(expense.categoryAccountId) ?? expense.categoryAccountId,
    paymentLabel: labelById.get(expense.paymentAccountId) ?? expense.paymentAccountId,
    receipt,
    auditEvents,
    jobs,
  };
};

export const actions: Actions = {
  // Job costing (TMC-174) — the answer to "what was this for?".
  //
  // Three answers, and the middle one is the point: a job, SHARED (a real
  // answer, meaning "several jobs, don't ask me to split it"), or nothing.
  // Choosing shared ends the interaction — the user is never prompted to
  // allocate, because asking a tradesperson to type percentages on a phone is
  // how this feature goes unused.
  setAllocation: async (event) => {
    const form = await event.request.formData();
    const target = String(form.get('target') ?? '');
    // jobId is spelled out rather than omitted: a row names one grain or the
    // other, and the payload type requires the choice to be explicit. This
    // action still tags at invoice grain — the job picker lands with the rest of
    // the jobs UI.
    const allocations =
      target === ''
        ? []
        : [{ invoiceId: target === 'shared' ? null : target, jobId: null, share: '1' }];

    const client = serverApiClient(event);
    const res = await client.api.expenses[':id'].allocations.$put({
      param: { id: event.params.id },
      json: { allocations },
    });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        allocationError: apiErrorMessage(body?.error, 'save_failed', body),
      });
    }
    return { allocationSaved: true };
  },

  // Soft delete (the API sets deleted_at + posts a reversal). Redirect to the
  // list, where the row no longer appears.
  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.expenses[':id'].$delete({ param: { id: event.params.id } });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { deleteError: apiErrorMessage(body?.error, 'delete_failed', body) });
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
      const code = apiErrorMessage(body?.error, 'upload_failed', body);
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
      return fail(res.status, {
        receiptError: apiErrorMessage(body?.error, 'delete_failed', body),
      });
    }
    redirect(303, `/expenses/${event.params.id}`);
  },

  // Dismiss the needs-review flag without linking a vendor (the one-off path).
  // The API clears vendor_review and never creates a contact.
  dismissReview: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.expenses[':id']['dismiss-review'].$post({
      param: { id: event.params.id },
    });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        reviewError: apiErrorMessage(body?.error, 'dismiss_failed', body),
      });
    }
    redirect(303, `/expenses/${event.params.id}`);
  },

  // Auto-fill from receipt (slice 8.9h). The api reads the stored receipt with
  // a vision model; on success we carry the suggestions to the edit form as
  // query params so the user reviews + saves (the AI never writes the ledger).
  extract: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.expenses[':id'].extract.$post({
      param: { id: event.params.id },
    });
    if (res.status === 404) throw error(404, 'expense not found');
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const code = apiErrorMessage(body?.error, 'extract_failed', body);
      const msg =
        code === 'ai_not_configured'
          ? 'AI receipt extraction is not configured on this server.'
          : code === 'storage_not_configured'
            ? 'Receipt storage is not configured on this server.'
            : code === 'no_receipt'
              ? 'Upload a receipt before auto-filling.'
              : code === 'extraction_failed'
                ? 'Could not read this receipt. Fill in the details by hand.'
                : code;
      return fail(res.status, { extractError: msg });
    }
    const data = (await res.json()) as {
      extraction: { merchant: string | null; total: string | null; expenseDate: string | null };
      suggestedCategoryAccountId: string | null;
    };
    const params = new URLSearchParams({ prefill: '1' });
    if (data.extraction.merchant) params.set('merchant', data.extraction.merchant);
    if (data.extraction.total) params.set('amount', data.extraction.total);
    if (data.extraction.expenseDate) params.set('expenseDate', data.extraction.expenseDate);
    if (data.suggestedCategoryAccountId)
      params.set('categoryAccountId', data.suggestedCategoryAccountId);
    redirect(303, `/expenses/${event.params.id}/edit?${params}`);
  },
};
