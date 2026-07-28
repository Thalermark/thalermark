// Who the model is told it is working for, derived from the company's business
// type. Every prompt in this package opens by naming its reader, and before this
// existed all three hardcoded a sole trader — so a C-corp received cash-flow
// nudges written for a one-person operation.
//
// These strings live here, NOT in packages/validation, for two reasons. They are
// model-facing prompt copy, and in validation they would sit beside
// BUSINESS_TYPE_LABELS — user-facing picker copy that looks identical and must
// never be edited in the same breath. And validation ships to the web and mobile
// bundles, which have no use for prompt text.
//
// Two constraints on anything added here:
//   - Each phrase carries its own determiner ("a…" / "an…"), so no template ever
//     hardcodes an article it might get wrong.
//   - Each phrase must read grammatically in the trailing `… for ${persona}.`
//     slot that all three prompts use. That shared slot is the reason the phrases
//     can be one set rather than three.
//
// "small business" is doing deliberate work in four of the five: it anchors
// scale. Thalermark's C-corps are one-truck operations, not Boeing, and a bare
// "a C-corporation" invites the model to write for a finance department.
//
// sole_prop names two reader types rather than a category, and that is the
// point: a model writes differently for "a freelancer or tradesperson" than for
// "a self-employed person", which is a tax status and steers nothing. It was
// "a self-employed tradesperson" until TMC-171 — accurate for the power washers
// and landscapers, wrong for the dog sitters, photographers, and VAs who are
// equally the audience (PROJECT.md). It stays deliberately concrete: collapsing
// it to "a small business" would erase the distinction from the other four.
//
// This is also the fallback for null and unrecognised codes, so it is the
// most-served persona by a wide margin — every company that has not picked an
// entity gets it. Named rather than looked up because the lookup would be
// string | undefined under noUncheckedIndexedAccess and need a cast.
const SOLE_PROP = 'a freelancer or tradesperson';

const PERSONAS: Record<string, string> = {
  sole_prop: SOLE_PROP,
  llc_single_member: 'a small business set up as an LLC',
  partnership: 'a small business set up as a partnership',
  s_corp: 'a small business set up as an S-corporation',
  c_corp: 'a small business set up as a C-corporation',
};

// Map a company's business type to the persona phrase. Tolerant of null,
// undefined, and unrecognised codes — a value read straight off a company row
// must never be able to break a prompt, and the column is nullable text. Null
// falls to sole prop, matching how the rest of the app reads this column
// (filesScheduleC, periodCloseEquityLabel, coaOverlayFor all do the same).
export function businessPersona(businessType: string | null | undefined): string {
  if (!businessType) return SOLE_PROP;
  return PERSONAS[businessType] ?? SOLE_PROP;
}
