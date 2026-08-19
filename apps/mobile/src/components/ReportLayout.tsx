import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTrackReportView } from '../lib/use-report-view';

// Shared chrome + table primitives for the report screens. Each screen wraps its
// body in <ReportScaffold> (back-link + title + selector + note) and gates it
// with <ReportBody> (loading / error / data), then composes the row primitives —
// the RN counterpart of web's per-report <table> markup.

export function ReportScaffold({
  title,
  selector,
  note,
  children,
}: {
  title: string;
  selector: ReactNode;
  note: string;
  children: ReactNode;
}) {
  const router = useRouter();
  // report_viewed for every report that uses this scaffold (derived from the
  // route). top-products has its own layout, so it calls the hook directly.
  useTrackReportView();
  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more/reports')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
            ← Reports
          </Text>
        </Pressable>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">{title}</Text>
        {selector}
        <Text className="mt-4 text-sm text-ink-subtle">{note}</Text>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

// Render-prop gate: shows the spinner / error line, or hands non-null data to
// the child fn. Generic so each screen keeps its inferred report type.
export function ReportBody<T>({
  data,
  error,
  children,
}: {
  data: T | null;
  error: boolean;
  children: (data: T) => ReactNode;
}) {
  if (error) {
    return <Text className="mt-8 text-sm text-oxblood">Couldn't load the report.</Text>;
  }
  if (data === null) {
    return (
      <View className="mt-12 items-center">
        <ActivityIndicator color="#0f1626" />
      </View>
    );
  }
  return <>{children(data)}</>;
}

export function ReportCard({ children }: { children: ReactNode }) {
  return (
    <View className="mt-8 overflow-hidden rounded-sm border border-ink/10 bg-cream-warm">
      {children}
    </View>
  );
}

export function SectionHeader({ label }: { label: string }) {
  return (
    <View className="border-t border-ink/10 bg-cream px-4 py-3">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
    </View>
  );
}

export function AmountRow({
  label,
  amount,
  sub,
}: {
  label: string;
  amount: string;
  sub?: string;
}) {
  return (
    <View className="flex-row items-center justify-between border-t border-ink/10 px-4 py-3">
      <View className="flex-1 pr-3">
        <Text className="text-ink/80">{label}</Text>
        {sub ? <Text className="font-mono text-xs text-ink-subtle">{sub}</Text> : null}
      </View>
      <Text className="font-mono text-sm tabular-nums text-ink">{amount}</Text>
    </View>
  );
}

export function TotalRow({
  label,
  amount,
  emphasize,
  tone,
}: {
  label: string;
  amount: string;
  emphasize?: boolean;
  tone?: 'ink' | 'oxblood';
}) {
  return (
    <View className="flex-row items-center justify-between border-t border-ink/10 bg-cream px-4 py-3">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-muted">{label}</Text>
      <Text
        className={`font-mono tabular-nums ${emphasize ? 'text-lg' : 'text-base'} ${
          tone === 'oxblood' ? 'text-oxblood' : 'text-ink'
        }`}
      >
        {amount}
      </Text>
    </View>
  );
}

export function EmptyRow({ text }: { text: string }) {
  return (
    <View className="border-t border-ink/10 px-4 py-3">
      <Text className="italic text-ink-subtle">{text}</Text>
    </View>
  );
}

// Share bar + percentage, used by the expenses-by-category + sales-by-customer
// breakdowns.
export function ShareBar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <View className="mt-2 flex-row items-center gap-2">
      <View className="h-2 flex-1 overflow-hidden rounded-full bg-ink/10">
        <View className="h-full rounded-full bg-gold-deep" style={{ width: `${w}%` }} />
      </View>
      <Text className="w-9 text-right font-mono text-xs tabular-nums text-ink-subtle">
        {w.toFixed(0)}%
      </Text>
    </View>
  );
}
