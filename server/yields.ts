/**
 * Rendimientos de bancos (tasa anual con tope). ÚNICA implementación de las reglas de shared/types.ts.
 * Funciones puras (sin BD): las usan server/accountsData.ts, /api/accounts, /api/banks y /api/dashboard.
 *
 *  - Saldo que rinde de un banco = suma de balance de sus cuentas NO archivadas con earns_yield (mínimo 0).
 *  - Anual = min(saldo, tope) * tasa/100 + max(0, saldo - tope) * tasa_excedente/100  (sin tope: saldo * tasa/100).
 *  - Mensual = anual / 12; diario = anual / 365. Interés simple: es una estimación.
 */
import { round2 } from './util.js';
import type { YieldSuggestion } from '../shared/types.js';

export interface BankTerms {
  id: number;
  name: string;
  annual_rate: number;
  yield_cap: number | null;
  rate_above_cap: number;
}

export interface YieldEstimate {
  yield_balance: number;
  within_cap: number;
  over_cap: number;
  cap_room: number | null;
  year: number;
  month: number;
  day: number;
  effective_rate: number;
}

/** Estimación de rendimiento para un saldo con las condiciones de un banco. */
export function estimateYield(balance: number, terms: Pick<BankTerms, 'annual_rate' | 'yield_cap' | 'rate_above_cap'>): YieldEstimate {
  const b = Math.max(0, round2(Number(balance) || 0));
  const rate = Math.max(0, Number(terms.annual_rate) || 0);
  const above = Math.max(0, Number(terms.rate_above_cap) || 0);
  const cap = terms.yield_cap === null || terms.yield_cap === undefined ? null : Math.max(0, Number(terms.yield_cap) || 0);
  const within = cap === null ? b : Math.min(b, cap);
  const over = cap === null ? 0 : Math.max(0, round2(b - cap));
  const yearRaw = (within * rate) / 100 + (over * above) / 100;
  return {
    yield_balance: b,
    within_cap: round2(within),
    over_cap: over,
    cap_room: cap === null ? null : Math.max(0, round2(cap - b)),
    year: round2(yearRaw),
    month: round2(yearRaw / 12),
    day: round2(yearRaw / 365),
    effective_rate: b > 0 ? Math.round((yearRaw / b) * 100 * 1000) / 1000 : rate,
  };
}

/**
 * Sugerencias para mover el dinero que excede topes a bancos con mejor tasa y espacio.
 * Greedy: los excedentes más grandes primero, a los destinos con mayor tasa marginal primero.
 * `balances` = saldo que rinde por banco (id -> monto).
 */
export function yieldSuggestions(banks: BankTerms[], balances: Map<number, number>): YieldSuggestion[] {
  // Espacio disponible en cada banco a su tasa principal (Infinity si no hay tope)
  const room = new Map<number, number>();
  for (const bk of banks) {
    const bal = Math.max(0, balances.get(bk.id) ?? 0);
    room.set(bk.id, bk.yield_cap === null ? Number.POSITIVE_INFINITY : Math.max(0, bk.yield_cap - bal));
  }
  const sources = banks
    .map((bk) => ({ bk, over: estimateYield(balances.get(bk.id) ?? 0, bk).over_cap }))
    .filter((s) => s.over > 0)
    .sort((a, b) => b.over - a.over);
  const targets = [...banks].filter((bk) => bk.annual_rate > 0).sort((a, b) => b.annual_rate - a.annual_rate || a.id - b.id);

  const out: YieldSuggestion[] = [];
  for (const { bk: from, over } of sources) {
    let left = over;
    for (const to of targets) {
      if (left <= 0) break;
      if (to.id === from.id) continue;
      const gainRate = to.annual_rate - from.rate_above_cap;
      if (gainRate <= 0) continue;
      const space = room.get(to.id) ?? 0;
      if (space <= 0) continue;
      const amount = round2(Math.min(left, space));
      const extra = round2((amount * gainRate) / 100);
      if (amount <= 0 || extra < 1) continue;
      out.push({ from_bank_id: from.id, from_bank: from.name, to_bank_id: to.id, to_bank: to.name, amount, extra_year: extra });
      left = round2(left - amount);
      room.set(to.id, space === Number.POSITIVE_INFINITY ? space : round2(space - amount));
    }
  }
  return out.sort((a, b) => b.extra_year - a.extra_year);
}
