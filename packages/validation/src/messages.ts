import { z } from 'zod';

// Plain-language validation messages (TMC-221).
//
// Every schema in this package is parsed somewhere a user can see the result:
// the SvelteKit form actions render `issue.message` straight into a field error,
// and the API echoes issues back in `invalid_body`. Zod's own defaults are
// written for the developer reading a stack trace — a blank invoice line
// produced "Too small: expected string to have >=1 characters", and an empty
// line-item list produced "Too small: expected array to have >=1 items".
//
// This is a GLOBAL error map rather than a message on each validator, and the
// choice is deliberate. The sibling bug on mobile (TMC-220) is a good helper
// that nobody remembered to call at the leaf; a per-validator message has the
// same failure mode, because the next `.min(1)` anyone adds silently reverts to
// Zod's wording. A global map cannot be forgotten. Validators still override it
// where a specific sentence beats a general one ("Add at least one line" reads
// better than "Add at least one"), and an explicit message always wins.
//
// Register by importing this module — index.ts re-exports it, so any consumer of
// @thalermark/validation gets the map installed before it parses anything.
//
// The `z.config` call at the bottom is a real module side effect, and the
// package used to declare `"sideEffects": false`. That is a promise to bundlers
// that dropping an unused module is safe — so a production web or mobile build
// was entitled to tree-shake this file away and silently fall back to Zod's
// developer wording, while every test stayed green because tests import it by
// name. package.json now lists this module as the one exception.

// The scale of a field the user is filling in. Zod reports the runtime type it
// was checking, which is close enough to choose a noun.
function tooSmall(issue: { origin?: string; minimum?: unknown }): string {
  const min = Number(issue.minimum ?? 0);
  switch (issue.origin) {
    case 'string':
      return min <= 1 ? "This can't be blank." : `Use at least ${min} characters.`;
    case 'array':
      return min <= 1 ? 'Add at least one.' : `Add at least ${min}.`;
    case 'number':
    case 'int':
      return `Enter ${min} or more.`;
    case 'date':
      return 'Choose a later date.';
    default:
      return "This can't be blank.";
  }
}

function tooBig(issue: { origin?: string; maximum?: unknown }): string {
  const max = Number(issue.maximum ?? 0);
  switch (issue.origin) {
    case 'string':
      return `Keep this under ${max + 1} characters.`;
    case 'array':
      return `That's more than the ${max} allowed.`;
    case 'number':
    case 'int':
      return `Enter ${max} or less.`;
    case 'date':
      return 'Choose an earlier date.';
    default:
      return 'That value is too long.';
  }
}

// A uuid in one of these schemas is never typed by hand — it is the value behind
// a picker — so the honest instruction is about the picker, not the format.
function invalidFormat(issue: { format?: string }): string | undefined {
  switch (issue.format) {
    case 'email':
      return 'Enter an email address like name@example.com.';
    case 'uuid':
      return 'Choose one from the list.';
    case 'url':
      return 'Enter a web address starting with https://.';
    default:
      // A bare regex failure has no general sentence worth writing — the
      // validator that owns the pattern says what it wants (see money.ts).
      return undefined;
  }
}

export const humanErrorMap: z.core.$ZodErrorMap = (issue) => {
  switch (issue.code) {
    case 'invalid_type':
      // A missing value and a wrong-typed value read the same way to someone
      // filling in a form: the field is not usable as it stands.
      return issue.input === undefined || issue.input === null
        ? 'This is required.'
        : "That isn't a valid value here.";
    case 'too_small':
      return tooSmall(issue);
    case 'too_big':
      return tooBig(issue);
    case 'invalid_format':
      return invalidFormat(issue);
    case 'invalid_value':
      return 'Choose one of the options.';
    case 'not_multiple_of':
      return 'That number is not allowed here.';
    default:
      // Structural failures (unrecognized_keys, invalid_union and friends) mean
      // the client sent the wrong shape, which is a bug rather than something
      // the user typed. Leave Zod's wording — it is for whoever debugs it.
      return undefined;
  }
};

z.config({ customError: humanErrorMap });
