import { serverApiClient } from '$lib/api.server';
import { error, fail, redirect } from '@sveltejs/kit';
import { minutesFromDuration } from '@thalermark/validation';
import type { Actions, PageServerLoad } from './$types';

// Job detail: the margin block, the invoices the job emitted, and its time log.
//
// INTERNAL ONLY. Cost, margin and hours never reach the customer — the public
// invoice view builds its own payload server-side and none of this is in it.
export const load: PageServerLoad = async (event) => {
  const client = serverApiClient(event);
  const [jobRes, timeRes] = await Promise.all([
    client.api.jobs[':id'].$get({ param: { id: event.params.id } }),
    // The whole log, billed and unbilled — the detail page shows both.
    client.api.jobs[':id'].time.$get({
      param: { id: event.params.id },
      query: { unbilled: undefined },
    }),
  ]);
  if (jobRes.status === 404) throw error(404, 'job not found');
  if (!jobRes.ok) throw error(jobRes.status, 'failed to load job');
  const job = await jobRes.json();
  const time = timeRes.ok
    ? await timeRes.json()
    : { timeEntries: [], totalMinutes: 0, totalHours: '0.00' };
  // The caller's running stopwatch, if any — on this job or another. One read
  // answers both "is my timer on THIS job" and "which job is holding it".
  const timerRes = await client.api.timer.$get();
  const { timer } = timerRes.ok ? await timerRes.json() : { timer: null };

  return { job, time, timer };
};

export const actions: Actions = {
  startTimer: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.jobs[':id'].timer.$post({ param: { id: event.params.id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string;
        jobName?: string;
        jobId?: string;
      } | null;
      // A refusal has to name the job holding the timer and link to it, or the
      // user is stranded: they are standing at this job and the thing blocking
      // them is somewhere else.
      return fail(res.status, {
        timerError:
          body?.error === 'timer_already_running'
            ? `A timer is already running on "${body.jobName}". Stop it there first.`
            : (body?.error ?? 'could_not_start'),
        runningJobId: body?.jobId,
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  // Stop hands back the elapsed minutes rather than logging. The user still owes
  // a note and a rate, and a stopwatch that silently became a billable entry is
  // the easiest way to invoice someone for a drive home.
  stopTimer: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.jobs[':id'].timer.$delete({ param: { id: event.params.id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { timerError: body?.error ?? 'could_not_stop' });
    }
    const { minutes, note } = await res.json();
    return { stoppedMinutes: minutes, stoppedNote: note };
  },

  logTime: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    // Shared with mobile (@thalermark/validation) so the same typed string can
    // never become two different durations.
    const minutes = minutesFromDuration(String(data.get('duration') ?? ''));
    if (minutes === null) return fail(400, { timeError: 'Enter hours like 3.25 or 3:15.' });

    const entryDate = String(data.get('entryDate') ?? '').trim();
    const note = String(data.get('note') ?? '').trim();
    const rate = String(data.get('rate') ?? '').trim();

    const res = await client.api.jobs[':id'].time.$post({
      param: { id: event.params.id },
      json: {
        entryDate,
        minutes,
        note: note || undefined,
        rate: rate || undefined,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { timeError: body?.error ?? 'log_failed' });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  deleteTime: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const id = String(data.get('id') ?? '');
    if (!id) return fail(400, { timeError: 'missing_id' });
    const res = await client.api['time-entries'][':id'].$delete({ param: { id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, {
        timeError:
          body?.error === 'time_entry_billed'
            ? 'Those hours are already on an invoice. Take them off it first.'
            : (body?.error ?? 'delete_failed'),
      });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  setStatus: async (event) => {
    const client = serverApiClient(event);
    const data = await event.request.formData();
    const status = String(data.get('status') ?? '');
    if (status !== 'open' && status !== 'closed') return fail(400, { actionError: 'bad_status' });
    const res = await client.api.jobs[':id'].$patch({
      param: { id: event.params.id },
      json: { status },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return fail(res.status, { actionError: body?.error ?? 'update_failed' });
    }
    redirect(303, `/jobs/${event.params.id}`);
  },

  // Only ever succeeds for a job that was never used — the API refuses one with
  // invoices or tracked time, because deleting it would cascade the hours away.
  delete: async (event) => {
    const client = serverApiClient(event);
    const res = await client.api.jobs[':id'].$delete({ param: { id: event.params.id } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const message =
        body?.error === 'job_has_time_entries'
          ? 'This job has hours logged against it. Close it instead — deleting would throw the hours away.'
          : body?.error === 'job_has_invoices'
            ? 'This job has invoices. Close it instead.'
            : (body?.error ?? 'delete_failed');
      return fail(res.status, { actionError: message });
    }
    redirect(303, '/jobs');
  },
};
