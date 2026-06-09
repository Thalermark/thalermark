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

export function ItemForm({
  backLabel,
  onBack,
  title,
  submitLabel,
  values,
  onChange,
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
      <Text className="font-mono text-xs uppercase tracking-widest text-ink/50">{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType}
        placeholder={placeholder}
        multiline={multiline}
        className="mt-1 rounded-sm border border-ink/15 bg-cream-warm px-3 py-2 text-ink"
      />
      {error ? <Text className="mt-1 text-xs text-oxblood">{error}</Text> : null}
      {hint && !error ? <Text className="mt-1 text-xs text-ink/50">{hint}</Text> : null}
    </View>
  );
}
