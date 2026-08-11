import type { ChartValue, ValueFormat } from './types.js';
import { toNumber } from './value.js';

// What a chart prints where a number goes.
//
// THE EM DASH IS THE POINT OF THIS FILE. A null value renders '—', never
// '$0.00'. reports/job-margin/+page.svelte:182-188 carries the incident: a job
// with costs recorded and revenue still to come showed a $0.00 margin, and the
// user read it as having lost money. Zero and unknown are different claims, and
// only one of them is safe to make.
const DASH = '—';

// en-US throughout, matching every other money surface in the product. Built
// once rather than per call — this runs per tick and per table cell.
const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const COUNT = new Intl.NumberFormat('en-US');

export function formatValue(value: ChartValue, format: ValueFormat = 'money'): string {
  const n = toNumber(value);
  if (n === null) return DASH;

  switch (format) {
    case 'money':
      return MONEY.format(n);
    case 'percent':
      // Fed a fraction (0.42), printed as a percentage. Whole numbers only:
      // a chart axis reading '42.7%' is precision nobody asked for.
      return `${Math.round(n * 100)}%`;
    case 'hours':
      // One decimal, because half an hour is a real unit of work and 7.5 reads
      // better than 7 hours 30 minutes on an axis.
      return `${COUNT.format(Math.round(n * 10) / 10)}h`;
    default:
      return COUNT.format(n);
  }
}

// Axis ticks want the same units in less space — '$2.4k', not '$2,400.00'.
// Only money compacts; a count of 2,400 invoices is already short, and
// compacting hours would round away the half.
export function formatTick(value: ChartValue, format: ValueFormat = 'money'): string {
  const n = toNumber(value);
  if (n === null) return DASH;
  if (format !== 'money') return formatValue(value, format);

  const abs = Math.abs(n);
  if (abs >= 1000) {
    const compact = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    return compact.format(n);
  }
  return MONEY.format(n);
}
