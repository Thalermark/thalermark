import { companies } from '@thalermark/db';
import { type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

// "Is this past due?" answered in the company's own calendar (TMC-258).
//
// The read side had the same defect the write side did: comparing a stored DATE
// against `new Date().toISOString().slice(0, 10)` compares it to UTC's today. In
// US Central that flips over at 7pm, so from 7:01pm an invoice that is due TODAY
// reads as Overdue, is counted in the Overdue tile, and invites the owner to
// chase a customer who is not late. A quote reads expired on the evening of its
// last valid day. Nothing is written, but the app states something false about a
// real document, which is the whole of what this class of bug is.
//
// Resolved per ROW rather than per request, which is what makes it safe on the
// account-scoped endpoints: /api/invoices/summary can span companies in
// different zones, and a single request-level "today" would have to pick one of
// them and be wrong for the rest. Each row is measured against its own company's
// clock, so the question never arises.
//
// Postgres decides it, matching the invoice-reminder sweep, which has always
// done `(now() AT TIME ZONE c.timezone)::date` — this is that same expression
// with the company reached by correlated lookup instead of a join, so callers
// need no change to their FROM clause. The subquery is a primary-key hit.
export function companyToday(companyIdColumn: AnyPgColumn): SQL<string> {
  return sql<string>`(now() AT TIME ZONE (
    select ${companies.timezone} from ${companies} where ${companies.id} = ${companyIdColumn}
  ))::date`;
}
