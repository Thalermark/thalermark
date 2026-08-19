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
    | '/more/profile'
    | '/search'
    | '/estimates'
    | '/invoices/recurring'
    | '/jobs'
    | '/mileage'
    | '/bills'
    | '/owner-money'
    | '/ledger'
    | '/more/team'
    | '/more/companies'
    | '/more/switch-account'
    | '/more/activity'
    | '/more/items'
    | '/more/reports'
    | '/more/business'
    | '/more/payments'
    | '/more/email'
    | '/more/privacy'
    | '/more/about'
    | '/more/tax-policies'
    | '/more/accounts';
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  subtitle: string;
};

// Personal account settings — your own name + password. Always visible (every
// user can change their own login, regardless of workspace role).
const PROFILE_ENTRY: Entry = {
  href: '/more/profile',
  icon: 'person-circle-outline',
  title: 'Profile',
  subtitle: 'Your display name and password.',
};

// Global search (TMC-198). The second door in — Home's header bar is the first.
// Sits under Account rather than a section of its own because it spans every
// section below it and belongs to no one of them.
const SEARCH_ENTRY: Entry = {
  href: '/search',
  icon: 'search-outline',
  title: 'Search',
  subtitle: 'Find an invoice, contact, expense, bill or job by name, number or amount.',
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
    title: 'Repeating invoices',
    subtitle: 'Schedules that generate and email invoices on their own.',
  },
];

// Jobs (TMC-181) — the named unit of work that hours and costs hang off.
// Sits under Sales rather than Purchases: it exists to be billed.
const JOBS_ENTRY: Entry = {
  href: '/jobs',
  icon: 'hammer-outline',
  title: 'Jobs',
  subtitle: 'Log hours against a job, then turn them into an invoice.',
};

// Mileage (TMC-179) — business driving, at the IRS standard rate. Grouped with
// Purchases rather than Sales: it produces a deduction, not revenue. Ungated
// like the other list links; the API gates writes on expenses:write.
const MILEAGE_ENTRY: Entry = {
  href: '/mileage',
  icon: 'car-outline',
  title: 'Mileage',
  subtitle: 'Log business trips — often the biggest deduction on the return.',
};

// Bills (accounts payable) — money you owe vendors. Ungated like web's nav link
// (the list itself is viewable by all; the API gates writes on expenses:write).
const BILLS_ENTRY: Entry = {
  href: '/bills',
  icon: 'wallet-outline',
  title: 'Bills',
  subtitle: 'Track what you owe vendors and when each bill is due.',
};

// Owner money — money you put into the business or take out for yourself.
// Ungated like Bills (the list is viewable by all; the API gates writes on
// expenses:write).
const OWNER_MONEY_ENTRY: Entry = {
  href: '/owner-money',
  icon: 'swap-vertical-outline',
  title: 'Investments & withdrawals',
  subtitle: 'Money you put in from your own pocket, or take out to pay yourself.',
};

// "The Ledger" — the gated manual-journal-adjustment portal. Owner/admin/
// accountant only (the deliberate accounting back room, reached on purpose).
const LEDGER_ENTRY: Entry = {
  href: '/ledger',
  icon: 'journal-outline',
  title: 'Ledger',
  subtitle: 'Manual journal adjustments your accountant tells you to make.',
};

const ACCOUNT_ENTRY: Entry = {
  href: '/more/team',
  icon: 'people-outline',
  title: 'Team',
  subtitle: 'See who has access and invite teammates by email.',
};

const COMPANIES_ENTRY: Entry = {
  href: '/more/companies',
  icon: 'briefcase-outline',
  title: 'Companies',
  subtitle: 'Switch between the companies in this workspace, or add another.',
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
    subtitle: 'Profit & loss, who owes you, sales, tax, top products, and more.',
  },
];

const SETTINGS_ENTRIES: Entry[] = [
  {
    href: '/more/business',
    icon: 'business-outline',
    title: 'Business',
    subtitle: 'Address, phone, and logo on your invoices, plus your reply-to email.',
  },
  {
    href: '/more/accounts',
    icon: 'wallet-outline',
    title: 'Accounts',
    subtitle: 'The bank accounts, cards and cash your money actually sits in.',
  },
  {
    href: '/more/tax-policies',
    icon: 'receipt-outline',
    title: 'Tax policies',
    subtitle: 'Named sales-tax rates you apply to items and invoice lines.',
  },
  {
    href: '/more/payments',
    icon: 'card-outline',
    title: 'Payments',
    subtitle: 'Connect Stripe and list the other ways contacts can pay you.',
  },
  {
    href: '/more/email',
    icon: 'mail-outline',
    title: 'Email templates',
    subtitle: 'Customize the subject and message your contacts receive.',
  },
  {
    href: '/more/privacy',
    icon: 'shield-checkmark-outline',
    title: 'Privacy',
    subtitle: 'Choose whether to share anonymous usage data.',
  },
];

