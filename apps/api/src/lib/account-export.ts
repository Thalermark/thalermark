import {
  type Database,
  type Transaction,
  accounts,
  billPayments,
  bills,
  capitalPurchases,
  chartOfAccounts,
  companies,
  contacts,
  estimateLineItems,
  estimates,
  expenses,
  invoiceLineItems,
  invoicePayments,
  invoices,
  items,
  jobs,
  mileageTrips,
  ownerMoneyEvents,
  recurringInvoiceLineItems,
  recurringInvoices,
  taxPolicies,
  timeEntries,
  vehicles,
} from '@thalermark/db';
import { and, asc, eq, isNull } from 'drizzle-orm';

// Full-account data export — the assembly behind GET /api/account/export
// (Settings → Export). A bulk read of every business record the account owns,
// across ALL its companies, for the user-facing data-portability download. The
// web layer turns this one bundle into a CSV-or-JSON ZIP; keeping the assembly
// here (not in the route) makes it unit-testable, mirroring customer-statement.
//
// Deliberately account-scoped, NOT company-scoped. The multi-company rule is
// "every company-scoped read passes companyId or it spans all companies" — here
// spanning all companies is the whole point, so every read filters by accountId
// only and we group by companyId below. Do not add a companyId filter.
//
// Business records only. The hidden double-entry ledger (journal_entries /
// journal_lines / opening_balances), auth_*, telemetry_events, and
// llm_connections (holds the encrypted API key) are intentionally excluded —
// they never appear in this bundle. chart_of_accounts is read ONLY to resolve
// the user-facing category / paid-from NAMES on expenses and bills (the same
// labels the app shows); no account codes, balances, or journal data are
// exported. Rows carry resolved contact / category names so the CSV reads
// without UUIDs. Soft-deleted rows (expenses / capital purchases / owner-money)
// are dropped so the export matches what the user sees; archived items and tax
// policies are kept (they're history, not deletions — same as the per-list CSV
// export).

const VERSION = 1;

function groupBy<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

