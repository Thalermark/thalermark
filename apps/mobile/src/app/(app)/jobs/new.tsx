import { jobCreateSchema } from '@thalermark/validation';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
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
import { pickActiveCompany } from '../../../lib/active-company';
import { api } from '../../../lib/api';

// Mirror of apps/web's /jobs/new. The API doesn't auto-pick a company, so this
// screen resolves the active one for the required companyId — same as
// /contacts/new.
//
// Deliberately just a name: a job with no customer and no dates is a perfectly
// good container, and most will start that way. Anything more up front is a form
// standing between the user and the thing they wanted to do.
export default function NewJob() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [bootstrapped, setBootstrapped] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const res = await api.api.companies.$get();
        if (!active) return;
        if (res.ok) {
          const { companies } = await res.json();
          const company = await pickActiveCompany(companies);
          if (active) setCompanyId(company?.id ?? null);
        }
        if (active) setBootstrapped(true);
      })().catch(() => {
        if (active) setBootstrapped(true);
      });
      return () => {
        active = false;
      };
    }, []),
  );

  async function submit() {
    setFieldError(null);
    setFormError(null);
    if (!companyId) {
      setFormError('No company in this workspace.');
      return;
    }
    const parsed = jobCreateSchema.safeParse({ companyId, name });
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Enter a name.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.api.jobs.$post({ json: parsed.data });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFormError(body?.error ?? 'Could not create the job.');
        return;
      }
      const created = await res.json();
      router.replace(`/jobs/${created.id}`);
    } catch {
      setFormError('Could not create the job.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <ScrollView contentContainerClassName="px-6 pb-12 pt-6" keyboardShouldPersistTaps="handled">
          <Pressable onPress={() => router.back()}>
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              ← Jobs
            </Text>
          </Pressable>
          <Text className="mt-3 font-serif text-3xl font-light text-ink">New job</Text>

          {formError ? (
            <View className="mt-6 rounded-sm border border-oxblood/30 bg-oxblood/5 px-4 py-3">
              <Text className="text-sm text-oxblood">{formError}</Text>
            </View>
          ) : null}

          <View className="mt-8">
            <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
              What do you call it
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="The Smith job"
              autoFocus
              maxLength={200}
              returnKeyType="done"
              onSubmitEditing={submit}
              className="mt-2 rounded-sm border border-field bg-cream-warm px-3 py-2.5 text-ink"
            />
            <Text className="mt-2 text-xs text-ink-subtle">
              Whatever you'd say out loud. It only has to make sense to you.
            </Text>
            {fieldError ? <Text className="mt-1 text-xs text-oxblood">{fieldError}</Text> : null}
          </View>

          <Pressable
            onPress={submit}
            disabled={submitting || !bootstrapped}
            className="mt-8 items-center rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
          >
            {submitting ? (
              <ActivityIndicator className="text-cream" />
            ) : (
              <Text className="text-sm font-medium text-cream">Create job</Text>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
