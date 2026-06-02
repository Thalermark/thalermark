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
