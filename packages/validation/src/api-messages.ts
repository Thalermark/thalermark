// What an API error code says to a user (TMC-219, TMC-220).
//
// The API answers failures with a machine code — `invalid_recipient`,
// `has_payments`, `period_closed`. Those are the right thing on the wire and the
// wrong thing on a screen, and both clients were putting them on screens: web's
// helper returned the code unchanged for anything it did not know, and mobile
// set it as form copy directly. A landscaper clicking Send on an invoice whose
// customer has no email address — the likeliest failure of the most important
// button in the product — was shown the word `invalid_recipient`.
//
// This catalogue is SHARED rather than duplicated per client. The two helpers
// that consume it were byte-identical copies of each other covering two codes
// between them, which is how the vocabularies drift in the first place. It lives
// in the validation package because that is already where user-facing wording
// lives after TMC-221, and because both apps already depend on it — a package of
// its own for one file would cost more than it explains.
//
// House style, matched from the sentences that were already good here:
//   - say what to do next, not what failed
//   - name the thing in the user's words (customer, business, big purchase)
//   - never mention a table, a column, a status enum, or an id

// Codes whose sentence needs a value out of the error body (a year, a balance)
// are NOT here — they live in each client's helper, which has the body in hand.
// See periodClosedMessage in apps/web/src/lib/api-errors.ts.
export const API_ERROR_MESSAGES: Record<string, string> = {
  // --- The record is gone -------------------------------------------------
  // Almost always a stale tab or a second device: it existed when the page
  // loaded. Naming deletion as the likely cause beats "not found", which reads
  // as though the user typed something wrong.
  not_found: 'That is no longer there — it may have been deleted.',
  contact_not_found: 'That customer is no longer there — it may have been deleted.',
  invoice_not_found: 'That invoice is no longer there — it may have been deleted.',
  estimate_not_found: 'That estimate is no longer there — it may have been deleted.',
  expense_not_found: 'That expense is no longer there — it may have been deleted.',
  bill_not_found: 'That bill is no longer there — it may have been deleted.',
  item_not_found: 'That item is no longer there — it may have been deleted.',
  job_not_found: 'That job is no longer there — it may have been deleted.',
  purchase_not_found: 'That purchase is no longer there — it may have been deleted.',
  payment_not_found: 'That payment is no longer there — it may have been removed.',
  vehicle_not_found: 'That vehicle is no longer there — it may have been deleted.',
  mileage_trip_not_found: 'That trip is no longer there — it may have been deleted.',
  time_entry_not_found: 'That time entry is no longer there — it may have been deleted.',
  tax_policy_not_found: 'That tax rate is no longer there — it may have been deleted.',
  company_not_found: 'That business is no longer in this workspace.',
  member_not_found: 'That person is no longer in this workspace.',
  recurring_invoice_not_found: 'That repeating invoice is no longer there.',
  owner_money_event_not_found: 'That record is no longer there — it may have been deleted.',
  opening_balance_not_found: 'There are no starting balances to change.',
  manual_adjustment_not_found: 'That ledger entry is no longer there.',
  period_close_not_found: 'That year is not closed.',
  transfer_not_found: 'That handoff is no longer there.',

  // --- Money already moved ------------------------------------------------
  // The settlement guards. Each one is a rule the user did not know existed, so
  // each says what to do about it rather than restating the rule.
  has_payments: 'There are payments recorded against this — remove or refund those first.',
  not_paid: 'Nothing has been paid on this yet.',
  not_payable: 'There is nothing left to pay on this.',
  payment_exceeds_balance: 'That is more than the amount still owed.',
  // Raised for two different reasons — bills check it against the payable-from
  // set, expenses check the account is still valid — so the sentence has to
  // work for both without naming either.
  invalid_payment_account: "That account can't be used to pay this. Pick another.",
  not_financed: 'This purchase was paid in full, so there is no loan to pay down.',
  invoice_voided: 'This invoice was voided, so no more money can be recorded against it.',
  not_issued: 'Send this invoice first — there is nothing owed on a draft to pay down.',
  total_below_logged: 'That total is less than what has already been recorded against it.',
  invoice_paid:
    'This invoice has been paid. Remove or refund the payment first, then pull it back to fix it.',

  // --- The record is in the wrong state -----------------------------------
  not_editable: 'This can no longer be edited — it has already been sent.',
  bill_not_editable: 'This bill can no longer be edited — it has already been paid.',
  revision_in_progress:
    'This invoice is being fixed. Resend the corrected one first, then change its payments.',
  already_converted: 'This estimate already became an invoice. Fix the invoice instead.',
  invalid_transition: "That isn't something this record can do from where it is now.",
  invoice_state_invalid: "That isn't something this invoice can do from where it is now.",
  estimate_state_invalid: "That isn't something this estimate can do from where it is now.",
  already_reversed: 'This entry has already been reversed.',
  already_retired: 'This business is already closed.',
  not_retired: 'This business is not closed.',
  already_owner: 'That person already owns this workspace.',
  cannot_change_owner: 'The owner cannot be changed here.',
  cannot_remove_owner: 'The owner cannot be removed. Transfer ownership first.',
  last_active_company: 'This is your only open business, so it cannot be closed.',
  nothing_to_close: 'There is nothing to close for that year.',
  nothing_to_transfer: 'There is nothing to hand over.',
  later_year_still_closed: 'Re-open the later year first — years re-open newest first.',
  year_not_finished: 'That year is not over yet.',
  invalid_fiscal_year: 'Choose a year that has finished.',
  successor_has_activity:
    'The new business already has activity, so the books cannot be handed over.',
  target_not_empty: 'That business already has data in it.',
  same_company: 'Choose a different business.',
  timer_already_running: 'A timer is already running.',
  timer_not_running: 'No timer is running.',
  time_entry_billed: 'That time has already been billed on an invoice.',
  time_entry_already_billed: 'That time has already been billed on an invoice.',
  job_has_invoices: 'This job has invoices against it, so it cannot be deleted.',
  job_has_time_entries: 'This job has time recorded against it, so it cannot be deleted.',
  job_has_unbilled_time: 'This job still has time on it that has not been billed.',
  invoice_has_no_job: 'That invoice is not attached to a job.',

  // --- Names and numbers already taken ------------------------------------
  invoice_number_taken: 'An invoice already uses that number.',
  invoice_number_collision: 'An invoice already uses that number.',
  estimate_number_taken: 'An estimate already uses that number.',
  estimate_number_collision: 'An estimate already uses that number.',
  vehicle_label_taken: 'A vehicle already uses that name.',

  // --- Wrong thing picked -------------------------------------------------
  // A mismatch means the picker offered something from another business — a
  // stale tab after switching. The user's move is the same in all of them.
  contact_company_mismatch: 'That customer belongs to a different business.',
  customer_company_mismatch: 'That customer belongs to a different business.',
  invoice_company_mismatch: 'That invoice belongs to a different business.',
  vendor_company_mismatch: 'That vendor belongs to a different business.',
  vehicle_company_mismatch: 'That vehicle belongs to a different business.',
  job_company_mismatch: 'That job belongs to a different business.',
  time_entry_company_mismatch: 'That time entry belongs to a different business.',
  time_entry_job_mismatch: 'That time entry is on a different job.',
  invalid_category_account: 'That category is no longer available. Pick another.',
  invalid_account: 'That account is no longer available. Pick another.',
  equity_account_missing: 'This business is missing an account it needs. Contact support.',
  transfer_account_unmapped: 'One of the accounts has no match in the new business.',
  wrong_tax_form: 'That worksheet is not the one this business files.',

  // --- Sending -------------------------------------------------------------
  invalid_recipient: 'Add an email address for this customer before sending.',
  invalid_email: 'Enter an email address like name@example.com.',
  email_failed: 'That could not be sent. Try again in a moment.',
  mailer_send_failed: 'That could not be sent. Try again in a moment.',
  email_not_configured: 'Email is not set up on this server, so nothing can be sent yet.',
  mailer_not_configured: 'Email is not set up on this server, so nothing can be sent yet.',
  unknown_placeholders: 'That template uses a placeholder we do not recognise.',
  email_template_write_failed: 'That wording could not be saved. Try again.',

  // --- Getting paid --------------------------------------------------------
  stripe_not_configured: 'Card payments are not set up on this server.',
  connect_required: 'Connect a Stripe account before taking card payments.',
  connect_not_ready: 'Your Stripe account is not ready to take payments yet.',
  public_url_not_configured: 'This server has no public address set, so a pay link cannot be made.',
  idempotency_key_reused: 'That looks like a repeat of a payment already in progress.',

  // --- Files and receipts --------------------------------------------------
  file_required: 'Choose a file first.',
  file_too_large: 'That file is too large — the limit is 10 MB.',
  unsupported_media_type: 'That file type is not supported. Use a JPEG, PNG or PDF.',
  no_receipt: 'There is no receipt on this yet.',
  no_logo: 'There is no logo to remove.',
  storage_not_configured: 'File storage is not set up on this server.',
  extraction_failed: 'The receipt could not be read. Fill the details in by hand.',
  categorization_failed: 'A category could not be suggested. Pick one by hand.',

  // --- The AI layer --------------------------------------------------------
  ai_not_configured: 'AI is not set up yet. Add a connection in Settings → AI.',
  ai_not_available: 'AI is unavailable right now. Try again in a moment.',
  no_connection: 'AI is not set up yet. Add a connection in Settings → AI.',
  unknown_provider: 'That AI provider is not one we support.',
  endpoint_rejected: 'That address was refused. Check it and try again.',
  base_url_required: 'Enter the address of the AI service.',
  nudges_failed: 'Those insights could not be generated right now.',

  // --- Invitations ---------------------------------------------------------
  invite_not_found: 'That invitation is no longer valid.',
  invite_expired: 'That invitation has expired. Ask for a new one.',
  invite_already_accepted: 'That invitation has already been used.',
  invite_email_mismatch: 'That invitation was sent to a different email address.',
  invalid_or_expired_token: 'That link is no longer valid. Ask for a new one.',
  invalid_role: 'Choose a role from the list.',
  account_revoked: 'This workspace is no longer active.',
  account_required: 'Choose a workspace first.',

  // --- Permission and identity ---------------------------------------------
  unauthorized: 'Sign in to continue.',
  forbidden: 'You do not have permission to do that.',
  not_entitled: 'That is not included in this plan.',

  // --- Rate limiting and size ----------------------------------------------
  rate_limited: 'Too many tries. Wait a moment and try again.',
  too_many_rows: 'That is more rows than can be handled at once. Split it up.',
  q_too_long: 'That search is too long.',

  // --- Malformed input -----------------------------------------------------
  // Mostly unreachable from the UI — a client bug or a hand-made request. They
  // still need a sentence, because "mostly" is not "never".
  invalid_body: 'Some of those details are not right. Check the form and try again.',
  invalid_amount: 'Enter an amount like 125.00.',
  invalid_format: 'That is not in a format we can read.',
  invalid_status: 'Choose a status from the list.',
  invalid_type: 'Choose a type from the list.',
  invalid_types: 'Choose a type from the list.',
  invalid_period: 'Choose a period from the list.',
  invalid_basis: 'Choose a basis from the list.',
  invalid_method: 'Choose a method from the list.',
  invalid_year: 'Enter a four-digit year.',
  invalid_range: 'The end has to come after the start.',
  invalid_as_of: 'Enter a date like 2026-08-10.',
  invalid_from: 'Enter a start date like 2026-08-10.',
  invalid_to: 'Enter an end date like 2026-08-10.',
  invalid_offset: 'That reminder timing is not allowed.',
  invalid_query: 'That search could not be run.',
  invalid_company: 'Choose a business.',
  invalid_company_id: 'Choose a business.',
  invalid_customer_id: 'Choose a customer.',
  invalid_entity_id: 'That link is not valid.',
  invalid_entity_type: 'That link is not valid.',
  entity_id_requires_entity_type: 'That link is not valid.',
  company_id_required: 'Choose a business.',
  place_id_required: 'Pick an address from the list.',
  missing_signature: 'That request could not be verified.',
  invalid_signature: 'That request could not be verified.',
  invalid_cursor: 'That page is no longer available. Start again from the first page.',
  invalid_limit: 'That page size is not allowed.',
  invalid_id: 'That link is not valid.',

  // --- The server itself ---------------------------------------------------
  internal_server_error: 'Something went wrong on our side. Try again in a moment.',
  // Not raised by the API — it is what the web server substitutes when the API
  // did not answer at all (TMC-248). It travels the same path as a real code so
  // every screen's existing error branch handles it without knowing.
  unreachable: 'Could not reach Thalermark. Check your connection and try again.',
  create_failed: 'That could not be saved. Try again.',
};