// Always visible (every role) — just shows the app version.
const ABOUT_ENTRY: Entry = {
  href: '/more/about',
  icon: 'information-circle-outline',
  title: 'About',
  subtitle: 'The app version running on this device.',
};

export default function MoreHub() {
  const router = useRouter();
  const [accountName, setAccountName] = useState<string | null>(null);
  const [multiAccount, setMultiAccount] = useState(false);
  const [companyCount, setCompanyCount] = useState(0);
  // Business / Payments / Email all edit company settings — hide the whole
  // section for roles without settings:manage (the API 403s those writes).
  const canManageSettings = useMay('settings:manage');
  // The Ledger (manual adjustments) — owner/admin/accountant only.
  const canAdjustLedger = useMay('ledger:adjust');

  // Resolve the active account name (header) + whether the account/company
  // switchers are worth showing. /api/me is a bootstrap route (no x-account-id);
  // /api/companies is tenant-scoped (stamped from the active account).
  useFocusEffect(
    useCallback(() => {
      let active = true;
      Promise.all([api.api.me.$get(), api.api.companies.$get(), getActiveAccountId()])
        .then(async ([meRes, compRes, activeId]) => {
          if (!active || !meRes.ok) return;
          const { memberships } = await meRes.json();
          setMultiAccount(memberships.length > 1);
          const current = memberships.find((m) => m.accountId === activeId) ?? memberships[0];
          setAccountName(current?.name ?? null);
          if (compRes.ok) setCompanyCount((await compRes.json()).companies.length);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  // Companies entry when there's a choice to make (more than one) or the role
  // can add one; Switch account only with somewhere to switch to; Activity
  // always. Team always.
  const accountEntries: Entry[] = [ACCOUNT_ENTRY];
  if (companyCount > 1 || canManageSettings) accountEntries.push(COMPANIES_ENTRY);
  if (multiAccount) accountEntries.push(SWITCH_ENTRY);
  accountEntries.push(ACTIVITY_ENTRY);

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">More</Text>
        <Text className="mt-2 font-serif text-3xl font-light text-ink">{accountName ?? ' '}</Text>

        <Section
          label="Account"
          entries={[SEARCH_ENTRY, PROFILE_ENTRY]}
          onOpen={(href) => router.push(href)}
        />
        <Section
          label="Sales"
          entries={[...SALES_ENTRIES, JOBS_ENTRY]}
          onOpen={(href) => router.push(href)}
        />
        <Section
          label="Purchases"
          entries={[BILLS_ENTRY, MILEAGE_ENTRY, OWNER_MONEY_ENTRY]}
          onOpen={(href) => router.push(href)}
        />
        <Section label="Workspace" entries={accountEntries} onOpen={(href) => router.push(href)} />
        <Section
          label="Catalog & reports"
          entries={CATALOG_ENTRIES}
          onOpen={(href) => router.push(href)}
        />
        {canAdjustLedger ? (
          <Section
            label="Accounting"
            entries={[LEDGER_ENTRY]}
            onOpen={(href) => router.push(href)}
          />
        ) : null}
        {canManageSettings ? (
          <Section
            label="Settings"
            entries={SETTINGS_ENTRIES}
            onOpen={(href) => router.push(href)}
          />
        ) : null}
        <Section label="About" entries={[ABOUT_ENTRY]} onOpen={(href) => router.push(href)} />
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <View className="mt-3 gap-4">
        {entries.map((e) => (
          <Pressable
            key={e.href}
            onPress={() => onOpen(e.href)}
            className="flex-row items-center gap-4 rounded-sm border border-ink/10 bg-cream-warm p-5 active:bg-cream"
          >
            <Ionicons name={e.icon} size={24} className="text-gold-deep" />
            <View className="flex-1">
              <Text className="font-serif text-lg text-ink">{e.title}</Text>
              <Text className="mt-1 text-xs text-ink-subtle">{e.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} className="text-ink-subtle" />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
