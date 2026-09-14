/**
 * Lectura de cargos recurrentes con sus campos calculados (ver RecurringCharge en shared/types.ts).
 * El calendario vive en server/recurring.ts y el registro automático en server/recurringPost.ts; aquí solo se
 * combinan con los datos de la base. La usan /api/recurring y /api/dashboard.
 */
import { query } from './db.js';
import { round2, todayISO } from './util.js';
import { monthlyEquivalent, nextOccurrences, occurrencesBetween, scheduleLabel } from './recurring.js';
import type { RecurringCharge, RecurringFrequency, RecurringOverview, TxType, UpcomingCharge } from '../shared/types.js';

type RecurringRow = {
  id: number;
  name: string;
  type: TxType;
  amount: number;
  category_id: number | null;
  category_name: string | null;
  category_icon: string | null;
  account_id: number | null;
  account_name: string | null;
  account_bank: string | null;
  credit_card_id: number | null;
  card_name: string | null;
  frequency: RecurringFrequency;
  interval_n: number;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
  start_date: string;
  end_date: string | null;
  active: boolean;
  auto_post: boolean;
  last_posted_date: string | null;
  color: string;
  created_at: Date | string;
  posted_count: number;
  posted_total: number;
};

const RECURRING_SQL = `
  SELECT r.id, r.name, r.type, r.amount, r.category_id, c.name AS category_name, c.icon AS category_icon,
         r.account_id, a.name AS account_name, COALESCE(b.name, a.bank) AS account_bank,
         r.credit_card_id, cc.name AS card_name,
         r.frequency, r.interval_n, r.day_of_month, r.weekday, r.month_of_year, r.start_date, r.end_date,
         r.active, r.auto_post, r.last_posted_date, r.color, r.created_at,
         COALESCE(p.posted_count, 0) AS posted_count,
         COALESCE(p.posted_total, 0) AS posted_total
    FROM recurring_charges r
    LEFT JOIN categories c ON c.id = r.category_id
    LEFT JOIN accounts a ON a.id = r.account_id
    LEFT JOIN banks b ON b.id = a.bank_id
    LEFT JOIN credit_cards cc ON cc.id = r.credit_card_id
    LEFT JOIN (
      SELECT recurring_id, COUNT(*) AS posted_count, SUM(amount) AS posted_total
        FROM transactions
       WHERE recurring_id IS NOT NULL
       GROUP BY recurring_id
    ) p ON p.recurring_id = r.id
   WHERE ($1::int IS NULL OR r.id = $1::int)`;

/** Banco de la cuenta de cada cargo cargado (no forma parte del contrato; sirve para payment_label). */
const accountBanks = new WeakMap<RecurringCharge, string>();

/** Suma días a una fecha 'YYYY-MM-DD' (aritmética de calendario en UTC, sin zona horaria). */
function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const maxDate = (a: string, b: string | null): string => (b !== null && b > a ? b : a);

/** Primer día desde el que se buscan ocurrencias pendientes: max(hoy, last_posted_date + 1 día). */
function pendingFrom(lastPosted: string | null, today: string): string {
  return maxDate(today, lastPosted ? addDays(lastPosted, 1) : null);
}

function toCharge(r: RecurringRow, today: string): RecurringCharge {
  const amount = round2(Number(r.amount) || 0);
  const interval_n = Math.max(1, Number(r.interval_n) || 1);
  const rule = {
    frequency: r.frequency,
    interval_n,
    day_of_month: r.day_of_month ?? null,
    weekday: r.weekday ?? null,
    month_of_year: r.month_of_year ?? null,
    start_date: r.start_date,
    end_date: r.end_date ?? null,
  };
  const active = !!r.active;
  const next_dates = active ? nextOccurrences(rule, pendingFrom(r.last_posted_date ?? null, today), 3) : [];
  const charge: RecurringCharge = {
    id: r.id,
    name: r.name,
    type: r.type,
    amount,
    category_id: r.category_id ?? null,
    category_name: r.category_name ?? null,
    category_icon: r.category_icon ?? null,
    account_id: r.account_id ?? null,
    account_name: r.account_name ?? null,
    credit_card_id: r.credit_card_id ?? null,
    card_name: r.card_name ?? null,
    ...rule,
    active,
    auto_post: !!r.auto_post,
    last_posted_date: r.last_posted_date ?? null,
    color: r.color,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    schedule_label: scheduleLabel(rule),
    next_date: next_dates[0] ?? null,
    next_dates,
    monthly_equivalent: monthlyEquivalent(amount, r.frequency, interval_n),
    posted_count: Number(r.posted_count) || 0,
    posted_total: round2(Number(r.posted_total) || 0),
  };
  if (r.account_bank) accountBanks.set(charge, r.account_bank.trim());
  return charge;
}

