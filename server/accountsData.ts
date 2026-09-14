/**
 * Saldos de cuentas ("Mi dinero"). ÚNICA implementación de la fórmula descrita en shared/types.ts.
 * La usan /api/accounts y /api/dashboard.
 *
 * Eventos que mueven una cuenta (delta con signo):
 *   + ingresos (transactions.type='income', account_id)
 *   - gastos con account_id y SIN tarjeta de crédito
 *   - pagos de tarjeta (card_payments.account_id)
 *   - pagos de préstamo (loan_payments.account_id)
 *   + transferencias recibidas / - transferencias enviadas
 *   + ajustes de saldo (con signo)
 * Solo cuentan los eventos con opening_date <= fecha <= hoy.
 */
import { query } from './db.js';
import { monthRange, round2, todayISO } from './util.js';
import type { Account, AccountKind, AccountsMonth, BankTotal } from '../shared/types.js';

/** CTE con todos los eventos de cuentas: (acc, date, delta). */
export const ACCOUNT_EVENTS_CTE = `
  ev AS (
    SELECT t.account_id AS acc, t.date, CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END AS delta
      FROM transactions t
     WHERE t.account_id IS NOT NULL AND (t.type = 'income' OR t.credit_card_id IS NULL)
    UNION ALL
    SELECT account_id, date, -amount FROM card_payments WHERE account_id IS NOT NULL
    UNION ALL
    SELECT account_id, date, -amount FROM loan_payments WHERE account_id IS NOT NULL
    UNION ALL
    SELECT to_account_id, date, amount FROM transfers
    UNION ALL
    SELECT from_account_id, date, -amount FROM transfers
    UNION ALL
    SELECT account_id, date, amount FROM balance_adjustments
  )`;

type AccountRow = {
  id: number;
  name: string;
  bank: string;
  kind: AccountKind;
  opening_balance: number;
  opening_date: string;
  color: string;
  archived: boolean;
  created_at: Date | string;
  delta_to_date: number;
  inflow_month: number;
  outflow_month: number;
  last_movement_date: string | null;
  movements_count: number;
};

/**
 * Carga cuentas con saldo a `asOf` (por defecto hoy) y entradas/salidas del mes de `asOf`.
 * `id` limita a una cuenta.
 */
export async function loadAccounts(opts: { id?: number; asOf?: string } = {}): Promise<Account[]> {
  const asOf = opts.asOf ?? todayISO();
  const [y, m] = asOf.split('-').map(Number);
  const { from: monthStart } = monthRange(y, m);
  const rows = await query<AccountRow>(
    `WITH ${ACCOUNT_EVENTS_CTE}
     SELECT a.id, a.name, a.bank, a.kind, a.opening_balance, a.opening_date, a.color, a.archived, a.created_at,
            COALESCE(SUM(ev.delta) FILTER (WHERE ev.date >= a.opening_date AND ev.date <= $1::date), 0) AS delta_to_date,
            COALESCE(SUM(ev.delta) FILTER (WHERE ev.delta > 0 AND ev.date >= GREATEST(a.opening_date, $2::date) AND ev.date <= $1::date), 0) AS inflow_month,
            COALESCE(-SUM(ev.delta) FILTER (WHERE ev.delta < 0 AND ev.date >= GREATEST(a.opening_date, $2::date) AND ev.date <= $1::date), 0) AS outflow_month,
            MAX(ev.date) FILTER (WHERE ev.date >= a.opening_date AND ev.date <= $1::date) AS last_movement_date,
            COUNT(ev.delta) FILTER (WHERE ev.date >= a.opening_date) AS movements_count
       FROM accounts a
       LEFT JOIN ev ON ev.acc = a.id
      WHERE ($3::int IS NULL OR a.id = $3::int)
      GROUP BY a.id
      ORDER BY a.archived ASC, lower(a.bank) ASC, lower(a.name) ASC, a.id ASC`,
    [asOf, monthStart, opts.id ?? null],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    bank: r.bank ?? '',
    kind: r.kind,
    opening_balance: round2(Number(r.opening_balance) || 0),
    opening_date: r.opening_date,
    color: r.color,
    archived: !!r.archived,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    balance: round2((Number(r.opening_balance) || 0) + (Number(r.delta_to_date) || 0)),
    inflow_this_month: round2(Number(r.inflow_month) || 0),
    outflow_this_month: round2(Number(r.outflow_month) || 0),
    last_movement_date: r.last_movement_date ?? null,
    movements_count: Number(r.movements_count) || 0,
  }));
}

const isDisponible = (k: AccountKind): boolean => k === 'disponible' || k === 'efectivo';

