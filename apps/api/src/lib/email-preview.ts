import type { EmailTemplateType } from '@thalermark/validation';
import type { CustomerStatement } from './customer-statement.js';
import { buildEstimateEmail } from './estimate-email.js';
import { buildInvoiceEmail } from './invoice-email.js';
import { buildStatementEmail } from './statement-email.js';

// Renders a candidate (unsaved) template against representative sample data
// using the SAME builders the send path uses — so the settings editor's preview
// is exactly what a customer would receive, with zero drift. publicToken is the
// literal "preview" (the links are inert in the editor).

const SAMPLE_CUSTOMER = 'Jordan Rivera';

function sampleStatement(companyName: string): CustomerStatement {
  return {
    statementDate: '2026-07-01',
    company: { name: companyName, businessAddress: null, businessPhone: null },
    customer: {
      id: 'preview',
      name: SAMPLE_CUSTOMER,
      email: null,
      phone: null,
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
    },
    lines: [
      {
        date: '2026-05-12',
        description: 'Invoice INV-0006',
        charge: '450.00',
        payment: null,
        balance: '450.00',
      },
      {
        date: '2026-05-20',
        description: 'Payment received',
        charge: null,
        payment: '450.00',
        balance: '0.00',
      },
      {
        date: '2026-06-18',
        description: 'Invoice INV-0007',
        charge: '1250.00',
        payment: null,
        balance: '1250.00',
      },
    ],
    totalCharges: '1700.00',
    totalPayments: '450.00',
    balanceDue: '1250.00',
  };
}

export function buildEmailPreview(
  type: EmailTemplateType,
  template: { subject: string; body: string },
  companyName: string,
  publicAppUrl?: string,
): { subject: string; html: string; text: string } {
  const company = companyName || 'Your business';
  if (type === 'invoice') {
    return buildInvoiceEmail({
      invoice: {
        number: 'INV-0007',
        total: '1,250.00',
        currency: 'USD',
        dueDate: '2026-07-01',
        publicToken: 'preview',
      },
      customerName: SAMPLE_CUSTOMER,
      companyName: company,
      publicAppUrl,
      // A reply address is set so the "questions? reply" footnote shows in the
      // preview (it's conditional on the company having one).
      replyToEmail: 'hello@example.com',
      template,
    });
  }
  if (type === 'estimate') {
    return buildEstimateEmail({
      estimate: {
        number: 'EST-0007',
        total: '980.00',
        currency: 'USD',
        expiresOn: '2026-07-15',
        publicToken: 'preview',
      },
      customerName: SAMPLE_CUSTOMER,
      companyName: company,
      publicAppUrl,
      template,
    });
  }
  return buildStatementEmail({ statement: sampleStatement(company), template });
}
