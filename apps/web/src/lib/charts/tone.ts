import { type SeriesTone, toneToRole } from '@thalermark/charts';

// A tone to a CSS colour, on the web side.
//
// Returns an `rgb(var(--token))` expression rather than a hex or a Tailwind
// class, for one reason that decides the whole theming story: the role tokens
// are remapped under `.dark` (app.css:31-42), so a colour written this way
// re-themes at PAINT time. No JavaScript, no theme store, no re-render.
//
// That matters because this app has no way to observe a theme change:
// ThemeToggle.svelte toggles a class on <html> and dispatches nothing, and the
// repo has zero Svelte stores. Anything handed a colour as a JS string inherits
// the wart the Stripe Element already has — it reads `isDark` once on mount and
// never re-themes. Charts sidestep it entirely by never seeing a colour.
//
// Not a Tailwind `fill-*` class because these are SVG presentation attributes
// on elements a utility class would have to win against, and because the muted
// case needs an alpha the palette has no token for.
export function toneFill(tone?: SeriesTone): string {
  const role = toneToRole(tone);
  // 'muted' maps to the foreground at low opacity — the same treatment every
  // border and track in the app already gets (border-fg/10, bg-fg/10).
  return role === 'fg' ? 'rgb(var(--fg) / 0.10)' : `rgb(var(--${role}))`;
}
