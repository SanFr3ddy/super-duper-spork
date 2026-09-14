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
import { estimateYield, yieldSuggestions, type BankTerms } from './yields.js';
import type { Account, AccountKind, AccountsMonth, Bank, BankTotal, YieldsSummary } from '../shared/types.js';

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
  bank_id: number | null;
  earns_yield: boolean;
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

type BankRow = {
  id: number;
  name: string;
  color: string;
  annual_rate: number;
  yield_cap: number | null;
  rate_above_cap: number;
  created_at: Date | string;
};

async function loadBankRows(): Promise<BankRow[]> {
  return query<BankRow>(
    'SELECT id, name, color, annual_rate, yield_cap, rate_above_cap, created_at FROM banks ORDER BY lower(name) ASC, id ASC',
  );
}

function bankTerms(r: BankRow): BankTerms {
  return {
    id: r.id,
    name: r.name,
    annual_rate: Number(r.annual_rate) || 0,
    yield_cap: r.yield_cap === null || r.yield_cap === undefined ? null : Number(r.yield_cap) || 0,
    rate_above_cap: Number(r.rate_above_cap) || 0,
  };
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

/** Cuenta cuyo saldo cuenta para el rendimiento de su banco (sin mínimo de saldo). */
const countsForYield = (a: Pick<Account, 'archived' | 'earns_yield' | 'bank_id'>): boolean =>
  !a.archived && a.earns_yield && a.bank_id !== null;

/** Saldo que rinde por banco: suma de saldos de cuentas no archivadas con earns_yield (mínimo 0). */
function yieldBalancesByBank(accounts: Account[]): Map<number, number> {
  const sums = new Map<number, number>();
  for (const a of accounts) {
    if (!countsForYield(a)) continue;
    sums.set(a.bank_id!, (sums.get(a.bank_id!) ?? 0) + a.balance);
  }
  for (const [k, v] of sums) sums.set(k, Math.max(0, round2(v)));
  return sums;
}

/**
 * Carga cuentas con saldo a `asOf` (por defecto hoy) y entradas/salidas del mes de `asOf`.
 * `id` limita a una cuenta (internamente también lee las de su banco para repartir el rendimiento estimado).
 */
export async function loadAccounts(opts: { id?: number; asOf?: string } = {}): Promise<Account[]> {
  const asOf = opts.asOf ?? todayISO();
  const [y, m] = asOf.split('-').map(Number);
  const { from: monthStart } = monthRange(y, m);
  const [rows, bankRows] = await Promise.all([
    query<AccountRow>(
      `WITH ${ACCOUNT_EVENTS_CTE}
       SELECT a.id, a.name, a.bank, a.bank_id, a.earns_yield, a.kind, a.opening_balance, a.opening_date, a.color, a.archived, a.created_at,
              COALESCE(SUM(ev.delta) FILTER (WHERE ev.date >= a.opening_date AND ev.date <= $1::date), 0) AS delta_to_date,
              COALESCE(SUM(ev.delta) FILTER (WHERE ev.delta > 0 AND ev.date >= GREATEST(a.opening_date, $2::date) AND ev.date <= $1::date), 0) AS inflow_month,
              COALESCE(-SUM(ev.delta) FILTER (WHERE ev.delta < 0 AND ev.date >= GREATEST(a.opening_date, $2::date) AND ev.date <= $1::date), 0) AS outflow_month,
              MAX(ev.date) FILTER (WHERE ev.date >= a.opening_date AND ev.date <= $1::date) AS last_movement_date,
              COUNT(ev.delta) FILTER (WHERE ev.date >= a.opening_date) AS movements_count
         FROM accounts a
         LEFT JOIN ev ON ev.acc = a.id
        WHERE ($3::int IS NULL OR a.id = $3::int
               OR a.bank_id = (SELECT x.bank_id FROM accounts x WHERE x.id = $3::int))
        GROUP BY a.id
        ORDER BY a.archived ASC, lower(a.bank) ASC, lower(a.name) ASC, a.id ASC`,
      [asOf, monthStart, opts.id ?? null],
    ),
    loadBankRows(),
  ]);
  const accounts: Account[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    bank: r.bank ?? '',
    bank_id: r.bank_id ?? null,
    earns_yield: !!r.earns_yield,
    kind: r.kind,
    opening_balance: round2(Number(r.opening_balance) || 0),
    opening_date: r.opening_date,
    color: r.color,
    archived: !!r.archived,
    created_at: iso(r.created_at),
    balance: round2((Number(r.opening_balance) || 0) + (Number(r.delta_to_date) || 0)),
    est_yield_month: 0,
    inflow_this_month: round2(Number(r.inflow_month) || 0),
    outflow_this_month: round2(Number(r.outflow_month) || 0),
    last_movement_date: r.last_movement_date ?? null,
    movements_count: Number(r.movements_count) || 0,
  }));

  // Rendimiento mensual estimado de cada banco, repartido entre sus cuentas con saldo positivo según su saldo.
  const terms = new Map(bankRows.map((b) => [b.id, bankTerms(b)]));
  const yieldBalances = yieldBalancesByBank(accounts);
  const positiveSums = new Map<number, number>();
  for (const a of accounts) {
    if (countsForYield(a) && a.balance > 0) positiveSums.set(a.bank_id!, (positiveSums.get(a.bank_id!) ?? 0) + a.balance);
  }
  const monthlyByBank = new Map<number, number>();
  for (const [bankId, bal] of yieldBalances) {
    const t = terms.get(bankId);
    if (t) monthlyByBank.set(bankId, estimateYield(bal, t).month);
  }
  for (const a of accounts) {
    if (!countsForYield(a) || a.balance <= 0) continue;
    const month = monthlyByBank.get(a.bank_id!) ?? 0;
    const positive = positiveSums.get(a.bank_id!) ?? 0;
    a.est_yield_month = month > 0 && positive > 0 ? round2((month * a.balance) / positive) : 0;
  }

  return opts.id === undefined ? accounts : accounts.filter((a) => a.id === opts.id);
}