/** Totales de cuentas activas (no archivadas). */
export function accountTotals(accounts: Account[]) {
  const active = accounts.filter((a) => !a.archived);
  const sum = (pred: (a: Account) => boolean): number => round2(active.filter(pred).reduce((acc, a) => acc + a.balance, 0));
  return {
    total: sum(() => true),
    disponible: sum((a) => isDisponible(a.kind)),
    guardado: sum((a) => !isDisponible(a.kind)),
    ahorro: sum((a) => a.kind === 'ahorro'),
    inversion: sum((a) => a.kind === 'inversion'),
    efectivo: sum((a) => a.kind === 'efectivo'),
    accounts: active.length,
  };
}

/** Nombre de banco para agrupar: sin banco y de efectivo => 'Efectivo'; vacío => 'Sin banco'. */
export function bankLabel(a: Pick<Account, 'bank' | 'kind'>): string {
  const b = (a.bank ?? '').trim();
  if (b) return b;
  return a.kind === 'efectivo' ? 'Efectivo' : 'Sin banco';
}

/** Totales por banco de las cuentas activas, ordenados por total desc. */
export function bankTotals(accounts: Account[]): BankTotal[] {
  const groups = new Map<string, BankTotal>();
  for (const a of accounts) {
    if (a.archived) continue;
    const label = bankLabel(a);
    const key = label.toLocaleLowerCase('es');
    const g = groups.get(key) ?? { bank: label, total: 0, share: 0, accounts: 0, disponible: 0, guardado: 0 };
    g.total += a.balance;
    g.accounts += 1;
    if (isDisponible(a.kind)) g.disponible += a.balance;
    else g.guardado += a.balance;
    groups.set(key, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, total: round2(g.total), disponible: round2(g.disponible), guardado: round2(g.guardado) }));
  const positive = list.reduce((acc, g) => acc + Math.max(0, g.total), 0);
  for (const g of list) g.share = positive > 0 ? Math.round((Math.max(0, g.total) / positive) * 10_000) / 10_000 : 0;
  return list.sort((a, b) => b.total - a.total || a.bank.localeCompare(b.bank, 'es'));
}

/**
 * Saldos al cierre de cada mes del año (cuentas activas). En el año en curso, los meses futuros son null
 * y el mes actual usa el saldo a hoy. Una cuenta aún no abierta al cierre de un mes no suma en ese mes.
 */
export async function monthlyBalances(year: number, accounts: Account[]): Promise<AccountsMonth[]> {
  const today = todayISO();
  const active = accounts.filter((a) => !a.archived);
  const empty = (month: number): AccountsMonth => ({ month, total: null, disponible: null, guardado: null });
  if (active.length === 0) return Array.from({ length: 12 }, (_, i) => empty(i + 1));

  const { to: yearEnd } = monthRange(year, 0);
  const rows = await query<{ acc: number; ym: string; delta: number }>(
    `WITH ${ACCOUNT_EVENTS_CTE}
     SELECT ev.acc, to_char(ev.date, 'YYYY-MM') AS ym, SUM(ev.delta) AS delta
       FROM ev
       JOIN accounts a ON a.id = ev.acc
      WHERE a.archived = false AND ev.date >= a.opening_date AND ev.date < $1::date AND ev.date <= $2::date
      GROUP BY ev.acc, ym`,
    [yearEnd, today],
  );
  // deltas por cuenta y mes 'YYYY-MM'
  const byAcc = new Map<number, Map<string, number>>();
  for (const r of rows) {
    const m = byAcc.get(r.acc) ?? new Map<string, number>();
    m.set(r.ym, (m.get(r.ym) ?? 0) + (Number(r.delta) || 0));
    byAcc.set(r.acc, m);
  }

  const out: AccountsMonth[] = [];
  for (let month = 1; month <= 12; month++) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const { to: monthEnd } = monthRange(year, month); // primer día del mes siguiente
    const monthStart = `${ym}-01`;
    if (monthStart > today) {
      out.push(empty(month));
      continue;
    }
    let total = 0;
    let disponible = 0;
    let guardado = 0;
    let open = 0;
    for (const a of active) {
      if (a.opening_date >= monthEnd) continue; // aún no abierta al cierre del mes
      let bal = a.opening_balance;
      const deltas = byAcc.get(a.id);
      if (deltas) for (const [k, v] of deltas) if (k <= ym) bal += v;
      open += 1;
      total += bal;
      if (isDisponible(a.kind)) disponible += bal;
      else guardado += bal;
    }
    out.push(open === 0 ? empty(month) : { month, total: round2(total), disponible: round2(disponible), guardado: round2(guardado) });
  }
  return out;
}
