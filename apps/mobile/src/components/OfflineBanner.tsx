import { Ionicons } from '@expo/vector-icons';
import { useNetworkState } from 'expo-network';
import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// "You're offline" — the whole of TMC-228's first tier.
//
// Before this, a no-signal failure and a server failure looked identical: every
// screen fetches on focus and renders a generic error, so someone in a basement
// or a truck with no bars was told, in effect, that Thalermark is broken. That
// is the parent epic's thesis exactly (TMC-242, the app reporting things it did
// not actually do). This does not make the app work offline. It stops it lying
// about why it doesn't.
//
// `expo-network` was already a declared dependency with zero imports anywhere.
//
// THREE DELIBERATE CHOICES:
//
//   - **Bottom, not top.** The top of every non-tab screen is the hand-rolled
//     back link, which on iPadOS 26 is already fighting the window controls
//     (TMC-282). A banner up there would compete with the one control the user
//     needs most. Above the tab bar it collides with nothing.
//
//   - **Overlay, not layout.** Absolutely positioned with `pointerEvents="none"`,
//     so it shifts nothing and swallows no taps. ~70 screens each own their
//     scroll container; none of them had to change for this.
//
//   - **Silent until certain.** `isInternetReachable` is null/undefined while
//     the first probe is in flight, and treating that as offline would flash a
//     false banner on every cold start. Only an explicit `false` counts.
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  const state = useNetworkState();

  // `isInternetReachable` is the truthful one: joined to a Wi-Fi network with no
  // route out reports isConnected: true, which is the common real case (a cafe
  // portal, a router with no upstream). Fall back to isConnected only when
  // reachability is genuinely unavailable rather than merely still unknown.
  const offline =
    state.isInternetReachable === false ||
    (state.isInternetReachable == null && state.isConnected === false);

  if (!offline) return null;

  return (
    <View
      pointerEvents="none"
      // 56 is the tab bar's own height; the inset is the gesture area under it.
      style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 56 }}
      className="items-center px-6"
    >
      <View className="flex-row items-center gap-2 rounded-sm border border-ink/15 bg-cream-warm px-4 py-2">
        <Ionicons name="cloud-offline-outline" size={16} className="text-ink-subtle" />
        {/* Says only what `isInternetReachable` actually establishes: this
          DEVICE has no route out. It does NOT establish that your server is
          unreachable, and for a self-hoster pointing at a LAN box the two come
          apart entirely — reachable server, no internet, or the reverse. An
          earlier draft read "Thalermark can't reach your server", which claimed
          a fact never measured. That is the same failure this epic is about. */}
        <Text className="text-sm text-ink-muted">
          You're offline. Changes won't save until you reconnect.
        </Text>
      </View>
    </View>
  );
}
