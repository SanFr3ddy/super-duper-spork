/**
 * Compras a meses (diferidas / meses sin intereses). ÚNICA implementación de las reglas de shared/types.ts.
 * La usan /api/cards (campos de la tarjeta y /installments) y /api/dashboard.
 *
 *  - Mensualidad = round2(total / n); la última ajusta centavos.
 *  - Mensualidad k (1..n) cae en el mes (mes de compra + k).
 *  - Deuda diferida pendiente = mensualidades de meses posteriores al mes de referencia.
 */
import { query } from './db.js';
import { round2, todayISO } from './util.js';
import type { InstallmentPlan, InstallmentStatus, InstallmentsResponse } from '../shared/types.js';

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

/** Monto de la mensualidad k (1..n). */
export function installmentAmount(total: number, n: number, k: number): number {
  const monthly = round2(total / n);
  if (k < 1 || k > n) return 0;
  return k === n ? round2(total - monthly * (n - 1)) : monthly;
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
}

/** Calcula el estado de un plan respecto a un mes de referencia 'YYYY-MM'. */
export function buildPlan(src: PlanSource, refYM: string): InstallmentPlan {
  const n = Math.max(1, Math.floor(src.installments));
  const total = round2(src.total);
  const purchaseYM = src.purchase_date.slice(0, 7);
  const firstMonth = addMonthsYM(purchaseYM, 1);
  const lastMonth = addMonthsYM(purchaseYM, n);
  const current = monthDiff(purchaseYM, refYM); // 0 = mes de compra; k = mensualidad k
  const status: InstallmentStatus = current < 1 ? 'pendiente' : current > n ? 'terminada' : 'activa';
  const billedCount = Math.max(0, Math.min(n, current));
  let billed = 0;
  for (let k = 1; k <= billedCount; k++) billed += installmentAmount(total, n, k);
  billed = round2(billed);
  return {
    transaction_id: src.transaction_id,
    credit_card_id: src.credit_card_id,
    card_name: src.card_name,
    description: src.description,
    category_icon: src.category_icon,
    purchase_date: src.purchase_date,
    total,
    installments: n,
    monthly_amount: round2(total / n),
    first_month: firstMonth,
    last_month: lastMonth,
    current_number: Math.max(0, current),
    status,
    due_this_month: status === 'activa' ? installmentAmount(total, n, current) : 0,
    billed_amount: billed,
    remaining_amount: round2(total - billed),
    remaining_installments: n - billedCount,
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
  }>(
    `SELECT t.id, t.credit_card_id, cc.name AS card_name, t.description, c.name AS category_name, c.icon AS category_icon,
            t.date, t.amount, t.installments
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
    for (const s of sources) {
      const k = monthDiff(s.purchase_date.slice(0, 7), ym);
      amount += installmentAmount(round2(s.total), Math.max(1, s.installments), k);
    }
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
