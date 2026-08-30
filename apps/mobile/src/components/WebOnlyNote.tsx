import { Text, View } from 'react-native';

// "This one lives on the web app."
//
// Some screens are genuinely desk-shaped: a CSV import wants a file picker and a
// wide preview table to check before committing; a trial balance is a grid an
// accountant reads across; incorporation handoff is a rare, consequential,
// one-time flow. Porting those to a phone would produce a worse version of a
// thing nobody wants to do on a phone.
//
// But a silent absence is its own defect. A phone-first user hunting the More
// tab for an import that is simply not there learns nothing, and that is the
// state TMC-274 was filed about. So the absence is stated, with the reason, and
// deliberately NOT rendered as a link: there is nowhere on the device to go.
export function WebOnlyNote({ title, reason }: { title: string; reason: string }) {
  return (
    <View className="rounded-sm border border-dashed border-ink/20 bg-cream px-5 py-4">
      <View className="flex-row items-baseline justify-between">
        <Text className="font-serif text-lg text-ink-muted">{title}</Text>
        <Text className="font-mono text-[10px] uppercase tracking-widest text-ink-subtle">
          On the web app
        </Text>
      </View>
      <Text className="mt-1 text-sm text-ink-subtle">{reason}</Text>
    </View>
  );
}
