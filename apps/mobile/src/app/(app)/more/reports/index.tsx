import {
  type BusinessType,
  TAX_FORM_BY_BUSINESS_TYPE,
  filesScheduleC,
} from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickActiveCompany } from '../../../../lib/active-company';
import { api } from '../../../../lib/api';

// Reports hub — the RN mirror of web's /reports/+page.svelte. Near-static index;
// each card links to a report that loads its own data. Lives under the "More"
// tab's Stack (reached from the More hub's Reports entry).
//
// The one thing it does fetch is the active company's business type, because the
// Schedule C worksheet is only some businesses' form — a partnership or
// corporation files a return of its own and the API 409s that endpoint for them
// (TMC-124). Web reads the same value off its layout load.
type ReportHref =
  | '/more/reports/profit-and-loss'
  | '/more/reports/expenses-by-category'
  | '/more/reports/schedule-c'
  | '/more/reports/balance-sheet'
  | '/more/reports/ar-aging'
  | '/more/reports/sales-tax'
  | '/more/reports/sales-by-customer'
  | '/more/reports/revenue-over-time'
  | '/more/reports/estimate-win-rate'
  | '/more/reports/top-products';

const REPORTS: { href: ReportHref; title: string; blurb: string }[] = [
  {
    href: '/more/reports/profit-and-loss',
    title: 'Profit & loss',
    blurb: 'Revenue minus expenses — what you actually made over a period.',
  },
  {
    href: '/more/reports/expenses-by-category',
    title: 'Expenses by category',
    blurb: 'Where the money went, grouped by category.',
  },
  {
    href: '/more/reports/schedule-c',
    title: 'Schedule C worksheet',
    blurb: 'Your year laid out by tax line, ready to hand to whoever files for you.',
  },
  {
    href: '/more/reports/balance-sheet',
    title: 'Balance sheet',
    blurb: 'What you own and owe — assets, liabilities, and equity.',
  },
  {
    href: '/more/reports/ar-aging',
    title: 'A/R aging',
    blurb: 'Unpaid invoices by how overdue they are — who to chase.',
  },
  {
    href: '/more/reports/sales-tax',
    title: 'Sales tax collected',
    blurb: 'Tax billed on invoices over a period, ready to remit.',
  },
  {
    href: '/more/reports/sales-by-customer',
    title: 'Sales by contact',
    blurb: 'Your best contacts by revenue over a period.',
  },
  {
    href: '/more/reports/revenue-over-time',
    title: 'Revenue over time',
    blurb: 'Monthly sales trend across the period.',
  },
  {
    href: '/more/reports/estimate-win-rate',
    title: 'Estimate win rate',
    blurb: 'How many quotes turn into accepted work.',
  },
  {
    href: '/more/reports/top-products',
    title: 'Top products',
    blurb: 'Best-selling items and services by revenue.',
  },
];

export default function ReportsHub() {
  const router = useRouter();
  const [businessType, setBusinessType] = useState<BusinessType | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      api.api.companies
        .$get()
        .then(async (res) => {
          if (!active || !res.ok) return;
          const { companies } = await res.json();
          const company = await pickActiveCompany(companies);
          if (active) setBusinessType((company?.businessType as BusinessType | null) ?? null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  // Unresolved business type reads as "files Schedule C" — that matches the
  // provisional chart seeded before onboarding asks, and a failed fetch showing
  // one card too many beats hiding a report the user does have.
  const showScheduleC = filesScheduleC(businessType);
  const taxForm = businessType ? TAX_FORM_BY_BUSINESS_TYPE[businessType] : null;
  const reports = showScheduleC
    ? REPORTS
    : REPORTS.filter((r) => r.href !== '/more/reports/schedule-c');

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Pressable onPress={() => router.push('/more')}>
          <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">← More</Text>
        </Pressable>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">Reports</Text>

        <View className="mt-8 space-y-4">
          {reports.map((r) => (
            <Pressable
              key={r.href}
              onPress={() => router.push(r.href)}
              className="rounded-sm border border-ink/10 bg-cream-warm p-5 active:bg-cream"
            >
              <Text className="font-serif text-lg text-ink">{r.title}</Text>
              <Text className="mt-1 text-sm text-ink/60">{r.blurb}</Text>
            </Pressable>
          ))}
        </View>

        {taxForm && !showScheduleC ? (
          <View className="mt-8 rounded-sm border border-ink/10 bg-cream-warm p-5">
            <Text className="text-sm text-ink/70">
              <Text className="text-ink">
                We haven't built the tax sheet for your kind of business yet.
              </Text>{' '}
              Yours is called {taxForm} — it's on our list. Until then, your profit & loss has what
              whoever does your taxes will ask for.
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