/** Año calendario (YYYY) de una fecha 'YYYY-MM-DD'. */
const yearOf = (d: string): number => Number(d.slice(0, 4));

/**
 * Bancos con sus calculados a hoy. `accounts` debe ser la lista completa de cuentas (loadAccounts() sin id);
 * si no se pasa, se carga.
 */
export async function loadBanks(accounts?: Account[]): Promise<Bank[]> {
  const year = yearOf(todayISO());
  const [list, bankRows, registered] = await Promise.all([
    accounts ? Promise.resolve(accounts) : loadAccounts(),
    loadBankRows(),
    query<{ bank_id: number; total: number }>(
      `SELECT a.bank_id, COALESCE(SUM(b.amount), 0) AS total
         FROM balance_adjustments b
         JOIN accounts a ON a.id = b.account_id
        WHERE b.source = 'rendimiento' AND a.bank_id IS NOT NULL
          AND b.date >= a.opening_date AND b.date >= $1::date AND b.date < $2::date
        GROUP BY a.bank_id`,
      [`${year}-01-01`, `${year + 1}-01-01`],
    ),
  ]);
  const registeredByBank = new Map(registered.map((r) => [Number(r.bank_id), Number(r.total) || 0]));
  const yieldBalances = yieldBalancesByBank(list);

  return bankRows.map((r) => {
    const t = bankTerms(r);
    const mine = list.filter((a) => a.bank_id === r.id && !a.archived);
    const est = estimateYield(yieldBalances.get(r.id) ?? 0, t);
    return {
      id: r.id,
      name: r.name,
      color: r.color,
      annual_rate: t.annual_rate,
      yield_cap: t.yield_cap,
      rate_above_cap: t.rate_above_cap,
      created_at: iso(r.created_at),
      accounts_count: mine.length,
      balance: round2(mine.reduce((acc, a) => acc + a.balance, 0)),
      yield_balance: est.yield_balance,
      over_cap: est.over_cap,
      cap_room: est.cap_room,
      est_yield_day: est.day,
      est_yield_month: est.month,
      est_yield_year: est.year,
      effective_rate: est.effective_rate,
      yield_registered_year: round2(registeredByBank.get(r.id) ?? 0),
    };
  });
}

/** Resumen de rendimientos de todos los bancos; lo registrado corresponde al año `year`. */
export async function yieldsSummary(banks: Bank[], year: number): Promise<YieldsSummary> {
  const rows = await query<{ month: number; total: number }>(
    `SELECT EXTRACT(MONTH FROM b.date)::int AS month, COALESCE(SUM(b.amount), 0) AS total
       FROM balance_adjustments b
       JOIN accounts a ON a.id = b.account_id
      WHERE b.source = 'rendimiento' AND b.date >= a.opening_date
        AND b.date >= $1::date AND b.date < $2::date
      GROUP BY 1`,
    [`${year}-01-01`, `${year + 1}-01-01`],
  );
  const byMonth = new Map(rows.map((r) => [Number(r.month), Number(r.total) || 0]));
  const monthly_registered = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, amount: round2(byMonth.get(i + 1) ?? 0) }));
  const sum = (pick: (b: Bank) => number): number => round2(banks.reduce((acc, b) => acc + pick(b), 0));
  const est_year = sum((b) => b.est_yield_year);
  const yield_balance = sum((b) => b.yield_balance);
  return {
    est_day: sum((b) => b.est_yield_day),
    est_month: sum((b) => b.est_yield_month),
    est_year,
    effective_rate: yield_balance > 0 ? Math.round((est_year / yield_balance) * 100 * 1000) / 1000 : 0,
    yield_balance,
    over_cap_total: sum((b) => b.over_cap),
    registered_year: round2(monthly_registered.reduce((acc, r) => acc + r.amount, 0)),
    monthly_registered,
    suggestions: yieldSuggestions(
      banks.map((b) => ({ id: b.id, name: b.name, annual_rate: b.annual_rate, yield_cap: b.yield_cap, rate_above_cap: b.rate_above_cap })),
      new Map(banks.map((b) => [b.id, b.yield_balance])),
    ),
  };
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
  // Para mostrar: la forma escrita más usada del banco; en empate, la de la cuenta más antigua (id menor).
  const spellings = new Map<string, Map<string, { count: number; firstId: number }>>();
  for (const a of accounts) {
    if (a.archived) continue;
    const label = bankLabel(a);
    const key = label.toLocaleLowerCase('es');
    const variants = spellings.get(key) ?? new Map<string, { count: number; firstId: number }>();
    const v = variants.get(label) ?? { count: 0, firstId: a.id };
    v.count += 1;
    v.firstId = Math.min(v.firstId, a.id);
    variants.set(label, v);
    spellings.set(key, variants);
  }
  for (const a of accounts) {
    if (a.archived) continue;
    const key = bankLabel(a).toLocaleLowerCase('es');
    const best = [...(spellings.get(key) ?? new Map()).entries()].sort((x, y) => y[1].count - x[1].count || x[1].firstId - y[1].firstId)[0];
    const label = best ? best[0] : bankLabel(a);
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