export async function buildAccountExport(tx: Database | Transaction, accountId: string) {
  const [account] = await tx
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  // Curated company profile — the details the user set, minus internal/config
  // fields (AI-nudge cache, logo storage key, Stripe Connect integration state).
  const companyRows = await tx
    .select({
      id: companies.id,
      name: companies.name,
      businessType: companies.businessType,
      businessAddress: companies.businessAddress,
      businessPhone: companies.businessPhone,
      businessEmail: companies.businessEmail,
      replyToEmail: companies.replyToEmail,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .where(eq(companies.accountId, accountId))
    .orderBy(asc(companies.createdAt), asc(companies.id));

  // One bulk read per entity, account-wide (see header note on scoping). Line
  // items come back flat and get grouped onto their parents below.
  const [
    contactRows,
    itemRows,
    invoiceRows,
    invoiceLines,
    estimateRows,
    estimateLines,
    recurringRows,
    recurringLines,
    expenseRows,
    billRows,
    capitalRows,
    ownerMoneyRows,
    taxPolicyRows,
    invoicePaymentRows,
    billPaymentRows,
    mileageRows,
    vehicleRows,
    jobRows,
    timeEntryRows,
    coaRows,
  ] = await Promise.all([
    tx
      .select()
      .from(contacts)
      .where(eq(contacts.accountId, accountId))
      .orderBy(asc(contacts.createdAt), asc(contacts.id)),
    tx
      .select()
      .from(items)
      .where(eq(items.accountId, accountId))
      .orderBy(asc(items.createdAt), asc(items.id)),
    tx
      .select()
      .from(invoices)
      .where(eq(invoices.accountId, accountId))
      .orderBy(asc(invoices.createdAt), asc(invoices.id)),
    tx
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.accountId, accountId))
      .orderBy(asc(invoiceLineItems.invoiceId), asc(invoiceLineItems.position)),
    tx
      .select()
      .from(estimates)
      .where(eq(estimates.accountId, accountId))
      .orderBy(asc(estimates.createdAt), asc(estimates.id)),
    tx
      .select()
      .from(estimateLineItems)
      .where(eq(estimateLineItems.accountId, accountId))
      .orderBy(asc(estimateLineItems.estimateId), asc(estimateLineItems.position)),
    tx
      .select()
      .from(recurringInvoices)
      .where(eq(recurringInvoices.accountId, accountId))
      .orderBy(asc(recurringInvoices.createdAt), asc(recurringInvoices.id)),
    tx
      .select()
      .from(recurringInvoiceLineItems)
      .where(eq(recurringInvoiceLineItems.accountId, accountId))
      .orderBy(
        asc(recurringInvoiceLineItems.recurringInvoiceId),
        asc(recurringInvoiceLineItems.position),
      ),
    tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.accountId, accountId), isNull(expenses.deletedAt)))
      .orderBy(asc(expenses.createdAt), asc(expenses.id)),
    tx
      .select()
      .from(bills)
      .where(eq(bills.accountId, accountId))
      .orderBy(asc(bills.createdAt), asc(bills.id)),
    tx
      .select()
      .from(capitalPurchases)
      .where(and(eq(capitalPurchases.accountId, accountId), isNull(capitalPurchases.deletedAt)))
      .orderBy(asc(capitalPurchases.createdAt), asc(capitalPurchases.id)),
    tx
      .select()
      .from(ownerMoneyEvents)
      .where(and(eq(ownerMoneyEvents.accountId, accountId), isNull(ownerMoneyEvents.deletedAt)))
      .orderBy(asc(ownerMoneyEvents.createdAt), asc(ownerMoneyEvents.id)),
    tx
      .select()
      .from(taxPolicies)
      .where(eq(taxPolicies.accountId, accountId))
      .orderBy(asc(taxPolicies.createdAt), asc(taxPolicies.id)),
    // Settlement rows. THE reason this ticket existed: invoice_payments
    // supersedes the invoice header's paid_at / payment_method / payment_reference
    // (see the note on that table), so exporting only the header shipped the
    // most recent payment and silently dropped every earlier one. A deposit plus
    // a final payment left as one row, and a part-paid invoice could not be
    // reconstructed at all (TMC-231).
    tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.accountId, accountId))
      .orderBy(asc(invoicePayments.receivedOn), asc(invoicePayments.id)),
    tx
      .select()
      .from(billPayments)
      .where(eq(billPayments.accountId, accountId))
      .orderBy(asc(billPayments.paidOn), asc(billPayments.id)),
    // Mileage is IRS Schedule C substantiation — the record you produce in an
    // audit — so leaving it out of a portability export was the worst of these
    // omissions even though it is the smallest table.
    tx
      .select()
      .from(mileageTrips)
      .where(eq(mileageTrips.accountId, accountId))
      .orderBy(asc(mileageTrips.tripDate), asc(mileageTrips.id)),
    tx
      .select()
      .from(vehicles)
      .where(eq(vehicles.accountId, accountId))
      .orderBy(asc(vehicles.createdAt), asc(vehicles.id)),
    tx
      .select()
      .from(jobs)
      .where(eq(jobs.accountId, accountId))
      .orderBy(asc(jobs.createdAt), asc(jobs.id)),
    tx
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.accountId, accountId))
      .orderBy(asc(timeEntries.entryDate), asc(timeEntries.id)),
    // COA id → name only, for category / paid-from labels (see header note).
    tx
      .select({ id: chartOfAccounts.id, name: chartOfAccounts.name })
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.accountId, accountId)),
  ]);

  // Name maps so referenced rows export a readable label, not a UUID. Contacts
  // are already loaded; COA is the labels-only read above.
  const contactName = new Map(contactRows.map((r) => [r.id, r.name]));
  const coaName = new Map(coaRows.map((r) => [r.id, r.name]));
  const nameOf = (map: Map<string, string>, id: string | null) =>
    id === null ? null : (map.get(id) ?? null);

  const invLinesByInvoice = groupBy(invoiceLines, (l) => l.invoiceId);
  const estLinesByEstimate = groupBy(estimateLines, (l) => l.estimateId);
  const recLinesByRecurring = groupBy(recurringLines, (l) => l.recurringInvoiceId);

  const contactsByCompany = groupBy(contactRows, (r) => r.companyId);
  const itemsByCompany = groupBy(itemRows, (r) => r.companyId);
  const invoicesByCompany = groupBy(invoiceRows, (r) => r.companyId);
  const estimatesByCompany = groupBy(estimateRows, (r) => r.companyId);
  const recurringByCompany = groupBy(recurringRows, (r) => r.companyId);
  const expensesByCompany = groupBy(expenseRows, (r) => r.companyId);
  const billsByCompany = groupBy(billRows, (r) => r.companyId);
  const capitalByCompany = groupBy(capitalRows, (r) => r.companyId);
  const ownerMoneyByCompany = groupBy(ownerMoneyRows, (r) => r.companyId);
  const taxPoliciesByCompany = groupBy(taxPolicyRows, (r) => r.companyId);
  const invoicePaymentsByCompany = groupBy(invoicePaymentRows, (r) => r.companyId);
  const billPaymentsByCompany = groupBy(billPaymentRows, (r) => r.companyId);
  const mileageByCompany = groupBy(mileageRows, (r) => r.companyId);
  const vehiclesByCompany = groupBy(vehicleRows, (r) => r.companyId);
  const jobsByCompany = groupBy(jobRows, (r) => r.companyId);
  const timeEntriesByCompany = groupBy(timeEntryRows, (r) => r.companyId);

  // Labels so the new rows read without UUIDs, same rule as contacts / COA above.
  const invoiceNumber = new Map(invoiceRows.map((r) => [r.id, r.number]));
  const jobName = new Map(jobRows.map((r) => [r.id, r.name]));
  const vehicleName = new Map(vehicleRows.map((r) => [r.id, r.label]));

  const companiesOut = companyRows.map((company) => ({
    company,
    contacts: contactsByCompany.get(company.id) ?? [],
    items: itemsByCompany.get(company.id) ?? [],
    invoices: (invoicesByCompany.get(company.id) ?? []).map((inv) => ({
      ...inv,
      contactName: nameOf(contactName, inv.contactId),
      lines: invLinesByInvoice.get(inv.id) ?? [],
    })),
    estimates: (estimatesByCompany.get(company.id) ?? []).map((est) => ({
      ...est,
      contactName: nameOf(contactName, est.contactId),
      lines: estLinesByEstimate.get(est.id) ?? [],
    })),
    recurringInvoices: (recurringByCompany.get(company.id) ?? []).map((rec) => ({
      ...rec,
      contactName: nameOf(contactName, rec.contactId),
      lines: recLinesByRecurring.get(rec.id) ?? [],
    })),
    expenses: (expensesByCompany.get(company.id) ?? []).map((exp) => ({
      ...exp,
      vendorName: nameOf(contactName, exp.vendorContactId),
      customerName: nameOf(contactName, exp.customerContactId),
      categoryName: nameOf(coaName, exp.categoryAccountId),
      paymentName: nameOf(coaName, exp.paymentAccountId),
    })),
    bills: (billsByCompany.get(company.id) ?? []).map((bill) => ({
      ...bill,
      vendorName: nameOf(contactName, bill.contactId),
      categoryName: nameOf(coaName, bill.categoryAccountId),
      paymentName: nameOf(coaName, bill.paymentAccountId),
    })),
    capitalPurchases: (capitalByCompany.get(company.id) ?? []).map((cap) => ({
      ...cap,
      vendorName: nameOf(contactName, cap.vendorContactId),
    })),
    ownerMoney: ownerMoneyByCompany.get(company.id) ?? [],
    taxPolicies: taxPoliciesByCompany.get(company.id) ?? [],
    // Every payment, not just the last one mirrored onto the invoice header.
    invoicePayments: (invoicePaymentsByCompany.get(company.id) ?? []).map((p) => ({
      ...p,
      invoiceNumber: nameOf(invoiceNumber, p.invoiceId),
    })),
    billPayments: billPaymentsByCompany.get(company.id) ?? [],
    mileageTrips: (mileageByCompany.get(company.id) ?? []).map((t) => ({
      ...t,
      vehicleLabel: nameOf(vehicleName, t.vehicleId),
      jobName: nameOf(jobName, t.jobId),
    })),
    vehicles: vehiclesByCompany.get(company.id) ?? [],
    jobs: (jobsByCompany.get(company.id) ?? []).map((j) => ({
      ...j,
      contactName: nameOf(contactName, j.contactId),
    })),
    timeEntries: (timeEntriesByCompany.get(company.id) ?? []).map((t) => ({
      ...t,
      jobName: nameOf(jobName, t.jobId),
      billedInvoiceNumber: nameOf(invoiceNumber, t.billedInvoiceId),
    })),
  }));

  return {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    account: account ?? { id: accountId, name: '' },
    companies: companiesOut,
  };
}

export type AccountExport = Awaited<ReturnType<typeof buildAccountExport>>;
