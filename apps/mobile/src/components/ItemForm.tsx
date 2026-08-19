import type { LineItemType } from '@thalermark/validation';
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
import type { TaxPolicyLite } from '../lib/line-tax';
import { Checkbox } from './Checkbox';

// Shared catalog-item form for more/items/new + more/items/[id]/edit — the two
// screens render the same five visible fields (web duplicates the markup across
// its new/edit svelte pages; mobile shares it). Dumb + controlled: the parent
// owns the values, runs the zod parse, and feeds fieldErrors back down. Money /
// quantity stay as decimal strings on the wire (see api.ts parity notes).
export type ItemFormValues = {
  name: string;
  description: string;
  unitPrice: string;
  unitLabel: string;
  defaultQuantity: string;
};

export type ItemFieldKey = keyof ItemFormValues;

const TYPE_OPTIONS: { value: LineItemType; label: string }[] = [
  { value: 'service', label: 'Service' },
  { value: 'product', label: 'Product' },
];

export function ItemForm({
  backLabel,
  onBack,
  title,
  submitLabel,
  values,
  onChange,
  type,
  onSelectType,
  taxPolicies,
  taxable,
  taxPolicyId,
  onToggleTaxable,
  onSelectPolicy,
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
  values: ItemFormValues;
  onChange: (key: ItemFieldKey, val: string) => void;
  // Product vs service — drives the hidden-ledger revenue split. A separate prop
  // (not part of ItemFormValues) like taxable, since it's an enum not free text.
  type: LineItemType;
  onSelectType: (t: LineItemType) => void;
  // Taxable flag + default policy (a non-taxable item carries no policy).
  taxPolicies: TaxPolicyLite[];
  taxable: boolean;
  taxPolicyId: string;
  onToggleTaxable: () => void;
  onSelectPolicy: (id: string) => void;
  fieldErrors: Partial<Record<ItemFieldKey, string>>;
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
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              ← {backLabel}
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">{title}</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8 gap-5">
            <Field
              label="Name *"
              value={values.name}
              onChangeText={(t) => onChange('name', t)}
              error={fieldErrors.name}
            />
            <Field
              label="Description"
              value={values.description}
              onChangeText={(t) => onChange('description', t)}
              error={fieldErrors.description}
              hint="Flows into the line item when this is picked."
              multiline
            />
            <Field
              label="Unit price"
              value={values.unitPrice}
              onChangeText={(t) => onChange('unitPrice', t)}
              error={fieldErrors.unitPrice}
              keyboardType="decimal-pad"
              placeholder="0.00"
            />
            <Field
              label="Unit"
              value={values.unitLabel}
              onChangeText={(t) => onChange('unitLabel', t)}
              error={fieldErrors.unitLabel}
              placeholder="hour, sq ft, …"
            />
            <Field
              label="Default qty"
              value={values.defaultQuantity}
              onChangeText={(t) => onChange('defaultQuantity', t)}
              error={fieldErrors.defaultQuantity}
              keyboardType="decimal-pad"
              placeholder="1"
            />

            <View>
              <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                Type
              </Text>
              <View className="mt-1 flex-row gap-2">
                {TYPE_OPTIONS.map((o) => {
                  const selected = o.value === type;
                  return (
                    <Pressable
                      key={o.value}
                      onPress={() => onSelectType(o.value)}
                      className={`rounded-sm border px-3 py-1.5 ${selected ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15 bg-cream'}`}
                    >
                      <Text className={`text-xs ${selected ? 'text-gold-deep' : 'text-ink-muted'}`}>
                        {o.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text className="mt-1 text-xs text-ink-subtle">
                Routes revenue on your books. Most trades & freelance work is a service.
              </Text>
            </View>

            <View className="rounded-sm border border-ink/10 bg-cream-warm p-4">
              <Checkbox
                label="Taxable — charge sales tax when on an invoice"
                value={taxable}
                onToggle={onToggleTaxable}
              />
              {taxable ? (
                taxPolicies.length > 0 ? (
                  <View className="mt-3">
                    <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
                      Tax policy
                    </Text>
                    <View className="mt-2 flex-row flex-wrap gap-2">
                      {taxPolicies.map((p) => {
                        const selected = p.id === taxPolicyId;
                        return (
                          <Pressable
                            key={p.id}
                            onPress={() => onSelectPolicy(p.id)}
                            className={`rounded-sm border px-3 py-1.5 ${selected ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15 bg-cream'}`}
                          >
                            <Text
                              className={`text-xs ${selected ? 'text-gold-deep' : 'text-ink-muted'}`}
                            >
                              {p.name} ({Number(p.ratePct)}%)
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : (
                  <Text className="mt-2 text-xs text-ink-subtle">
                    No tax policies yet. Create one under More → Tax policies.
                  </Text>
                )
              ) : null}
            </View>

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

function Field({
  label,
  value,
  onChangeText,
  error,
  hint,
  keyboardType,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  error?: string;
  hint?: string;
  keyboardType?: 'decimal-pad';
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View>
      <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        multiline={multiline}
        className="mt-1 rounded-sm border border-field bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
      {hint && !error ? <Text className="mt-1 text-xs text-ink-subtle">{hint}</Text> : null}
    </View>
  );
}
