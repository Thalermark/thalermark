// Escape the five HTML metacharacters before embedding user-controlled text
// (invoice numbers, customer/company names, URLs) in an HTML email body the
// recipient's client will render. Shared by the invoice/estimate send routes,
// the invitation email, and the recurring-invoice generation engine.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
