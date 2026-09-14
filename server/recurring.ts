/**
 * Calendario de cargos recurrentes. ÚNICA implementación de las reglas de shared/types.ts (funciones puras).
 * El registro automático en BD vive en server/recurringPost.ts y usa estas funciones.
 */
import { round2 } from './util.js';
import type { RecurringFrequency } from '../shared/types.js';
import { WEEKDAY_LABELS } from '../shared/types.js';

export interface ScheduleRule {
  frequency: RecurringFrequency;
  interval_n: number;
  day_of_month: number | null;
  weekday: number | null;
  month_of_year: number | null;
  start_date: string;
  end_date: string | null;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number): string => `${y}-${pad2(m)}-${pad2(d)}`;
const lastDay = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

function parse(isoDate: string): { y: number; m: number; d: number } {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

function addDays(isoDate: string, days: number): string {
  const { y, m, d } = parse(isoDate);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function weekdayOf(isoDate: string): number {
  const { y, m, d } = parse(isoDate);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Día del mes ajustado al último día del mes (31 en febrero => 28/29). */
function clampedDate(y: number, m: number, day: number): string {
  return iso(y, m, Math.min(Math.max(1, day), lastDay(y, m)));
}

/** Primera ocurrencia >= start_date según la regla (sin aplicar end_date). */
export function firstOccurrence(rule: ScheduleRule): string {
  const start = rule.start_date.slice(0, 10);
  const { y, m } = parse(start);
  switch (rule.frequency) {
    case 'daily':
      return start;
    case 'weekly': {
      const target = rule.weekday ?? weekdayOf(start);
      const diff = (target - weekdayOf(start) + 7) % 7;
      return addDays(start, diff);
    }
    case 'monthly': {
      const day = rule.day_of_month ?? parse(start).d;
      const thisMonth = clampedDate(y, m, day);
      if (thisMonth >= start) return thisMonth;
      return m === 12 ? clampedDate(y + 1, 1, day) : clampedDate(y, m + 1, day);
    }
    case 'yearly': {
      const month = rule.month_of_year ?? m;
      const day = rule.day_of_month ?? parse(start).d;
      const thisYear = clampedDate(y, month, day);
      return thisYear >= start ? thisYear : clampedDate(y + 1, month, day);
    }
  }
}

/** Ocurrencia número k (0 = primera), anclada a la primera para que el ajuste de fin de mes no se acumule. */
export function occurrenceAt(rule: ScheduleRule, k: number): string {
  const n = Math.max(1, Math.floor(rule.interval_n || 1));
  const first = firstOccurrence(rule);
  switch (rule.frequency) {
    case 'daily':
      return addDays(first, k * n);
    case 'weekly':
      return addDays(first, k * 7 * n);
    case 'monthly': {
      const { y, m } = parse(first);
      const day = rule.day_of_month ?? parse(rule.start_date).d;
      const total = y * 12 + (m - 1) + k * n;
      return clampedDate(Math.floor(total / 12), (total % 12) + 1, day);
    }
    case 'yearly': {
      const { y, m } = parse(first);
      const day = rule.day_of_month ?? parse(rule.start_date).d;
      return clampedDate(y + k * n, m, day);
    }
  }
}

/**
 * Ocurrencias con after < fecha <= until (after exclusivo; null = desde el inicio), respetando end_date.
 * `limit` evita bucles enormes (por defecto 400).
 */
export function occurrencesBetween(rule: ScheduleRule, after: string | null, until: string, limit = 400): string[] {
  const out: string[] = [];
  const end = rule.end_date && rule.end_date < until ? rule.end_date : until;
  // Salto aproximado para no recorrer desde el inicio en reglas diarias/semanales antiguas
  let k = 0;
  if (after && (rule.frequency === 'daily' || rule.frequency === 'weekly')) {
    const first = firstOccurrence(rule);
    if (after > first) {
      const step = (rule.frequency === 'daily' ? 1 : 7) * Math.max(1, Math.floor(rule.interval_n || 1));
      const days = Math.floor((Date.parse(`${after}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 86_400_000);
      k = Math.max(0, Math.floor(days / step) - 1);
    }
  }
  for (let guard = 0; guard < 100_000 && out.length < limit; guard++, k++) {
    const date = occurrenceAt(rule, k);
    if (date > end) break;
    if (after === null || date > after) out.push(date);
  }
  return out;
}

/** Próximas `count` ocurrencias con fecha >= from (inclusive). */
export function nextOccurrences(rule: ScheduleRule, from: string, count: number): string[] {
  return occurrencesBetween(rule, addDays(from, -1), '9999-12-31', count);
}

/** Última ocurrencia con fecha < before (o null si no hay). */
export function lastOccurrenceBefore(rule: ScheduleRule, before: string): string | null {
  const list = occurrencesBetween(rule, null, addDays(before, -1), 100_000);
  return list.length ? list[list.length - 1] : null;
}

export function monthlyEquivalent(amount: number, frequency: RecurringFrequency, intervalN: number): number {
  const n = Math.max(1, Math.floor(intervalN || 1));
  const a = Number(amount) || 0;
  switch (frequency) {
    case 'daily':
      return round2((a * 30.4375) / n);
    case 'weekly':
      return round2((a * 52) / 12 / n);
    case 'monthly':
      return round2(a / n);
    case 'yearly':
      return round2(a / (12 * n));
  }
}

const MONTH_NAMES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Texto legible: "Cada mes el día 5", "Cada 2 semanas los lunes", "Cada año el 15 de marzo", "Cada 3 días". */
export function scheduleLabel(rule: Pick<ScheduleRule, 'frequency' | 'interval_n' | 'day_of_month' | 'weekday' | 'month_of_year'>): string {
  const n = Math.max(1, Math.floor(rule.interval_n || 1));
  switch (rule.frequency) {
    case 'daily':
      return n === 1 ? 'Cada día' : `Cada ${n} días`;
    case 'weekly': {
      const wd = rule.weekday !== null && rule.weekday !== undefined ? WEEKDAY_LABELS[rule.weekday]?.toLowerCase() : null;
      const base = n === 1 ? 'Cada semana' : `Cada ${n} semanas`;
      return wd ? `${base} los ${wd}${wd.endsWith('s') ? '' : 's'}` : base;
    }
    case 'monthly':
      return `${n === 1 ? 'Cada mes' : `Cada ${n} meses`}${rule.day_of_month ? ` el día ${rule.day_of_month}` : ''}`;
    case 'yearly': {
      const when = rule.day_of_month && rule.month_of_year ? ` el ${rule.day_of_month} de ${MONTH_NAMES[rule.month_of_year - 1]}` : '';
      return `${n === 1 ? 'Cada año' : `Cada ${n} años`}${when}`;
    }
  }
}
