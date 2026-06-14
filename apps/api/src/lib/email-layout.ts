import { escapeHtml } from './html.js';

// Shared branded shell for every recipient-facing email (invoice, estimate,
// statement, verification, invitation). One place so the messages can't drift
// and so a Thalermark user's customer sees a consistent, legitimate-looking
// email instead of a bare link that reads as phishing.
//
// Email-client constraints drive the shape:
//   - Table-based layout + inline styles only (Outlook ignores <style>/flex/grid).
//   - No images — a text wordmark avoids the deliverability + blocked-image hit
//     and keeps the message lightweight (image-heavy mail scores as spam).
//   - One CTA, plenty of real text, a valid text/plain alternative: trustworthy
//     to a human and safe past spam filters.
//
// Palette is hardcoded (email needs literal hex — no CSS vars) but mirrors
// @thalermark/brand COLORS / spikes/thalermark-landing.html. Keep in lockstep.
const INK = '#0f1626'; // brand ink — wordmark, headings, button fill
const CREAM = '#f4ede0'; // brand cream — card fill, button text
const PAGE_BG = '#ebe0cc'; // brand cream.warm — page background (card sits lighter)
const GOLD = '#9a7d3f'; // brand gold.deep — accent
const BORDER = '#d9ccad'; // hand-mixed cream edge for the card border
const BODY = '#33384a'; // softened ink for paragraph text
const MUTED = '#6b6f7e'; // footnote
const FOOT = '#9a9482'; // footer line

const SERIF = "Fraunces, Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

export type EmailCta = { label: string; url: string };

export type EmailLayoutInput = {
  // Header wordmark — the sending company's name for customer emails, or
  // "Thalermark" for platform (verification/invitation) emails.
  brandName: string;
  // Inbox preview text (hidden in the body, shown by the client next to the
  // subject). Keep it a useful one-liner.
  preheader: string;
  // Optional serif heading at the top of the card.
  heading?: string;
  // Inner content (paragraphs / the statement table). The CALLER escapes any
  // dynamic text it interpolates here — this is the one trusted-HTML seam,
  // matching how the builders already escape with escapeHtml.
  bodyHtml: string;
  // Optional primary button.
  cta?: EmailCta;
  // Optional small muted note under the CTA (plain text — escaped here).
  footnote?: string;
  // Customer-facing emails set this to surface "Sent with Thalermark"; platform
  // emails leave it false (the wordmark already says Thalermark).
  poweredBy?: boolean;
};

// Footer line, shared so the html + text halves of every email stay identical.
export function emailFooterText(poweredBy?: boolean): string {
  return poweredBy ? 'Sent with Thalermark · thalermark.com' : 'Thalermark · thalermark.com';
}

// Bulletproof (table-wrapped) CTA button — ink fill, cream text, mirroring the
// web app's primary `.btn`.
function button(cta: EmailCta): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0 2px;"><tr><td style="border-radius:4px;background:${INK};"><a href="${escapeHtml(cta.url)}" style="display:inline-block;padding:13px 30px;font-family:${SANS};font-size:15px;font-weight:600;color:${CREAM};text-decoration:none;border-radius:4px;">${escapeHtml(cta.label)}</a></td></tr></table>`;
}

export function renderEmailHtml(i: EmailLayoutInput): string {
  const heading = i.heading
    ? `<h1 style="margin:0 0 16px;font-family:${SERIF};font-size:24px;font-weight:500;line-height:1.2;color:${INK};">${escapeHtml(i.heading)}<span style="color:${GOLD};">.</span></h1>`
    : '';
  const cta = i.cta ? button(i.cta) : '';
  const footnote = i.footnote
    ? `<p style="margin:22px 0 0;font-family:${SANS};font-size:13px;line-height:1.5;color:${MUTED};">${escapeHtml(i.footnote)}</p>`
    : '';

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light only"><meta name="x-apple-disable-message-reformatting"><title>${escapeHtml(i.brandName)}</title></head><body style="margin:0;padding:0;background:${PAGE_BG};"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${escapeHtml(i.preheader)}</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE_BG};"><tr><td align="center" style="padding:32px 16px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;width:100%;"><tr><td style="padding:0 4px 18px;font-family:${SERIF};font-size:22px;font-weight:500;letter-spacing:-0.01em;color:${INK};">${escapeHtml(i.brandName)}<span style="color:${GOLD};">.</span></td></tr><tr><td style="background:${CREAM};border:1px solid ${BORDER};border-radius:8px;padding:32px;">${heading}<div style="font-family:${SANS};font-size:15px;line-height:1.6;color:${BODY};">${i.bodyHtml}</div>${cta}${footnote}</td></tr><tr><td style="padding:18px 4px 0;font-family:${SANS};font-size:12px;line-height:1.5;color:${FOOT};">${escapeHtml(emailFooterText(i.poweredBy))}</td></tr></table></td></tr></table></body></html>`;
}
