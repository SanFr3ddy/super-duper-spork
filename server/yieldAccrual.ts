/**
 * Abono diario automático de rendimientos (reglas en shared/types.ts, sección RENDIMIENTOS → ABONO DIARIO).
 *
 *  - Para cada día completo d hasta AYER y cada banco con auto_yield y tasa > 0:
 *      saldo que rinde = suma de saldos (al cierre de d) de sus cuentas no archivadas con earns_yield (mínimo 0)
 *      rendimiento del día = estimateYield(saldo).anual / 365   (el saldo ya incluye abonos previos: compuesto)
 *    y se reparte entre sus cuentas con saldo > 0 en proporción a su saldo.
 *  - Centavos: se abona el monto truncado a centavos y el resto se guarda en accounts.yield_carry.
 *  - Idempotente: primero se avanza accounts.yield_accrued_until con UPDATE ... WHERE < d (solo un proceso gana)
 *    y el índice único (account_id, date) WHERE auto impide duplicar abonos.
 */
import { pool, query } from './db.js';
import { round2, todayISO } from './util.js';
import { loadAccounts } from './accountsData.js';
import type { BankTerms } from './yields.js';

const MAX_DAYS_PER_RUN = 400;

export function addDaysISO(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** Rendimiento de UN día (sin redondear) para el saldo que rinde de un banco. */
export function dailyYieldRaw(yieldBalance: number, terms: Pick<BankTerms, 'annual_rate' | 'yield_cap' | 'rate_above_cap'>): number {
  const b = Math.max(0, Number(yieldBalance) || 0);
  const rate = Math.max(0, Number(terms.annual_rate) || 0);
  const above = Math.max(0, Number(terms.rate_above_cap) || 0);
  const cap = terms.yield_cap === null || terms.yield_cap === undefined ? null : Math.max(0, Number(terms.yield_cap) || 0);
  const within = cap === null ? b : Math.min(b, cap);
  const over = cap === null ? 0 : Math.max(0, b - cap);
  return ((within * rate) / 100 + (over * above) / 100) / 365;
}

export interface AccrualAccount {
  id: number;
  balance: number; // saldo al cierre del día
  carry: number; // fracción de centavo acumulada
}

/**
 * Reparte el rendimiento de un día entre las cuentas de un banco.
 * Devuelve por cuenta el monto a abonar (truncado a centavos, >= 0) y el nuevo carry.
 */
export function splitDailyYield(accounts: AccrualAccount[], terms: Pick<BankTerms, 'annual_rate' | 'yield_cap' | 'rate_above_cap'>): { id: number; amount: number; carry: number }[] {
  const total = Math.max(0, accounts.reduce((acc, a) => acc + (Number(a.balance) || 0), 0));
  const positive = accounts.reduce((acc, a) => acc + Math.max(0, Number(a.balance) || 0), 0);
  const day = dailyYieldRaw(total, terms);
  return accounts.map((a) => {
    const share = day > 0 && positive > 0 && a.balance > 0 ? (day * a.balance) / positive : 0;
    const exact = share + (Number(a.carry) || 0);
    const amount = exact > 0 ? Math.floor(exact * 100 + 1e-9) / 100 : 0;
    return { id: a.id, amount: round2(amount), carry: Math.round((exact - amount) * 1e6) / 1e6 };
  });
}

type CandidateRow = {
  id: number;
  bank_id: number;
  opening_date: string;
  yield_accrued_until: string | null;
  yield_carry: number;
  rate_since: string | null;
  annual_rate: number;
  yield_cap: number | null;
  rate_above_cap: number;
};

/**
 * Abona los rendimientos diarios pendientes hasta ayer. Devuelve cuántos abonos (cuenta-día) creó.
 * `today` permite probar con otra fecha; `onlyAccountIds` limita a ciertas cuentas (pruebas).
 */
export async function accrueDailyYields(today = todayISO(), onlyAccountIds?: number[]): Promise<number> {
  const yesterday = addDaysISO(today, -1);
  const candidates = await query<CandidateRow>(
    `SELECT a.id, a.bank_id, a.opening_date, a.yield_accrued_until, a.yield_carry,
            b.rate_since, b.annual_rate, b.yield_cap, b.rate_above_cap
       FROM accounts a
       JOIN banks b ON b.id = a.bank_id
      WHERE NOT a.archived AND a.earns_yield AND b.auto_yield AND (b.annual_rate > 0 OR b.rate_above_cap > 0)
        AND ($1::int[] IS NULL OR a.id = ANY($1::int[]))`,
    [onlyAccountIds ?? null],
  );
  if (candidates.length === 0) return 0;

  /** Primer día en que la cuenta rinde automáticamente (sin considerar lo ya abonado). */
  const baseStart = (c: CandidateRow): string => (c.rate_since && c.rate_since > c.opening_date ? c.rate_since : c.opening_date);
  const startOf = (c: CandidateRow): string => {
    let start = baseStart(c);
    if (c.yield_accrued_until) {
      const next = addDaysISO(c.yield_accrued_until, 1);
      if (next > start) start = next;
    }
    return start;
  };
  const carries = new Map(candidates.map((c) => [c.id, Number(c.yield_carry) || 0]));
  let first = candidates.map(startOf).sort()[0];
  const earliestAllowed = addDaysISO(yesterday, -(MAX_DAYS_PER_RUN - 1));
  if (first < earliestAllowed) first = earliestAllowed;
  if (first > yesterday) return 0;

  let created = 0;
  for (let d = first; d <= yesterday; d = addDaysISO(d, 1)) {
    // active: cuentas que ya rinden ese día (definen el saldo del banco y el tope); due: las que faltan por abonar
    const active = candidates.filter((c) => baseStart(c) <= d);
    const due = active.filter((c) => !c.yield_accrued_until || c.yield_accrued_until < d);
    if (due.length === 0) continue;
    const dueIds = new Set(due.map((c) => c.id));
    // Saldos al cierre del día d (ya incluyen los abonos de días anteriores confirmados)
    const balances = new Map((await loadAccounts({ asOf: d })).map((a) => [a.id, a.balance]));
    const byBank = new Map<number, CandidateRow[]>();
    for (const c of active) byBank.set(c.bank_id, [...(byBank.get(c.bank_id) ?? []), c]);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [, list] of byBank) {
        if (!list.some((c) => dueIds.has(c.id))) continue;
        const t = list[0];
        const terms = {
          annual_rate: Number(t.annual_rate) || 0,
          yield_cap: t.yield_cap === null ? null : Number(t.yield_cap),
          rate_above_cap: Number(t.rate_above_cap) || 0,
        };
        // Cuentas del banco que ya empezaron a rendir ese día (incluye las que ya se procesaron para no alterar el reparto)
        const shares = splitDailyYield(
          list.map((c) => ({ id: c.id, balance: balances.get(c.id) ?? 0, carry: carries.get(c.id) ?? 0 })),
          terms,
        );
        for (const sh of shares) {
          if (!dueIds.has(sh.id)) continue;
          // Solo un proceso avanza el día de cada cuenta; si otro ya lo hizo, no se abona de nuevo.
          const upd = await client.query(
            `UPDATE accounts SET yield_accrued_until = $2::date, yield_carry = $3
              WHERE id = $1 AND (yield_accrued_until IS NULL OR yield_accrued_until < $2::date)
              RETURNING id`,
            [sh.id, d, sh.carry],
          );
          if (!upd.rowCount) continue;
          carries.set(sh.id, sh.carry);
          if (sh.amount >= 0.01) {
            const ins = await client.query(
              `INSERT INTO balance_adjustments (account_id, amount, date, note, source, auto)
               VALUES ($1, $2, $3, 'Rendimiento del día', 'rendimiento', true)
               ON CONFLICT (account_id, date) WHERE auto DO NOTHING`,
              [sh.id, sh.amount, d],
            );
            created += ins.rowCount ?? 0;
          }
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    for (const c of due) c.yield_accrued_until = d;
  }
  return created;
}
