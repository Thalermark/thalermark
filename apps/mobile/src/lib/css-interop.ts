import Ionicons from '@expo/vector-icons/Ionicons';
import { cssInterop } from 'nativewind';
import { ActivityIndicator, TextInput } from 'react-native';

// Some components take a colour as a PROP rather than a style, so className
// never reaches them: ActivityIndicator's `color`, Ionicons' `color`. Those
// call sites therefore hardcoded hex, which meant they sat outside the role
// tokens and stayed light-mode coloured on a dark ground — an ink spinner on
// navy is an invisible spinner (TMC-279).
//
// cssInterop is NativeWind's answer: resolve the className to a style, then
// hand its `color` to the prop. `target: false` because neither component
// takes a `style` we want to write; only the prop.
//
// After this, `className="text-ink"` on either of them follows the appearance
// like everything else, and there is one colour system rather than two.
const colorFromClassName = {
  className: {
    target: false,
    nativeStyleToProp: { color: true },
  },
} as const;

cssInterop(ActivityIndicator, colorFromClassName);
cssInterop(Ionicons, colorFromClassName);

// TextInput's placeholder is the same problem in a different shape: a colour
// prop, not a style, so it was hardcoded and stayed ink on navy. A second
// className prop keeps it separate from the input's own text colour.
//
//   <TextInput className="text-ink" placeholderClassName="text-ink-subtle" />
// `className: 'style'` MUST be repeated here. Registering an interop replaces
// the component's whole mapping rather than extending it, so omitting it drops
// TextInput's default className-to-style binding and every input silently loses
// its border and text colour. Caught by looking at a screen, not by tsc.
cssInterop(TextInput, {
  className: 'style',
  placeholderClassName: {
    target: false,
    nativeStyleToProp: { color: 'placeholderTextColor' },
  },
});
