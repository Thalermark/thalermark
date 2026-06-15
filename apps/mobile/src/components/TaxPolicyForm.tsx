import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Checkbox } from './Checkbox';

// Shared tax-policy form for more/tax-policies/new + [id]/edit — mirrors the
// ItemForm pattern (dumb + controlled: parent owns values, runs the zod parse,
// feeds fieldErrors back). A policy is a name + a percent rate + a default flag.
export type TaxPolicyFormValues = {
  name: string;
  ratePct: string;
  isDefault: boolean;
};

export function TaxPolicyForm({
  backLabel,
  onBack,
  title,
  submitLabel,
  values,
  onChangeField,
  onToggleDefault,
  fieldErrors,
  formError,
  submitting,
  canSubmit,
  onSubmit,
}: {
  backLabel: string;
  onBack: () => void;
  title: string;
  submitLabel: string;
  values: TaxPolicyFormValues;
  onChangeField: (key: 'name' | 'ratePct', val: string) => void;
  onToggleDefault: () => void;
  fieldErrors: Partial<Record<'name' | 'ratePct', string>>;
  formError: string | null;
  submitting: boolean;
  canSubmit: boolean;
  onSubmit: () => void;
}) {
  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerClassName="px-6 pt-6 pb-16" keyboardShouldPersistTaps="handled">
          <Pressable onPress={onBack}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink/60">
              ← {backLabel}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">{title}</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 space-y-5">
            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Name *
              </Text>
              <TextInput
                value={values.name}
                onChangeText={(t) => onChangeField('name', t)}
                placeholder="General, Reduced, Exempt…"
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
              {fieldErrors.name ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.name}</Text>
              ) : null}
            </View>

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">
                Rate (%)
              </Text>
              <TextInput
                value={values.ratePct}
                onChangeText={(t) => onChangeField('ratePct', t)}
                keyboardType="decimal-pad"
                placeholder="8.25"
                className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
              />
              {fieldErrors.ratePct ? (
                <Text className="mt-1 text-xs text-oxblood">{fieldErrors.ratePct}</Text>
              ) : (
                <Text className="mt-1 text-xs text-ink/50">A percentage, e.g. 8.25 for 8.25%.</Text>
              )}
            </View>

            <Checkbox
              label="Make this the default for new taxable lines"
              value={values.isDefault}
              onToggle={onToggleDefault}
            />

            <Pressable
              onPress={onSubmit}
              disabled={!canSubmit}
              className="mt-2 rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
            >
              {submitting ? (
                <ActivityIndicator color="#f4ede0" />
              ) : (
                <Text className="text-center text-sm font-medium text-cream">{submitLabel}</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
