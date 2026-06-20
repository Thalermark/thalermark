import { type Capability, customerCreateSchema, itemCreateSchema } from '@thalermark/validation';

// Drives the generic CSV importer (Settings → Import). One descriptor per
// importable entity; the import page is entirely parameterized by these, so
// adding an entity later = one entry here (no new UI). Only the two ledger-free
// entities live here for the alpha — anything that posts journal entries is out
// of scope (see the import plan).

export type ImportEntityKey = 'customers' | 'items';

export type ImportField = {
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  // Normalized synonym tokens (lowercase, alphanumeric only) used to auto-map a
  // CSV header to this field. Include the field key's own normalized form too.
  synonyms: string[];
  // CSV cell text → typed value. `undefined` means "leave unset" so the create
  // schema's default / optional applies. Money + quantity strip currency
  // punctuation so a "$1,250.00" cell becomes the "1250.00" moneyString wants.
  coerce: (raw: string) => string | boolean | undefined;
};

export type ValidatedRow =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export type ImportEntity = {
  key: ImportEntityKey;
  label: string;
  // Hides the entity for roles that can't create it (UX only — the API gate is
  // authoritative). customers:write and sales:write both resolve to
  // owner/admin/member, so the two entities surface together.
  cap: Capability;
  href: string;
  fields: ImportField[];
  // Validate one coerced row with the create schema minus companyId — the exact
  // server contract, so the preview never green-lights a row the API rejects.
  validateRow: (row: Record<string, unknown>) => ValidatedRow;
  // Soft duplicate key from a validated row (lowercased name) for the preview's
  // "may already exist" flag. null = no key (won't be flagged).
  dupeKey: (row: Record<string, unknown>) => string | null;
};

const text = (raw: string): string | undefined => {
  const s = raw.trim();
  return s === '' ? undefined : s;
};
const upper = (raw: string): string | undefined => {
  const s = raw.trim().toUpperCase();
  return s === '' ? undefined : s;
};
const money = (raw: string): string | undefined => {
  const s = raw.replace(/[$,\s]/g, '');
  return s === '' ? undefined : s;
};
const quantity = (raw: string): string | undefined => {
  const s = raw.replace(/[,\s]/g, '');
  return s === '' ? undefined : s;
};
const itemType = (raw: string): string | undefined => {
  const s = raw.trim().toLowerCase();
  if (s === '') return undefined;
  if (s.startsWith('prod') || s === 'good' || s === 'goods') return 'product';
  if (s.startsWith('serv') || s === 'labor' || s === 'labour') return 'service';
  return s; // unrecognized → fails the enum and surfaces as a row error
};
const boolish = (raw: string): boolean | undefined => {
  const s = raw.trim().toLowerCase();
  if (s === '') return undefined;
  return ['1', 'true', 'yes', 'y', 't', 'x', 'taxable'].includes(s);
};

const customerRowSchema = customerCreateSchema.omit({ companyId: true });
const itemRowSchema = itemCreateSchema.omit({ companyId: true });

type ZodIssue = { path: PropertyKey[]; message: string };
function firstIssue(issues: ZodIssue[]): string {
  const i = issues[0];
  if (!i) return 'invalid';
  const field = i.path[0];
  return field !== undefined ? `${String(field)}: ${i.message}` : i.message;
}

const nameDupeKey = (row: Record<string, unknown>): string | null => {
  const n = row.name;
  return typeof n === 'string' && n.trim() !== '' ? n.trim().toLowerCase() : null;
};

