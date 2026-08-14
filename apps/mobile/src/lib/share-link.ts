import { Alert, Share } from 'react-native';

// Tradespeople text their pay links, from the phone, which is the device the
// link used to be un-sendable from: it rendered as plain Text with no copy, no
// share and no tap, so the only way out of the screen was retyping it by hand
// (TMC-224).
//
// The share sheet is deliberately the whole feature. It puts the URL straight
// into Messages or WhatsApp, which is how these links actually travel, and both
// iOS and Android already carry a Copy action inside the sheet. That is why
// there is no clipboard dependency here — expo-clipboard would add a native
// module to duplicate an action the platform hands us for free.
//
// `message` rather than `url`: it is the field both platforms honour, and
// passing both makes some share targets paste the link twice.
export async function shareLink(url: string, subject: string) {
  try {
    await Share.share({ message: url }, { subject, dialogTitle: subject });
  } catch {
    // Dismissing the sheet RESOLVES with a dismissedAction result rather than
    // throwing, so reaching this branch means the sheet could not be opened at
    // all. Staying silent would read as a dead tap, which is the complaint this
    // whole change exists to answer. The link itself is selectable, so there is
    // a real fallback to point at.
    Alert.alert('Could not open the share sheet', 'Press and hold the link to copy it instead.');
  }
}
