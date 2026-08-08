import { lineTax, policyRate } from '$lib/line-tax';
import {
  type InvoiceLineItemInput,
  type LineItemType,
  multiplyMoney,
} from '@thalermark/validation';

// The authoritative form-row → API-line mapping for BOTH invoice forms (/new
// and /[id]/edit). It lived twice, once per action, until a field was added to
// one copy and not the other: `timeEntryId` went missing on the web side, so
// invoices saved with correct hour lines while the entries stayed unbilled —
// the job kept offering them as ready and the next invoice billed them again.
// One copy means a new line field cannot reach one form and miss the other.
//
// Money is recomputed here rather than trusted from the client, and the tax
// rate is resolved from the policy list for the same reason.

export type InvoiceLineRow = {
  description: string;
  quantity: string;
  unitLabel?: string;
  unitPrice: string;
  sourceItemId?: string;
  type?: LineItemType;
  taxable: boolean;
  taxPolicyId?: string;
  // Set only on a row seeded from tracked time. The API derives which entries
  // the invoice bills from these, so a dropped row releases its entry — and a
  // dropped FIELD silently un-bills every hour on the invoice.
  timeEntryId?: string;
};

export function computeInvoiceLines(
  rows: InvoiceLineRow[],
  policies: { id: string; ratePct: string }[],
): InvoiceLineItemInput[] {
  return rows.map((row, i) => {
    const amount = multiplyMoney(row.quantity, row.unitPrice);
    const rate = row.taxable ? policyRate(policies, row.taxPolicyId ?? '') : '0';
    return {
      position: i + 1,
      description: row.description,
      quantity: row.quantity,
      unitLabel: row.unitLabel,
      unitPrice: row.unitPrice,
      amount,
      type: row.type,
      taxable: row.taxable,
      taxRatePct: rate,
      taxAmount: lineTax(row.taxable, rate, amount),
      taxPolicyId: row.taxable ? row.taxPolicyId : undefined,
      sourceItemId: row.sourceItemId,
      timeEntryId: row.timeEntryId,
    };
  });
}