// Whether a string is still a machine identifier rather than something to show a
// person: snake_case, or a bare HTTP-ish status line. The clients need this
// because their helpers compose — a value arriving at a screen's own fallback
// may already be a translated sentence, and blindly replacing it would throw
// away the better message.
const CODE_SHAPED = /^[a-z0-9]+(_[a-z0-9]+)+$/;

export function isCodeShaped(value: string): boolean {
  return CODE_SHAPED.test(value.trim());
}

// The first human-readable zod issue out of an { issues: [...] } error body.
//
// `invalid_body` carries a field-level list, and those messages are written for
// the person looking at the form ("Enter how many visits you did", "That is more
// than a day"). Mapping the CODE first threw all of that away and printed a
// catalogue sentence naming no field and giving no reason, so the user had to
// guess which box was wrong (owner report, 2026-08-23: typed 30 meaning half an
// hour, was told only that some details were not right).
//
// Shared rather than per client for the same reason the catalogue is: web and
// mobile were byte-identical copies once and drifted the moment one was edited.
//
// Only the FIRST issue: this renders as one line under a form, and a stack reads
// worse than the one that will actually block the save. Defensive throughout —
// this parses a network response, and a shape that does not match must fall
// through to the catalogue rather than throw.
export function firstIssueMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  for (const issue of issues) {
    const message = (issue as { message?: unknown })?.message;
    // Zod emits internal-sounding defaults for some codes; a message that reads
    // like a sentence is one we wrote for a person (TMC-219 / TMC-220).
    if (typeof message === 'string' && message.trim() && !isCodeShaped(message)) {
      return message;
    }
  }
  return undefined;
}

// The sentence for a code, or undefined when the catalogue has never heard of
// it. Callers decide what to do with undefined — see each client's helper, which
// falls back to a sentence supplied by the screen rather than to the code.
export function messageForApiError(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return API_ERROR_MESSAGES[code];
}