export const IMPORT_ENTITIES: ImportEntity[] = [
  {
    key: 'customers',
    label: 'Customers',
    cap: 'customers:write',
    href: '/customers',
    dupeKey: nameDupeKey,
    validateRow: (row) => {
      const res = customerRowSchema.safeParse(row);
      return res.success
        ? { ok: true, value: res.data }
        : { ok: false, error: firstIssue(res.error.issues) };
    },
    fields: [
      {
        key: 'name',
        label: 'Name',
        required: true,
        synonyms: [
          'name',
          'customer',
          'customername',
          'client',
          'clientname',
          'company',
          'companyname',
          'fullname',
          'displayname',
          'contact',
        ],
        coerce: text,
      },
      { key: 'email', label: 'Email', synonyms: ['email', 'emailaddress', 'mail'], coerce: text },
      {
        key: 'phone',
        label: 'Phone',
        synonyms: ['phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'cell'],
        coerce: text,
      },
      {
        key: 'addressLine1',
        label: 'Address line 1',
        synonyms: [
          'address',
          'addressline1',
          'address1',
          'street',
          'streetaddress',
          'billingaddress',
        ],
        coerce: text,
      },
      {
        key: 'addressLine2',
        label: 'Address line 2',
        synonyms: ['addressline2', 'address2', 'suite', 'unit', 'apt', 'apartment'],
        coerce: text,
      },
      { key: 'city', label: 'City', synonyms: ['city', 'town'], coerce: text },
      {
        key: 'region',
        label: 'State / region',
        synonyms: ['region', 'state', 'province', 'stateprovince', 'county'],
        coerce: text,
      },
      {
        key: 'postalCode',
        label: 'Postal code',
        synonyms: ['postalcode', 'postal', 'zip', 'zipcode', 'postcode'],
        coerce: text,
      },
      {
        key: 'country',
        label: 'Country',
        hint: '2-letter ISO code, e.g. US',
        synonyms: ['country', 'countrycode'],
        coerce: upper,
      },
      {
        key: 'notes',
        label: 'Notes',
        synonyms: ['notes', 'note', 'memo', 'comment', 'comments'],
        coerce: text,
      },
    ],
  },
  {
    key: 'items',
    label: 'Items',
    cap: 'sales:write',
    href: '/settings/items',
    dupeKey: nameDupeKey,
    validateRow: (row) => {
      const res = itemRowSchema.safeParse(row);
      return res.success
        ? { ok: true, value: res.data }
        : { ok: false, error: firstIssue(res.error.issues) };
    },
    fields: [
      {
        key: 'name',
        label: 'Name',
        required: true,
        synonyms: [
          'name',
          'item',
          'itemname',
          'product',
          'productname',
          'service',
          'servicename',
          'title',
        ],
        coerce: text,
      },
      {
        key: 'description',
        label: 'Description',
        synonyms: ['description', 'desc', 'details', 'notes'],
        coerce: text,
      },
      {
        key: 'type',
        label: 'Type',
        hint: 'product or service',
        synonyms: ['type', 'itemtype', 'kind'],
        coerce: itemType,
      },
      {
        key: 'unitPrice',
        label: 'Unit price',
        synonyms: ['unitprice', 'price', 'rate', 'amount', 'cost', 'unitcost', 'priceeach'],
        coerce: money,
      },
      {
        key: 'unitLabel',
        label: 'Unit',
        hint: 'hour, sq ft, …',
        synonyms: ['unitlabel', 'unit', 'uom', 'unitofmeasure', 'per'],
        coerce: text,
      },
      {
        key: 'defaultQuantity',
        label: 'Default qty',
        synonyms: ['defaultquantity', 'quantity', 'qty', 'defaultqty'],
        coerce: quantity,
      },
      {
        key: 'taxable',
        label: 'Taxable',
        hint: 'yes / no',
        synonyms: ['taxable', 'istaxable', 'tax'],
        coerce: boolish,
      },
    ],
  },
];

export function entityByKey(key: ImportEntityKey): ImportEntity {
  const found = IMPORT_ENTITIES.find((e) => e.key === key);
  if (!found) throw new Error(`unknown import entity: ${key}`);
  return found;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Best-effort auto-map: each field claims the first not-yet-used CSV header
// whose normalized name matches the field key or one of its synonyms. Returns a
// fieldKey → header map (only for matched fields).
export function autoMap(entity: ImportEntity, headers: string[]): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  for (const f of entity.fields) {
    const tokens = new Set([norm(f.key), ...f.synonyms]);
    const match = headers.find((h) => !used.has(h) && tokens.has(norm(h)));
    if (match) {
      out[f.key] = match;
      used.add(match);
    }
  }
  return out;
}
