/**
 * Compras a meses (diferidas / meses sin intereses). ÚNICA implementación de las reglas de shared/types.ts.
 * La usan /api/cards (campos de la tarjeta y /installments), /api/transactions (validación) y /api/dashboard.
 *
 *  - Sin desglose: mensualidad = round2(total / n); la última ajusta centavos.
 *  - Con desglose [{ months, amount }]: la mensualidad k usa el monto del tramo que la contiene; n = suma de months.
 *  - Primera mensualidad: installment_first_month ('YYYY-MM') o, si no hay, el mes siguiente a la compra.
 *  - Deuda diferida pendiente = mensualidades de meses posteriores al mes de referencia.
 */
import { query } from './db.js';
import { HttpError, round2, todayISO } from './util.js';
import type { InstallmentPlan, InstallmentSegment, InstallmentStatus, InstallmentsResponse } from '../shared/types.js';

export const MAX_INSTALLMENTS = 48;
/** Tolerancia al comparar la suma del desglose con el total. */
export const PLAN_TOLERANCE = 0.05;

/** 'YYYY-MM' + n meses. */
export function addMonthsYM(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Meses de diferencia b - a entre dos 'YYYY-MM'. */
export function monthDiff(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

export function currentYM(): string {
  return todayISO().slice(0, 7);
}

/** Monto de la mensualidad k (1..n) con pagos iguales. */
export function installmentAmount(total: number, n: number, k: number): number {
  const monthly = round2(total / n);
  if (k < 1 || k > n) return 0;
  return k === n ? round2(total - monthly * (n - 1)) : monthly;
}

/** Limpia un desglose: tramos con months entero >= 1 y amount > 0; null si queda vacío. */
export function normalizeSegments(raw: unknown): InstallmentSegment[] | null {
  if (!Array.isArray(raw)) return null;
  const out: InstallmentSegment[] = [];
  for (const s of raw) {
    const months = Math.floor(Number((s as InstallmentSegment)?.months));
    const amount = round2(Number((s as InstallmentSegment)?.amount));
    if (Number.isFinite(months) && months >= 1 && Number.isFinite(amount) && amount > 0) out.push({ months, amount });
  }
  return out.length ? out : null;
}

export function segmentsMonths(segments: InstallmentSegment[]): number {
  return segments.reduce((a, s) => a + s.months, 0);
}

export function segmentsTotal(segments: InstallmentSegment[]): number {
  return round2(segments.reduce((a, s) => a + s.months * s.amount, 0));
}

/**
 * Valida un desglose contra el total de la compra. Lanza HttpError(400) con un mensaje claro.
 * Devuelve el número de mensualidades (suma de months).
 */
export function validatePlan(total: number, segments: InstallmentSegment[]): number {
  const n = segmentsMonths(segments);
  if (n < 2) throw new HttpError(400, 'El desglose debe sumar al menos 2 meses');
  if (n > MAX_INSTALLMENTS) throw new HttpError(400, `El desglose suma ${n} meses; el máximo es ${MAX_INSTALLMENTS}`);
  const sum = segmentsTotal(segments);
  if (Math.abs(sum - round2(total)) > PLAN_TOLERANCE) {
    throw new HttpError(400, `La suma del desglose (${sum.toFixed(2)}) no coincide con el total de la compra (${round2(total).toFixed(2)})`);
  }
  return n;
}

/** Tramos efectivos: el desglose propio o pagos iguales expresados como 1-2 tramos. */
export function effectiveSegments(total: number, n: number, segments: InstallmentSegment[] | null | undefined): InstallmentSegment[] {
  if (segments && segments.length) return segments;
  const monthly = round2(total / n);
  const last = installmentAmount(total, n, n);
  if (n === 1 || last === monthly) return [{ months: n, amount: monthly }];
  return [
    { months: n - 1, amount: monthly },
    { months: 1, amount: last },
  ];
}

export interface PlanSource {
  transaction_id: number;
  credit_card_id: number;
  card_name: string;
  description: string;
  category_icon: string | null;
  purchase_date: string;
  total: number;
  installments: number;
  /** Desglose propio (null/undefined = pagos iguales). */
  segments?: InstallmentSegment[] | null;
  /** 'YYYY-MM' de la primera mensualidad (null/undefined = mes siguiente a la compra). */
  first_month?: string | null;
}

/** Monto de la mensualidad k (1..n) de un plan (con o sin desglose). */
export function planAmountAt(src: Pick<PlanSource, 'total' | 'installments' | 'segments'>, k: number): number {
  const segs = src.segments && src.segments.length ? src.segments : null;
  if (!segs) return installmentAmount(round2(src.total), Math.max(1, Math.floor(src.installments)), k);
  if (k < 1) return 0;
  let acc = 0;
  for (const s of segs) {
    if (k <= acc + s.months) return s.amount;
    acc += s.months;
  }
  return 0;
}

export function planFirstMonth(src: Pick<PlanSource, 'purchase_date' | 'first_month'>): string {
  return src.first_month && /^\d{4}-\d{2}$/.test(src.first_month) ? src.first_month : addMonthsYM(src.purchase_date.slice(0, 7), 1);
}

function planMonths(src: Pick<PlanSource, 'installments' | 'segments'>): number {
  return src.segments && src.segments.length ? segmentsMonths(src.segments) : Math.max(1, Math.floor(src.installments));
}

/** Calcula el estado de un plan respecto a un mes de referencia 'YYYY-MM'. */
export function buildPlan(src: PlanSource, refYM: string): InstallmentPlan {
  const n = planMonths(src);
  const total = round2(src.total);
  const firstMonth = planFirstMonth(src);
  const lastMonth = addMonthsYM(firstMonth, n - 1);
  const current = monthDiff(firstMonth, refYM) + 1; // 1 = mes de la primera mensualidad
  const status: InstallmentStatus = current < 1 ? 'pendiente' : current > n ? 'terminada' : 'activa';
  const billedCount = Math.max(0, Math.min(n, current));
  let billed = 0;
  for (let k = 1; k <= billedCount; k++) billed += planAmountAt(src, k);
  billed = round2(billed);
  const custom = !!(src.segments && src.segments.length);
  return {
    transaction_id: src.transaction_id,
    credit_card_id: src.credit_card_id,
    card_name: src.card_name,
    description: src.description,
    category_icon: src.category_icon,
    purchase_date: src.purchase_date,
    total,
    installments: n,
    monthly_amount: custom ? planAmountAt(src, Math.min(n, Math.max(1, current))) : round2(total / n),
    first_month: firstMonth,
    last_month: lastMonth,
    current_number: Math.max(0, current),
    status,
    due_this_month: status === 'activa' ? planAmountAt(src, current) : 0,
    billed_amount: billed,
    remaining_amount: Math.max(0, round2(total - billed)),
    remaining_installments: n - billedCount,
    segments: effectiveSegments(total, n, src.segments),
    custom_plan: custom,
  };
}

/** Carga las compras a meses (installments > 1) con tarjeta. `cardId` limita a una tarjeta. */
export async function loadPlanSources(cardId?: number): Promise<PlanSource[]> {
  const rows = await query<{
    id: number;
    credit_card_id: number;
    card_name: string;
    description: string;
    category_name: string | null;
    category_icon: string | null;
    date: string;
    amount: number;
    installments: number;
    installment_plan: unknown;
    installment_first_month: string | null;
  }>(
    `SELECT t.id, t.credit_card_id, cc.name AS card_name, t.description, c.name AS category_name, c.icon AS category_icon,
            t.date, t.amount, t.installments, t.installment_plan, t.installment_first_month
       FROM transactions t
       JOIN credit_cards cc ON cc.id = t.credit_card_id
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.type = 'expense' AND t.installments > 1 AND ($1::int IS NULL OR t.credit_card_id = $1::int)
      ORDER BY t.date ASC, t.id ASC`,
    [cardId ?? null],
  );
  return rows.map((r) => ({
    transaction_id: r.id,
    credit_card_id: r.credit_card_id,
    card_name: r.card_name,
    description: r.description || r.category_name || 'Compra a meses',
    category_icon: r.category_icon,
    purchase_date: r.date,
    total: Number(r.amount) || 0,
    installments: Number(r.installments) || 1,
    segments: normalizeSegments(r.installment_plan),
    first_month: r.installment_first_month,
  }));
}

export interface CardInstallmentTotals {
  active_plans: number;
  installments_due_this_month: number;
  deferred_remaining: number;
}

/** Totales por tarjeta para el mes de referencia (por defecto el actual). */
export function totalsByCard(sources: PlanSource[], refYM = currentYM()): Map<number, CardInstallmentTotals> {
  const map = new Map<number, CardInstallmentTotals>();
  for (const src of sources) {
    const plan = buildPlan(src, refYM);
    if (plan.status === 'terminada') continue;
    const t = map.get(src.credit_card_id) ?? { active_plans: 0, installments_due_this_month: 0, deferred_remaining: 0 };
    t.active_plans += 1;
    t.installments_due_this_month = round2(t.installments_due_this_month + plan.due_this_month);
    t.deferred_remaining = round2(t.deferred_remaining + plan.remaining_amount);
    map.set(src.credit_card_id, t);
  }
  return map;
}

/** Respuesta completa de GET /api/cards/installments. */
export async function installmentsOverview(year: number, month: number): Promise<InstallmentsResponse> {
  const refYM = `${year}-${String(month).padStart(2, '0')}`;
  const sources = await loadPlanSources();
  const plans = sources.map((s) => buildPlan(s, refYM));

  const open = plans
    .filter((p) => p.status !== 'terminada')
    .sort((a, b) => a.last_month.localeCompare(b.last_month) || a.purchase_date.localeCompare(b.purchase_date));
  const done = plans
    .filter((p) => p.status === 'terminada')
    .sort((a, b) => b.last_month.localeCompare(a.last_month))
    .slice(0, 12);

  const byCard = new Map<number, InstallmentsResponse['by_card'][number]>();
  for (const p of open) {
    const c = byCard.get(p.credit_card_id) ?? { credit_card_id: p.credit_card_id, card_name: p.card_name, due_this_month: 0, deferred_remaining: 0, active_plans: 0 };
    c.active_plans += 1;
    c.due_this_month = round2(c.due_this_month + p.due_this_month);
    c.deferred_remaining = round2(c.deferred_remaining + p.remaining_amount);
    byCard.set(p.credit_card_id, c);
  }

  const schedule = Array.from({ length: 12 }, (_, i) => {
    const ym = addMonthsYM(refYM, i);
    let amount = 0;
    for (const s of sources) amount += planAmountAt(s, monthDiff(planFirstMonth(s), ym) + 1);
    return { month: ym, amount: round2(amount) };
  });

  return {
    year,
    month,
    items: [...open, ...done],
    totals: {
      due_this_month: round2(open.reduce((a, p) => a + p.due_this_month, 0)),
      deferred_remaining: round2(open.reduce((a, p) => a + p.remaining_amount, 0)),
      active_plans: open.length,
    },
    by_card: [...byCard.values()].sort((a, b) => b.due_this_month - a.due_this_month),
    schedule,
  };
}
