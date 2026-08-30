import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../../lib/api';
import { useMay } from '../../../lib/role';

// Settings → AI — native mirror of apps/web's /settings/ai. Connect a provider,
// verify it, and AI turns on for everyone in the workspace.
//
// This screen is the reason receipt auto-fill can work at all: extraction, the
// cash-flow nudges and expense categorization all read the one connection stored
// here. Until it existed on mobile, a phone-only user could photograph a receipt
// and then had to open a laptop to make the extraction work (TMC-283).
//
// Two invariants worth not re-deriving:
//   - A save always lands UNVERIFIED. The health gate keeps AI off until Verify
//     passes, so "saved" is never the same as "working" and the copy must not
//     imply it is.
//   - A blank API key field means KEEP THE STORED KEY, not "clear it". The key
//     is never shown again after saving, so the field shows a masked hint and
//     only replaces on a real retype.
type Preset = {
  id: string;
  label: string;
  needsKey: boolean;
  requiresBaseUrl: boolean;
  baseUrl: string | null;
  models: { vision?: string; reasoning?: string; fast?: string } | null;
};

type Connection = {
  provider: string;
  baseUrl: string | null;
  keyHint: string | null;
  hasKey: boolean;
  modelVision: string | null;
  modelReasoning: string | null;
  modelFast: string | null;
  timeoutSeconds: number | null;
  status: string;
  lastOkAt: string | null;
  lastError: string | null;
};

type Loaded = {
  connection: Connection | null;
  presets: Preset[];
  allowPrivate: boolean;
  allowedEndpoints: string[];
};

