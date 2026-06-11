import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';
import { getActiveAccountId } from '../../../lib/secure-store';

// The "More" hub — the home for screens that don't earn a top-level tab. M9
// seeded it with the items catalog + top-products report; M10 added account
// admin (team / switch account); M11f consolidated the nav, moving Estimates +
// Recurring here (Sales) and adding the activity feed + business/payments/email
// settings. The header shows the active account name (resolved from /api/me),
// and "Switch account" only surfaces when the user belongs to more than one
// account.
type Entry = {
  href:
    | '/estimates'
    | '/invoices/recurring'
    | '/more/team'
    | '/more/switch-account'
    | '/more/activity'
    | '/more/items'
    | '/more/reports'
    | '/more/business'
    | '/more/payments'
    | '/more/email';
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
};

const SALES_ENTRIES: Entry[] = [
  {
    href: '/estimates',
    icon: 'document-text-outline',
    title: 'Estimates',
    subtitle: 'Quote a job, then convert the estimate straight into an invoice.',
  },
  {
    href: '/invoices/recurring',
    icon: 'repeat-outline',
    title: 'Recurring invoices',
    subtitle: 'Schedules that generate and email invoices on their own.',
  },
];

const ACCOUNT_ENTRY: Entry = {
  href: '/more/team',
  icon: 'people-outline',
  title: 'Team',
  subtitle: 'See who has access and invite teammates by email.',
};

const SWITCH_ENTRY: Entry = {
  href: '/more/switch-account',
  icon: 'swap-horizontal-outline',
  title: 'Switch workspace',
  subtitle: 'Move between the workspaces you belong to.',
};

const ACTIVITY_ENTRY: Entry = {
  href: '/more/activity',
  icon: 'pulse-outline',
  title: 'Activity',
  subtitle: 'Recent changes across your workspace.',
};

const CATALOG_ENTRIES: Entry[] = [
  {
    href: '/more/items',
    icon: 'pricetags-outline',
    title: 'Products & services',
    subtitle: 'A reusable catalog you can pull into any invoice or estimate.',
  },
  {
    href: '/more/reports',
    icon: 'bar-chart-outline',
    title: 'Reports',
    subtitle: 'Profit & loss, A/R aging, sales, tax, top products, and more.',
  },
];

const SETTINGS_ENTRIES: Entry[] = [
  {
    href: '/more/business',
    icon: 'business-outline',
    title: 'Business',
    subtitle: 'Address, phone, and logo shown on the invoices customers see.',
  },
  {
    href: '/more/payments',
    icon: 'card-outline',
    title: 'Payments',
    subtitle: 'Connect Stripe and list the other ways customers can pay you.',
  },
  {
    href: '/more/email',
    icon: 'mail-outline',
    title: 'Email',
    subtitle: 'Set the reply-to address on the email your customers receive.',
  },
];

export default function MoreHub() {
  const router = useRouter();
  const [accountName, setAccountName] = useState<string | null>(null);
  const [multiAccount, setMultiAccount] = useState(false);
  // Business / Payments / Email all edit company settings — hide the whole
  // section for roles without settings:manage (the API 403s those writes).
  const canManageSettings = useMay('settings:manage');

  // Resolve the active account name (header) + whether a switcher is worth
  // showing. /api/me is a bootstrap route — no x-account-id needed.
  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([api.api.me.$get(), getActiveAccountId()])
        .then(async ([res, activeId]) => {
          if (!active || !res.ok) return;
          const { memberships } = await res.json();
          setMultiAccount(memberships.length > 1);
          const current = memberships.find((m) => m.accountId === activeId) ?? memberships[0];
          setAccountName(current?.name ?? null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  // Switch account only when there's somewhere to switch to; Activity always.
  const accountEntries = multiAccount
    ? [ACCOUNT_ENTRY, SWITCH_ENTRY, ACTIVITY_ENTRY]
    : [ACCOUNT_ENTRY, ACTIVITY_ENTRY];

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">More</Text>
        <Text className="mt-2 font-serif text-3xl font-light text-ink">{accountName ?? ' '}</Text>

        <Section label="Sales" entries={SALES_ENTRIES} onOpen={(href) => router.push(href)} />
        <Section label="Workspace" entries={accountEntries} onOpen={(href) => router.push(href)} />
        <Section
          label="Catalog & reports"
          entries={CATALOG_ENTRIES}
          onOpen={(href) => router.push(href)}
        />
        {canManageSettings ? (
          <Section
            label="Settings"
            entries={SETTINGS_ENTRIES}
            onOpen={(href) => router.push(href)}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({
  label,
  entries,
  onOpen,
}: {
  label: string;
  entries: Entry[];
  onOpen: (href: Entry['href']) => void;
}) {
  return (
    <View className="mt-8">
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <View className="mt-3 space-y-4">
        {entries.map((e) => (
          <Pressable
            key={e.href}
            onPress={() => onOpen(e.href)}
            className="flex-row items-center gap-4 rounded-sm border border-ink/10 bg-cream-warm p-5 active:bg-cream"
          >
            <Ionicons name={e.icon} size={24} color="#9a7b4f" />
            <View className="flex-1">
              <Text className="font-serif text-lg text-ink">{e.title}</Text>
              <Text className="mt-1 text-xs text-ink/60">{e.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color="#0f162680" />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
