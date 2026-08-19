import { colorScheme } from 'nativewind';
import { getStoredTheme, setStoredTheme } from './secure-store';

// Appearance preference, mirroring web's ThemeToggle: three states, not two.
// 'system' is the default and the reason the third state exists — "follow the
// OS" is a real choice, distinct from happening to match it today.
export type Theme = 'system' | 'light' | 'dark';

export const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

function isTheme(v: string | null): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark';
}

// Read synchronously by the settings screen so the control renders in the right
// position on first paint rather than flicking from Auto after a round trip.
let cached: Theme = 'system';

export function getTheme(): Theme {
  return cached;
}

// Apply the stored preference before the first render (root _layout, alongside
// hydrateServerUrl). Without this the app paints the system appearance and then
// snaps to the user's choice.
//
// colorScheme.set drives the SAME observable that global.css's
// `@media (prefers-color-scheme: dark)` is evaluated against
// (react-native-css-interop resolves that condition through colorScheme.get),
// so pinning a value overrides the OS with no separate class selector and no
// second set of styles. 'system' hands control back to the OS.
export async function hydrateTheme(): Promise<void> {
  try {
    const stored = await getStoredTheme();
    if (isTheme(stored)) cached = stored;
  } catch {
    // keep 'system'
  }
  colorScheme.set(cached);
}

export async function setTheme(theme: Theme): Promise<void> {
  cached = theme;
  colorScheme.set(theme);
  await setStoredTheme(theme);
}