type State =
  | { kind: 'loading' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' }
  | { kind: 'error' }
  | ({ kind: 'ready' } & Loaded);

// Endpoint-rejection reasons → copy. `private_address` points at the operator
// flag because on a self-host the admin reading this is usually also the person
// who can set it.
function endpointMessage(reason: string): string {
  switch (reason) {
    case 'private_address':
      return 'That looks like a private or LAN address. Your server administrator can allow it with AI_ALLOWED_ENDPOINTS, or open all private ranges with AI_ALLOW_PRIVATE_ENDPOINTS.';
    case 'blocked_address':
      return 'That address is blocked for safety (link-local or cloud metadata) and can never be used.';
    case 'unsupported_scheme':
      return 'The endpoint URL must start with http:// or https://.';
    case 'dns_failed':
      return "Couldn't resolve that endpoint's host. Check the URL.";
    default:
      return 'That endpoint URL is not valid.';
  }
}

function statusChip(status: string | undefined): { text: string; cls: string } {
  switch (status) {
    case 'ready':
      return { text: 'AI ready', cls: 'bg-sage/20 text-ink' };
    case 'unverified':
      return { text: 'Verify to enable AI', cls: 'bg-gold/25 text-ink' };
    case 'error':
      return { text: 'Needs attention', cls: 'bg-oxblood/15 text-oxblood' };
    default:
      return { text: 'Not configured', cls: 'bg-ink/10 text-ink-subtle' };
  }
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

export default function AiSettings() {
  const router = useRouter();
  const canManage = useMay('settings:manage');
  const [state, setState] = useState<State>({ kind: 'loading' });

  const [provider, setProvider] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelVision, setModelVision] = useState('');
  const [modelReasoning, setModelReasoning] = useState('');
  const [modelFast, setModelFast] = useState('');
  // Timeout override (Advanced), held as the typed string; '' = defaults.
  const [timeoutSeconds, setTimeoutSeconds] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await api.api.settings.ai.$get();
    if (res.status === 403) return setState({ kind: 'forbidden' });
    if (res.status === 503) return setState({ kind: 'unavailable' });
    if (!res.ok) return setState({ kind: 'error' });
    const body = (await res.json()) as Loaded;
    setState({ kind: 'ready', ...body });
    // Seed the form from the stored connection, falling back to the first preset
    // so the picker is never empty on a fresh account.
    const initial = body.connection?.provider ?? body.presets[0]?.id ?? '';
    setProvider((p) => p || initial);
    setBaseUrl(body.connection?.baseUrl ?? '');
    setModelVision(body.connection?.modelVision ?? '');
    setModelReasoning(body.connection?.modelReasoning ?? '');
    setModelFast(body.connection?.modelFast ?? '');
    setTimeoutSeconds(
      body.connection?.timeoutSeconds != null ? String(body.connection.timeoutSeconds) : '',
    );
  }, []);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      load().catch(() => {
        if (alive) setState({ kind: 'error' });
      });
      return () => {
        alive = false;
      };
    }, [load]),
  );

  async function onSave() {
    setError(null);
    setSaved(false);
    setVerifyMsg(null);
    if (!provider) {
      setError('Choose a provider.');
      return;
    }
    // Timeout override: blank = defaults; a value is whole seconds, bounds
    // mirroring the schema so a typo fails with a sentence, not a Zod dump.
    const timeoutRaw = timeoutSeconds.trim();
    const timeout = timeoutRaw === '' ? null : Number(timeoutRaw);
    if (timeout !== null && (!Number.isInteger(timeout) || timeout < 30 || timeout > 300)) {
      setError('Timeout must be a whole number between 30 and 300 seconds.');
      return;
    }
    setActing(true);
    try {
      const res = await api.api.settings.ai.$put({
        json: {
          provider,
          baseUrl: baseUrl.trim() || null,
          // Omitted when blank so the stored key survives a save that only
          // changes, say, a model override.
          ...(apiKey ? { apiKey } : {}),
          modelVision: modelVision.trim() || null,
          modelReasoning: modelReasoning.trim() || null,
          modelFast: modelFast.trim() || null,
          timeoutSeconds: timeout,
        },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: string;
          reason?: string;
        } | null;
        setError(
          body?.error === 'endpoint_rejected'
            ? endpointMessage(body?.reason ?? '')
            : body?.error === 'unknown_provider'
              ? 'That provider is not available.'
              : body?.error === 'base_url_required'
                ? 'This provider needs an endpoint URL.'
                : 'Could not save. Check the fields and try again.',
        );
        return;
      }
      setApiKey('');
      setSaved(true);
      await load();
    } finally {
      setActing(false);
    }
  }

  async function onVerify() {
    setError(null);
    setSaved(false);
    setVerifyMsg(null);
    setActing(true);
    try {
      const res = await api.api.settings.ai.verify.$post();
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setVerifyMsg({
          ok: false,
          text:
            body?.error === 'no_connection'
              ? 'Save a connection first.'
              : 'Verification could not run.',
        });
        return;
      }
      const { result, vision } = (await res.json()) as {
        result: { ok: boolean; latencyMs?: number; error?: string };
        // The second verify stage (TMC-296): the vision-role probe, null when
        // the fast probe already failed. ok:false here is the "text works but
        // receipt reading doesn't" verdict that used to be invisible.
        vision: { ok: boolean; latencyMs?: number; error?: string } | null;
      };
      setVerifyMsg(
        result.ok && vision && !vision.ok
          ? {
              ok: false,
              text: `Text model verified, but receipt reading failed: ${vision.error ?? 'unknown error'}`,
            }
          : result.ok
            ? {
                ok: true,
                text: `${
                  result.latencyMs
                    ? `Verified. AI is live, responded in ${result.latencyMs} ms.`
                    : 'Verified. AI is live.'
                }${vision?.ok ? ' Receipt reading works too.' : ''}`,
              }
            : { ok: false, text: `Verification failed: ${result.error ?? 'unknown error'}` },
      );
      await load();
    } finally {
      setActing(false);
    }
  }

  function onRemove() {
    Alert.alert(
      'Remove this AI connection?',
      'AI features switch off for everyone in this workspace: receipt auto-fill, expense categories, cash-flow nudges and late-payer flags all stop. Your stored key is deleted and is never shown again anywhere, so you would need to paste it in fresh to turn AI back on. Nothing already saved to your books changes.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setActing(true);
            api.api.settings.ai
              .$delete()
              .then(async (res) => {
                if (!res.ok) {
                  setError('Could not remove the connection.');
                  return;
                }
                setApiKey('');
                setBaseUrl('');
                setVerifyMsg(null);
                setSaved(false);
                await load();
              })
              .catch(() => setError('Could not remove the connection.'))
              .finally(() => setActing(false));
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-cream" edges={['top']}>
      <ScrollView contentContainerClassName="px-6 pt-6 pb-16">
        <Text
          onPress={() => router.push('/more')}
          className="font-mono text-xs uppercase tracking-widest text-ink-subtle"
        >
          ← More
        </Text>
        <Text className="mt-3 font-serif text-3xl font-light text-ink">AI</Text>
        <Text className="mt-3 text-sm leading-relaxed text-ink-muted">
          AI powers receipt auto-fill, expense categorization, and cash-flow nudges. Connect a
          provider, verify it, and it turns on for everyone in this workspace. Your key is stored
          encrypted and never shown again.
        </Text>

        {state.kind === 'loading' ? (
          <View className="mt-12 items-center">
            <ActivityIndicator className="text-ink" />
          </View>
        ) : state.kind === 'forbidden' || !canManage ? (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="text-sm text-ink-muted">
              You need admin access to manage AI for this workspace.
            </Text>
          </View>
        ) : state.kind === 'unavailable' ? (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="text-sm text-ink-muted">AI is not available on this server.</Text>
          </View>
        ) : state.kind === 'error' ? (
          <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
            <Text className="text-sm text-ink-muted">Couldn't load AI settings.</Text>
            <Pressable onPress={() => void load()} className="mt-3 self-start">
              <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          <AiForm
            state={state}
            provider={provider}
            setProvider={setProvider}
            baseUrl={baseUrl}
            setBaseUrl={setBaseUrl}
            apiKey={apiKey}
            setApiKey={setApiKey}
            modelVision={modelVision}
            setModelVision={setModelVision}
            modelReasoning={modelReasoning}
            setModelReasoning={setModelReasoning}
            modelFast={modelFast}
            setModelFast={setModelFast}
            timeoutSeconds={timeoutSeconds}
            setTimeoutSeconds={setTimeoutSeconds}
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            acting={acting}
            error={error}
            saved={saved}
            verifyMsg={verifyMsg}
            onSave={onSave}
            onVerify={onVerify}
            onRemove={onRemove}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function AiForm({
  state,
  provider,
  setProvider,
  baseUrl,
  setBaseUrl,
  apiKey,
  setApiKey,
  modelVision,
  setModelVision,
  modelReasoning,
  setModelReasoning,
  modelFast,
  setModelFast,
  timeoutSeconds,
  setTimeoutSeconds,
  showAdvanced,
  setShowAdvanced,
  acting,
  error,
  saved,
  verifyMsg,
  onSave,
  onVerify,
  onRemove,
}: {
  state: { kind: 'ready' } & Loaded;
  provider: string;
  setProvider: (v: string) => void;
  baseUrl: string;
  setBaseUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  modelVision: string;
  setModelVision: (v: string) => void;
  modelReasoning: string;
  setModelReasoning: (v: string) => void;
  modelFast: string;
  setModelFast: (v: string) => void;
  timeoutSeconds: string;
  setTimeoutSeconds: (v: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  acting: boolean;
  error: string | null;
  saved: boolean;
  verifyMsg: { ok: boolean; text: string } | null;
  onSave: () => void;
  onVerify: () => void;
  onRemove: () => void;
}) {
  const { connection, presets, allowPrivate, allowedEndpoints } = state;
  const preset = presets.find((p) => p.id === provider);
  const needsKey = preset?.needsKey ?? true;
  const showBaseUrl = !!preset && (preset.requiresBaseUrl || preset.baseUrl != null);
  const chip = statusChip(connection?.status);

  return (
    <>
      <View className="mt-6 flex-row items-center gap-3">
        <View className={`rounded-sm px-2 py-1 ${chip.cls}`}>
          <Text className={`font-mono text-[10px] uppercase tracking-widest ${chip.cls}`}>
            {chip.text}
          </Text>
        </View>
        {connection?.status === 'ready' && connection.lastOkAt ? (
          <Text className="text-xs text-ink-subtle">last ok {ago(connection.lastOkAt)}</Text>
        ) : null}
      </View>

      {connection?.status === 'unverified' ? (
        <Text className="mt-3 text-sm text-ink-muted">
          Saved, but not verified. AI stays off until you tap Verify.
        </Text>
      ) : connection?.status === 'error' && connection.lastError ? (
        <Text className="mt-3 text-sm text-oxblood">{connection.lastError}</Text>
      ) : null}

      {verifyMsg ? (
        <View className="mt-4 rounded-sm border border-ink/15 bg-cream-warm p-4">
          <Text className={`text-sm ${verifyMsg.ok ? 'text-ink-muted' : 'text-oxblood'}`}>
            {verifyMsg.text}
          </Text>
        </View>
      ) : null}

      <View className="mt-8 rounded-sm border border-ink/15 bg-cream-warm p-6">
        <Text className="font-mono text-xs uppercase tracking-widest text-ink-subtle">
          Provider
        </Text>
        <View className="mt-3 gap-2">
          {presets.map((p) => (
            <Pressable
              key={p.id}
              onPress={() => setProvider(p.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: provider === p.id }}
              className={`flex-row items-center justify-between rounded-sm border px-4 py-3 ${
                provider === p.id ? 'border-gold-deep bg-cream' : 'border-ink/15'
              }`}
            >
              <Text className="text-ink">{p.label}</Text>
              {provider === p.id ? (
                <Text className="font-mono text-[10px] uppercase tracking-widest text-gold-deep">
                  Selected
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>

        {showBaseUrl ? (
          <>
            <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Endpoint URL
            </Text>
            <TextInput
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder={preset?.baseUrl ?? 'https://…/v1'}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              className="mt-2 border-b border-field py-2 text-ink"
            />
            <Text className="mt-2 text-xs text-ink-subtle">
              {allowedEndpoints.length > 0
                ? `Your server allows these private endpoints: ${allowedEndpoints.join(', ')}. Others on a private or LAN address are blocked.`
                : allowPrivate
                  ? 'This server allows private and LAN endpoints, for example a local Ollama.'
                  : 'Private and LAN addresses are blocked. Your server administrator can allow one by setting AI_ALLOWED_ENDPOINTS.'}
            </Text>
          </>
        ) : null}

        {needsKey ? (
          <>
            <Text className="mt-5 font-mono text-xs uppercase tracking-widest text-ink-subtle">
              API key
            </Text>
            <TextInput
              value={apiKey}
              onChangeText={setApiKey}
              placeholder={connection?.hasKey ? (connection.keyHint ?? '••••') : 'Paste your key'}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              className="mt-2 border-b border-field py-2 text-ink"
            />
            {connection?.hasKey ? (
              <Text className="mt-2 text-xs text-ink-subtle">
                A key is stored. Leave this blank to keep it.
              </Text>
            ) : null}
          </>
        ) : null}

        <Pressable onPress={() => setShowAdvanced(!showAdvanced)} className="mt-5 self-start">
          <Text className="font-mono text-xs uppercase tracking-widest text-gold-deep">
            {showAdvanced ? '− Hide' : '+ Advanced'} model overrides
          </Text>
        </Pressable>

        {showAdvanced ? (
          <View className="mt-3 rounded-sm border border-ink/15 bg-cream p-4">
            <Text className="text-xs text-ink-subtle">
              Leave blank for this provider's defaults. Roles map by task, not vendor.
            </Text>
            <ModelField
              label="Vision (reads receipts)"
              value={modelVision}
              onChange={setModelVision}
              placeholder={preset?.models?.vision ?? ''}
            />
            <ModelField
              label="Reasoning (nudges)"
              value={modelReasoning}
              onChange={setModelReasoning}
              placeholder={preset?.models?.reasoning ?? ''}
            />
            <ModelField
              label="Fast (categorization)"
              value={modelFast}
              onChange={setModelFast}
              placeholder={preset?.models?.fast ?? ''}
            />
            <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
              Timeout (seconds)
            </Text>
            <TextInput
              value={timeoutSeconds}
              onChangeText={setTimeoutSeconds}
              placeholder="auto"
              keyboardType="number-pad"
              className="mt-2 border-b border-field py-2 text-ink"
            />
            <Text className="mt-2 text-xs text-ink-subtle">
              How long to wait for the model before giving up, 30–300. Leave blank for the defaults.
              Raise this if a local model is slow — reading a receipt can then take a few minutes.
            </Text>
          </View>
        ) : null}

        {error ? <Text className="mt-4 text-sm text-oxblood">{error}</Text> : null}
        {saved ? (
          <Text className="mt-4 text-sm text-ink-muted">Saved. Tap Verify to turn AI on.</Text>
        ) : null}

        <View className="mt-6 flex-row items-center gap-3">
          <Pressable
            onPress={onSave}
            disabled={acting}
            className="rounded-sm bg-ink px-4 py-3 active:bg-gold-deep disabled:opacity-50"
          >
            <Text className="text-sm font-medium text-cream">Save</Text>
          </Pressable>
          {connection ? (
            <Pressable
              onPress={onVerify}
              disabled={acting}
              className="rounded-sm border border-ink/20 px-4 py-3 active:bg-cream disabled:opacity-50"
            >
              <Text className="text-sm font-medium text-ink">Verify</Text>
            </Pressable>
          ) : null}
          {acting ? <ActivityIndicator className="text-ink" /> : null}
        </View>

        {connection ? (
          <Pressable onPress={onRemove} disabled={acting} className="mt-5 self-start">
            <Text className="font-mono text-xs uppercase tracking-widest text-oxblood">
              Remove connection
            </Text>
          </Pressable>
        ) : null}
      </View>
    </>
  );
}

function ModelField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <>
      <Text className="mt-4 font-mono text-xs uppercase tracking-widest text-ink-subtle">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        className="mt-2 border-b border-field py-2 text-ink"
      />
    </>
  );
}
