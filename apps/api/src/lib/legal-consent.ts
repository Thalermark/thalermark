import { type Database, legalAcceptances } from '@thalermark/db';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';

// Legal-consent config for a deployment. Its PRESENCE is the gate: when the
// operator has configured Terms + Privacy (server env), consent is required and
// this object is built in server.ts; when unset it's undefined and the whole
// feature is off — the /api/legal state reports required:false and the web wall
// never renders, so a default self-host is byte-identical to no-consent.
//
// This is the SERVER-side counterpart to the web-only PUBLIC_TERMS_URL /
// PUBLIC_PRIVACY_URL that render the sign-up checkbox. The checkbox is friendly
// pre-agreement UX; THIS is where the server truth (enforcement + the persisted
// record) lives. The versions let the operator re-prompt everyone when the terms
// change — bumping either version makes previously-accepted users unaccepted
// against the new version, so the wall reappears once and a fresh row is written.
// The bundled example pages this repo ships, and the fallback when the operator
// sets LEGAL_CONSENT_REQUIRED without pointing at their own documents. Defined
// here rather than inline in env.ts so the "still on the templates?" check below
// compares against the same two strings the default is built from — a second
// copy would go stale the first time either path moved (TMC-214).
export const BUNDLED_TERMS_URL = '/legal/terms';
export const BUNDLED_PRIVACY_URL = '/legal/privacy';

export type LegalConsentConfig = {
  termsUrl: string;
  privacyUrl: string;
  termsVersion: string;
  privacyVersion: string;
};

// What /api/legal returns and the web/mobile wall reads. `version` is the
// terms version — a change signal for the client; the accepted-check keys on
// both versions. urls are echoed so the wall always has links regardless of the
// web app's own PUBLIC_ env.
export type LegalConsentState = {
  required: boolean;
  version: string | null;
  accepted: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
  // Consent is being collected against the EXAMPLE documents this repo ships
  // (TMC-214). Those pages are deliberate templates — they read "operated by
  // [Operator legal name]", "[jurisdiction]", "Last updated: [DATE]" — and they
  // are also the default the consent gate points at, so an operator who turns
  // consent on without setting LEGAL_TERMS_URL / LEGAL_PRIVACY_URL ships a
  // blocking clickwrap over placeholder text and is never told.
  //
  // The pages already carry a "Template — customize before launch" callout. The
  // gap this closes is that nobody has to look at them.
  usingBundledTemplates: boolean;
};

const NOT_REQUIRED: LegalConsentState = {
  required: false,
  version: null,
  accepted: false,
  termsUrl: null,
  privacyUrl: null,
  // Nothing is being collected, so there is nothing to warn about — an operator
  // who leaves consent off is not agreeing anyone to anything.
  usingBundledTemplates: false,
};

// Has this user accepted the CURRENT terms+privacy version? Read via the
// bootstrap (RLS-bypass) handle — same user-scoped path /api/me uses — since
// acceptance is a per-person fact that can precede account selection.
export async function getLegalConsentState(
  db: Database,
  config: LegalConsentConfig | undefined,
  userId: string,
): Promise<LegalConsentState> {
  if (!config) return NOT_REQUIRED;
  const [row] = await db
    .select({ id: legalAcceptances.id })
    .from(legalAcceptances)
    .where(
      and(
        eq(legalAcceptances.userId, userId),
        eq(legalAcceptances.termsVersion, config.termsVersion),
        eq(legalAcceptances.privacyVersion, config.privacyVersion),
      ),
    )
    .limit(1);
  return {
    required: true,
    version: config.termsVersion,
    accepted: row !== undefined,
    termsUrl: config.termsUrl,
    privacyUrl: config.privacyUrl,
    // Either one still pointing at a bundled page is enough: agreeing people to
    // a real Terms and a placeholder Privacy is not half a problem.
    usingBundledTemplates:
      config.termsUrl === BUNDLED_TERMS_URL || config.privacyUrl === BUNDLED_PRIVACY_URL,
  };
}

// Idempotent record of acceptance for the current version. A second click of the
// same version is a no-op (unique index on user_id + both versions); bumping a
// version writes a fresh row. account_id / ip / user_agent are context-only —
// core passes the active account best-effort and leaves ip/user_agent to the
// commercial layer.
export async function recordLegalAcceptance(
  db: Database,
  config: LegalConsentConfig,
  args: {
    userId: string;
    accountId?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  },
): Promise<void> {
  await db
    .insert(legalAcceptances)
    .values({
      id: uuidv7(),
      userId: args.userId,
      termsVersion: config.termsVersion,
      termsUrl: config.termsUrl,
      privacyVersion: config.privacyVersion,
      privacyUrl: config.privacyUrl,
      accountId: args.accountId ?? null,
      ip: args.ip ?? null,
      userAgent: args.userAgent ?? null,
    })
    .onConflictDoNothing({
      target: [
        legalAcceptances.userId,
        legalAcceptances.termsVersion,
        legalAcceptances.privacyVersion,
      ],
    });
}