/** Orden: activos primero, luego próxima fecha asc (sin fecha al final), luego nombre. */
function compareCharges(a: RecurringCharge, b: RecurringCharge): number {
  if (a.active !== b.active) return a.active ? -1 : 1;
  if (a.next_date !== b.next_date) {
    if (a.next_date === null) return 1;
    if (b.next_date === null) return -1;
    return a.next_date < b.next_date ? -1 : 1;
  }
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.id - b.id;
}

/** Carga los cargos recurrentes con JOINs y calculados (una sola consulta). `id` limita a uno. */
export async function loadRecurring(opts: { id?: number; today?: string } = {}): Promise<RecurringCharge[]> {
  const today = opts.today ?? todayISO();
  const rows = await query<RecurringRow>(RECURRING_SQL, [opts.id ?? null]);
  return rows.map((r) => toCharge(r, today)).sort(compareCharges);
}

/** "Tarjeta X", "Banco · Cuenta", "Cuenta" o "Sin especificar". */
function paymentLabel(item: RecurringCharge): string {
  if (item.credit_card_id !== null) return `Tarjeta ${item.card_name ?? ''}`.trim();
  if (item.account_id !== null) {
    const extra = (item as RecurringCharge & { account_bank?: unknown }).account_bank;
    const bank = accountBanks.get(item) ?? (typeof extra === 'string' ? extra.trim() : '');
    const account = item.account_name ?? '';
    return bank ? `${bank} · ${account}` : account || 'Sin especificar';
  }
  return 'Sin especificar';
}

/**
 * Ocurrencias de cargos ACTIVOS entre hoy y hoy + days (inclusive) con fecha > last_posted_date, por fecha.
 */
export function upcomingCharges(items: RecurringCharge[], days: number, today: string = todayISO()): UpcomingCharge[] {
  const span = Math.max(0, Math.floor(days));
  const until = addDays(today, span);
  const out: UpcomingCharge[] = [];
  for (const item of items) {
    if (!item.active) continue;
    // occurrencesBetween: after exclusivo => desde max(hoy, last_posted_date + 1) inclusive
    const after = addDays(pendingFrom(item.last_posted_date, today), -1);
    const dates = occurrencesBetween(item, after, until, span + 2);
    if (dates.length === 0) continue;
    const payment_label = paymentLabel(item);
    for (const date of dates) {
      out.push({
        recurring_id: item.id,
        name: item.name,
        type: item.type,
        amount: item.amount,
        date,
        payment_label,
        category_icon: item.category_icon,
      });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.name.localeCompare(b.name, 'es') || a.recurring_id - b.recurring_id));
}

/** Lista, totales y próximos 30 días. */
export async function recurringOverview(today: string = todayISO()): Promise<RecurringOverview> {
  const items = await loadRecurring({ today });
  // Un cargo activo cuya end_date ya pasó (sin próximas fechas) terminó: no cuenta en activos ni en el equivalente mensual.
  const active = items.filter((i) => i.active && i.next_date !== null);
  const sumMonthly = (type: TxType): number =>
    round2(active.filter((i) => i.type === type).reduce((acc, i) => acc + i.monthly_equivalent, 0));
  const upcoming = upcomingCharges(items, 30, today);
  return {
    items,
    totals: {
      active: active.length,
      monthly_expense: sumMonthly('expense'),
      monthly_income: sumMonthly('income'),
      next_30_days_expense: round2(upcoming.filter((u) => u.type === 'expense').reduce((acc, u) => acc + u.amount, 0)),
    },
    upcoming,
  };
}
