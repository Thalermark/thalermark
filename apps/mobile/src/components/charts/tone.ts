import { COLORS } from '@thalermark/brand';
import { type SeriesTone, toneToRole } from '@thalermark/charts';

// A tone to a colour string, on the mobile side.
//
// THIS IS THE FIRST CONSUMER OF @thalermark/brand IN apps/mobile/src. Every
// other place that needs a JS colour here types the hex by hand — about forty
// of them — and two have already drifted off-brand: (app)/index.tsx uses
// #9a7b4f where the palette says #9a7d3f, and ledger/new.tsx uses #7a2230 where
// oxblood is #8b3a2e. Charts are the wrong place to fix forty call sites, but
// they are the right place to stop adding to them.
//
// Where web resolves a tone through a CSS variable — so `.dark` re-themes at
// paint time — mobile resolves it to a literal. That asymmetry is deliberate
// and lives here rather than in the components: this app has no dark mode at
// all (no useColorScheme, no dark: classNames, and packages/brand carries one
// flat palette). If it ever grows one, this function gains an argument and
// every chart re-themes at once without a single component changing.
const ROLE_COLOR: Record<ReturnType<typeof toneToRole>, string> = {
  accent: COLORS.gold.deep,
  warning: COLORS.accents.copper,
  success: COLORS.accents.sage,
  danger: COLORS.accents.oxblood,
  info: COLORS.accents.slate,
  // The track behind a bar. Skia takes no className, so the ink/10 the rest of
  // the app writes as a utility has to be spelled out as an alpha hex here.
  fg: `${COLORS.ink}1a`,
};

export function toneColor(tone?: SeriesTone): string {
  return ROLE_COLOR[toneToRole(tone)];
}
