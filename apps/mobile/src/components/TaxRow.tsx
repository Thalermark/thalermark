import { Pressable, Text, View } from 'react-native';
import type { TaxPolicyLite } from '../lib/line-tax';
import { Checkbox } from './Checkbox';

// Per-line tax controls shared by the invoice / estimate / recurring line-item
// forms: a Taxable toggle, an inline policy picker (chips — policies are few),
// and the computed line tax. The parent owns the row state; this is dumb.
export function TaxRow({
  taxPolicies,
  taxable,
  taxPolicyId,
  lineTaxAmount,
  onToggle,
  onSelectPolicy,
}: {
  taxPolicies: TaxPolicyLite[];
  taxable: boolean;
  taxPolicyId: string;
  lineTaxAmount: string;
  onToggle: () => void;
  onSelectPolicy: (id: string) => void;
}) {
  return (
    <View className="mt-2">
      <Checkbox label="Taxable" value={taxable} onToggle={onToggle} />
      {taxable ? (
        taxPolicies.length > 0 ? (
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            {taxPolicies.map((p) => {
              const selected = p.id === taxPolicyId;
              return (
                <Pressable
                  key={p.id}
                  onPress={() => onSelectPolicy(p.id)}
                  className={`rounded-sm border px-2.5 py-1 ${selected ? 'border-gold-deep bg-gold-deep/10' : 'border-ink/15 bg-cream'}`}
                >
                  <Text className={`text-xs ${selected ? 'text-gold-deep' : 'text-ink-muted'}`}>
                    {p.name} ({Number(p.ratePct)}%)
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Text className="mt-1 text-xs text-ink-subtle">
            No tax policies — add one under More → Tax policies.
          </Text>
        )
      ) : null}
      {taxable ? (
        <Text className="mt-1 text-right font-mono text-[10px] tabular-nums text-ink-subtle">
          +{lineTaxAmount} tax
        </Text>
      ) : null}
    </View>
  );
}
