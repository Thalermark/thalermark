// Builds the From header for a customer-facing email so the recipient sees the
// sending company's name ("Always Sunny Lawncare") instead of the platform
// brand, while the envelope address stays on the DNS-verified EMAIL_FROM domain
// — Resend (and deliverability generally) require the address to be a domain we
// signed with DKIM, so only the display name is swapped, never the address.
//
// This is tier 1 of the white-label story: the raw address still reveals
// thalermark.com to anyone who expands the header. Per-tenant verified sending
// domains (tier 3) are a separate, later slice.

// Matches CR, LF, and other C0/DEL control characters. Stripping these from the
// display name is the header-injection guard.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the intent
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// Pull the bare address out of a configured `from`. Accepts both shapes the
// config can carry: "Name <addr@host>" -> "addr@host", and bare "addr@host" ->
// itself.
function addressOf(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match?.[1] ?? from).trim();
}

// Returns `"Company Name" <addr@verified-host>` from the platform's configured
// base `from` plus the sending company's display name. The name is
// user-controlled and lands in an email header, so we strip control chars
// (injection guard), escape backslash/quote, and wrap in an RFC 5322
// quoted-string so commas, angle brackets, and other specials can't break the
// header or smuggle in a second address. If the name is empty after
// sanitising, falls back to the base `from` unchanged.
export function formatSender(baseFrom: string, displayName: string): string {
  // Control chars → space, then collapse runs so a stripped "\r\n" doesn't
  // leave a double gap.
  const cleaned = displayName.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return baseFrom;
  const escaped = cleaned.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}" <${addressOf(baseFrom)}>`;
}

// Where a customer's reply to an invoice, estimate or statement actually goes.
//
// The From address is always the DKIM-signed platform domain (see above), so
// without an explicit Reply-To a customer hitting Reply writes to the PLATFORM,
// not to the business they are doing business with. Those messages are then
// lost silently: the landscaper never learns the question was asked, and the
// customer thinks they answered it (TMC-225).
//
// The chain, in order:
//
//   1. reply_to_email — the deliberate setting, when the operator has one.
//   2. business_email — already collected in the welcome wizard and already
//      printed on the invoice, so it is unambiguously an address this business
//      publishes. Using it means most companies never reach step 3.
//   3. no-reply@<the From domain> — terminal.
//
// Step 3 is DERIVED from the configured From rather than hardcoded to
// thalermark.com: a self-hoster sending as greenacres.com must not have their
// customers' replies aimed at a domain they do not own and nobody reads. Same
// class of mistake as billing a self-host through the platform's Stripe key.
//
// A no-reply destination is a genuine loss — "can you split this in two?" is
// worth money to the business — which is exactly why it is last and why the
// wizard asks. It is here only because a reply that dies visibly beats one that
// quietly reaches the wrong company.
export function resolveReplyTo(
  company: { replyToEmail?: string | null; businessEmail?: string | null },
  baseFrom: string,
): string {
  const explicit = company.replyToEmail?.trim();
  if (explicit) return explicit;
  const business = company.businessEmail?.trim();
  if (business) return business;
  const domain = addressOf(baseFrom).split('@')[1];
  // No parseable domain means EMAIL_FROM is malformed; sending with no Reply-To
  // is the old behaviour and better than inventing an address.
  return domain ? `no-reply@${domain}` : '';
}
