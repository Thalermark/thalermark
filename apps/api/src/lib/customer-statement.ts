import { type Database, type Transaction, companies, contacts, invoices } from '@thalermark/db';
import { centsToMoney, toCents } from '@thalermark/validation';
import { and, eq, inArray } from 'drizzle-orm';

// Customer statement builder, shared by GET /api/contacts/:id/statement and
// the email-send route so the on-screen / printed / emailed statement are the
// same data. The customer's issued invoices (status sent or paid; drafts are
// unbilled, voided excluded) become a chronological charge/payment ledger with
// a running balance; the closing balance equals the customer's outstanding AR.

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
      number: invoices.number,
      issueDate: invoices.issueDate,
      total: invoices.total,
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

  // sort: charge before its payment on the same date.
  type Entry = StatementLine & { sort: number };
  const entries: (Omit<Entry, 'balance'> & { sort: number })[] = [];
  for (const inv of invs) {
    entries.push({
      date: inv.issueDate,
      description: `Invoice ${inv.number}`,
      charge: inv.total,
      payment: null,
      sort: 0,
    });
    if (inv.paidAt) {
      entries.push({
        date: inv.paidAt.toISOString().slice(0, 10),
        description: `Payment received — ${inv.number}`,
        charge: null,
        payment: inv.total,
        sort: 1,
      });
    }
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sort - b.sort));

  // Running balance + totals accumulate in integer cents (formatted on the way
  // out) so a long statement can't drift a cent off the AR ledger.
  let runningCents = 0;
  let totalChargesCents = 0;
  let totalPaymentsCents = 0;
  const lines: StatementLine[] = entries.map((e) => {
    if (e.charge) {
      runningCents += toCents(e.charge);
      totalChargesCents += toCents(e.charge);
    }
    if (e.payment) {
      runningCents -= toCents(e.payment);
      totalPaymentsCents += toCents(e.payment);
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
