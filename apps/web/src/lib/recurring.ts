// Human cadence summary for a schedule's frequency + interval. Shared by the
// recurring list and detail pages so they read identically.
//   weekly/1  → "Weekly"      monthly/1 → "Monthly"     yearly/1 → "Yearly"
//   weekly/2  → "Every 2 weeks"   monthly/3 → "Every 3 months"
const UNIT: Record<string, string> = { weekly: 'week', monthly: 'month', yearly: 'year' };
const SIMPLE: Record<string, string> = { weekly: 'Weekly', monthly: 'Monthly', yearly: 'Yearly' };

export function cadenceLabel(frequency: string, intervalCount: number): string {
  if (intervalCount <= 1) return SIMPLE[frequency] ?? frequency;
  const unit = UNIT[frequency] ?? frequency;
  return `Every ${intervalCount} ${unit}s`;
}
