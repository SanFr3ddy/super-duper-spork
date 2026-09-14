/**
 * Formato de moneda, fechas y meses. La moneda/locale vienen de GET /api/config
 * y se fijan con setConfig() al arrancar (main.ts).
 */
import type { AppConfig } from '../../shared/types';

export const settings: AppConfig = { currency: 'MXN', locale: 'es-MX' };

let moneyFmt = new Intl.NumberFormat(settings.locale, { style: 'currency', currency: settings.currency });
let moneyFmtCompact = new Intl.NumberFormat(settings.locale, {
  style: 'currency',
  currency: settings.currency,
  notation: 'compact',
  maximumFractionDigits: 1,
});
let numberFmt = new Intl.NumberFormat(settings.locale, { maximumFractionDigits: 2 });

export function setConfig(cfg: Partial<AppConfig>): void {
  if (cfg.currency) settings.currency = cfg.currency;
  if (cfg.locale) settings.locale = cfg.locale;
  try {
    moneyFmt = new Intl.NumberFormat(settings.locale, { style: 'currency', currency: settings.currency });
    moneyFmtCompact = new Intl.NumberFormat(settings.locale, {
      style: 'currency',
      currency: settings.currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    });
    numberFmt = new Intl.NumberFormat(settings.locale, { maximumFractionDigits: 2 });
  } catch {
    // locale o moneda inválidos: se conservan los formateadores anteriores
  }
}

/** $12,345.67 */
export function money(n: number | null | undefined): string {
  return moneyFmt.format(Number(n) || 0);
}
/** $12.3 k — para ejes de gráficas */
export function moneyCompact(n: number | null | undefined): string {
  return moneyFmtCompact.format(Number(n) || 0);
}
/** +$1,200.00 / -$300.00 */
export function moneySigned(n: number): string {
  const v = Number(n) || 0;
  return (v >= 0 ? '+' : '-') + moneyFmt.format(Math.abs(v));
}
export function num(n: number | null | undefined): string {
  return numberFmt.format(Number(n) || 0);
}
/** 0.253 -> "25%" */
export function pct(ratio: number | null | undefined, digits = 0): string {
  const v = Number(ratio) || 0;
  return `${(v * 100).toFixed(digits)}%`;
}

export const MONTHS = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];
export const MONTHS_SHORT = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** monthName(1) -> 'Enero' */
export function monthName(m: number): string {
  return MONTHS[m - 1] ?? '';
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function currentYear(): number {
  return new Date().getFullYear();
}
export function currentMonth(): number {
  return new Date().getMonth() + 1;
}

/** '2026-09-13' -> '13 sep 2026' (sin desfase de zona horaria) */
export function fmtDate(iso: string | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat(settings.locale, opts).format(new Date(y, m - 1, d));
}
/** '2026-09-13' -> '13 sep' */
export function fmtDateShort(iso: string | null | undefined): string {
  return fmtDate(iso, { day: 'numeric', month: 'short' });
}

/** Días entre hoy y una fecha ISO (negativo si ya pasó). */
export function daysUntil(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** Meses completos entre hoy y una fecha (mínimo 0). */
export function monthsUntil(iso: string): number {
  const [y, m] = iso.slice(0, 10).split('-').map(Number);
  const now = new Date();
  return Math.max(0, (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1)));
}

/** Escapa texto para insertarlo en innerHTML. */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
