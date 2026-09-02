import {
  type Database,
  type Transaction,
  companies,
  contacts,
  invoicePayments,
  invoices,
} from '@thalermark/db';
import { centsToMoney, toCents } from '@thalermark/validation';
import { and, eq, inArray } from 'drizzle-orm';

// Customer statement builder, shared by GET /api/contacts/:id/statement and
// the email-send route so the on-screen / printed / emailed statement are the
// same data. The customer's issued invoices (status sent or paid; drafts are
// unbilled, voided excluded) become a chronological charge/payment ledger with
// a running balance; the closing balance equals the customer's outstanding AR.
//
// PAYMENT LINES COME FROM invoice_payments, ONE PER RECEIPT (TMC-253).
//
// They used to come from the invoice header: a single line for the full total,
// emitted only `if (inv.paidAt)`. That was written when an invoice was paid or
// unpaid with nothing in between, and TMC-187 made it wrong three ways at once.
// syncInvoiceSettlement only stamps paid_at once an invoice is FULLY settled, so
// a customer who put 200.00 down on 450.00 received a statement showing the
// 450.00 charge, no payment line at all, and 450.00 due — their money silently
// absent from a document sent over email under the business's own name. The
// audience takes 50% down as a matter of course, so that was the normal case,
// not an edge one. An overpayment showed as the invoice total rather than what
// arrived, and a refund that reopened an invoice cleared paid_at and made the
// payment line vanish entirely.
//
// The header is now a FALLBACK, not an input: it is read only for an invoice
// that reached 'paid' with no payment rows behind it, which means it was settled
// through the pre-TMC-187 single-shot mark-paid. Migration 0032 backfilled a row
// for those, so what is left is the case it deliberately skipped — a zero-total
// invoice. Same legacy notion as checkPaymentEligibility's
// 'settled_without_payments', and the reason the old rendering is kept rather
// than dropped: those statements should read exactly as they did.
//
// A voided invoice cannot carry payments — POST /invoices/:id/void 409s with
// `has_payments` — so excluding voided invoices here can never drop a receipt on
// the floor.

export type StatementLine = {
  date: string;
  description: string;
  charge: string | null;
  payment: string | null;
  balance: string;
};

export type CustomerStatement = {
  statementDate: string;
  company: { name: string; businessAddress: string | null; businessPhone: string | null };
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  };
  lines: StatementLine[];
  totalCharges: string;
  totalPayments: string;
  balanceDue: string;
};

export async function buildCustomerStatement(
  tx: Database | Transaction,
  accountId: string,
  customerId: string,
): Promise<CustomerStatement | null> {
  const [customer] = await tx
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, customerId), eq(contacts.accountId, accountId)))
    .limit(1);
  if (!customer) return null;

  const [company] = await tx
    .select({
      name: companies.name,
      businessAddress: companies.businessAddress,
      businessPhone: companies.businessPhone,
    })
    .from(companies)
    .where(and(eq(companies.id, customer.companyId), eq(companies.accountId, accountId)))
    .limit(1);

  const invs = await tx
    .select({
      id: invoices.id,
      number: invoices.number,
      issueDate: invoices.issueDate,
      total: invoices.total,
      status: invoices.status,
      paidAt: invoices.paidAt,
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.accountId, accountId),
        eq(invoices.contactId, customerId),
        inArray(invoices.status, ['sent', 'paid']),
      ),
    );

  // Every receipt against those invoices, in one read rather than a query per
  // invoice — the same shape the A/R aging report uses, which is half of why
  // the two now agree.
  const receiptsByInvoice = new Map<string, { id: string; amount: string; receivedOn: string }[]>();
  if (invs.length > 0) {
    const receipts = await tx
      .select({
        id: invoicePayments.id,
        invoiceId: invoicePayments.invoiceId,
        amount: invoicePayments.amount,
        receivedOn: invoicePayments.receivedOn,
      })
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.accountId, accountId),
          inArray(
            invoicePayments.invoiceId,
            invs.map((i) => i.id),
          ),
        ),
      );
    for (const r of receipts) {
      const list = receiptsByInvoice.get(r.invoiceId);
      if (list) list.push(r);
      else receiptsByInvoice.set(r.invoiceId, [r]);
    }
  }

  // Sort: by date, then a charge before the money moved against it on the same
  // date, then `seq` — the row's uuidv7, so same-date entries fall in the order
  // they were created. That last tiebreak is not cosmetic: without it two
  // invoices issued on one day came back in whatever order Postgres chose, and
  // the printed statement could list them differently from the emailed one.
  type Entry = Omit<StatementLine, 'balance'> & { sort: number; seq: string };
  const entries: Entry[] = [];
  for (const inv of invs) {
    entries.push({
      date: inv.issueDate,
      description: `Invoice ${inv.number}`,
      charge: inv.total,
      payment: null,
      sort: 0,
      seq: inv.id,
    });

    const receipts = receiptsByInvoice.get(inv.id) ?? [];
    for (const r of receipts) {
      const cents = toCents(r.amount);
      // A refund is a negative row (the table carries no CHECK amount > 0), and
      // it belongs on the CHARGE side: money handed back is money owed again, so
      // it has to push the running balance up. Rendering it as a negative
      // payment instead would print "-$-50.00" in the email, which formats the
      // sign itself.
      entries.push(
        cents < 0
          ? {
              date: r.receivedOn,
              description: `Refund issued for ${inv.number}`,
              charge: centsToMoney(-cents),
              payment: null,
              sort: 1,
              seq: r.id,
            }
          : {
              date: r.receivedOn,
              description: `Payment received for ${inv.number}`,
              charge: null,
              payment: centsToMoney(cents),
              sort: 1,
              seq: r.id,
            },
      );
    }

    // Legacy settlement: paid on the header with nothing behind it. See the
    // note at the top of this file.
    if (receipts.length === 0 && inv.status === 'paid' && inv.paidAt) {
      entries.push({
        date: inv.paidAt.toISOString().slice(0, 10),
        description: `Payment received for ${inv.number}`,
        charge: null,
        payment: inv.total,
        sort: 1,
        seq: inv.id,
      });
    }
  }
  entries.sort((a, b) =>
    a.date < b.date
      ? -1
      : a.date > b.date
        ? 1
        : a.sort !== b.sort
          ? a.sort - b.sort
          : a.seq < b.seq
            ? -1
            : a.seq > b.seq
              ? 1
              : 0,
  );

  // Running balance + totals accumulate in integer cents (formatted on the way
  // out) so a long statement can't drift a cent off the AR ledger.
  //
  // The two totals are NOT the two columns summed. A refund sits in the charge
  // column so the balance walks correctly, but it is not something the customer
  // was invoiced for, and counting it under "Total invoiced" would overstate the
  // year's billing. So charges count invoices and payments count money received
  // NET of refunds. The identity the footer depends on still holds exactly —
  // (invoices + refunds) − payments is the same number as invoices − (payments −
  // refunds) — so the closing balance and `balanceDue` remain the same value
  // arrived at two ways.
  let runningCents = 0;
  let totalChargesCents = 0;
  let totalPaymentsCents = 0;
  const lines: StatementLine[] = entries.map((e) => {
    if (e.charge) {
      const cents = toCents(e.charge);
      runningCents += cents;
      if (e.sort === 0) totalChargesCents += cents;
      else totalPaymentsCents -= cents;
    }
    if (e.payment) {
      const cents = toCents(e.payment);
      runningCents -= cents;
      totalPaymentsCents += cents;
    }
    return {
      date: e.date,
      description: e.description,
      charge: e.charge,
      payment: e.payment,
      balance: centsToMoney(runningCents),
    };
  });

  return {
    statementDate: new Date().toISOString().slice(0, 10),
    company: {
      name: company?.name ?? '',
      businessAddress: company?.businessAddress ?? null,
      businessPhone: company?.businessPhone ?? null,
    },
    customer: {
      id: customer.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      addressLine1: customer.addressLine1,
      addressLine2: customer.addressLine2,
      city: customer.city,
      region: customer.region,
      postalCode: customer.postalCode,
      country: customer.country,
    },
    lines,
    totalCharges: centsToMoney(totalChargesCents),
    totalPayments: centsToMoney(totalPaymentsCents),
    balanceDue: centsToMoney(runningCents),
  };
}
