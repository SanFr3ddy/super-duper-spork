import { Router } from 'express';
import { query } from '../db.js';
import { HttpError, monthRange, round2, todayISO } from '../util.js';
import { loanStatus, type LoanPaymentLite } from '../loanMath.js';
import { accountTotals, bankTotals, loadAccounts, loadBanks, yieldsSummary } from '../accountsData.js';
import { currentYM, loadPlanSources, totalsByCard } from '../installments.js';
import { recurringOverview } from '../recurringData.js';
import type { CategoryTotal, DashboardYear, MonthSummary, Transaction, TxType } from '../../shared/types.js';

/**
 * GET /api/dashboard?year=2026  -> DashboardYear
 *
 * Reglas de flujo de efectivo (shared/types.ts):
 *  - Ingresos/Gastos: transactions.type
 *  - Pagos de tarjeta: informativos (no restan)
 *  - Pagos de préstamo y aportes a metas: salidas separadas
 *  - net = income - expenses - loan_payments - savings  (flujo neto)
 *  - money: saldos de cuentas a hoy (server/accountsData.ts)
 *  - cards.*installments*: compras a meses del mes actual (server/installments.ts)
 *  - money.est_yield_* / over_cap_total / top_suggestion: rendimientos a hoy (loadBanks + yieldsSummary del año actual)
 *  - recurring: cargos recurrentes activos y próximos 30 días (server/recurringData.ts)
 */
export const dashboardRouter = Router();

const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10_000) / 10_000;
const pad2 = (n: number): string => String(n).padStart(2, '0');
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseYear(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) throw new HttpError(400, 'year inválido (debe estar entre 2000 y 2100)');
  return n;
}

/**
 * Próxima fecha en que cae el día `day` a partir de hoy (inclusive): si el día de este mes es >= hoy se usa
 * este mes, si no el siguiente. Si el mes no tiene ese día se ajusta al último día del mes.
 */
function nextDateForDay(day: number, today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const build = (yy: number, mm: number): string => {
    const last = new Date(yy, mm, 0).getDate();
    return `${yy}-${pad2(mm)}-${pad2(Math.min(day, last))}`;
  };
  const thisMonth = build(y, m);
  if (thisMonth >= today) return thisMonth;
  return m === 12 ? build(y + 1, 1) : build(y, m + 1);
}

type CategoryRow = {
  category_id: number | null;
  name: string;
  color: string;
  icon: string | null;
  total: number;
};

/** Totales por categoría (LEFT JOIN: sin categoría => 'Sin categoría'), orden desc, con share. */
async function categoryTotals(type: TxType, from: string, to: string): Promise<CategoryTotal[]> {
  const rows = await query<CategoryRow>(
    `SELECT t.category_id,
            COALESCE(c.name, 'Sin categoría') AS name,
            COALESCE(c.color, '#5e5e5e') AS color,
            c.icon,
            COALESCE(SUM(t.amount), 0) AS total
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.type = $1 AND t.date >= $2 AND t.date < $3
      GROUP BY t.category_id, c.name, c.color, c.icon
      ORDER BY total DESC, name ASC`,
    [type, from, to],
  );
  const sum = rows.reduce((acc, r) => acc + num(r.total), 0);
  return rows.map((r) => ({
    category_id: r.category_id,
    name: r.name,
    color: r.color,
    icon: r.icon ?? null,
    total: round2(num(r.total)),
    share: sum > 0 ? round4(num(r.total) / sum) : 0,
  }));
}

type TxMonthRow = {
  m: number;
  income: number;
  expenses: number;
};
type TotalMonthRow = {
  m: number;
  total: number;
};
type BudgetRow = {
  n: number;
  budgeted: number;
  spent: number;
};
type CardRow = {
  id: number;
  name: string;
  credit_limit: number;
  payment_day: number;
  charged: number;
  paid: number;
};
type LoanRow = {
  id: number;
  principal: number;
  annual_rate: number;
  monthly_payment: number;
  start_date: string;
  term_months: number;
};
type GoalRow = {
  id: number;
  target_amount: number;
  saved: number;
};
type RecentRow = Omit<Transaction, 'created_at'> & {
  created_at: string | Date;
};

dashboardRouter.get('/', async (req, res) => {
  const today = todayISO();
  const curYear = Number(today.slice(0, 4));
  const curMonth = Number(today.slice(5, 7));
  const year = parseYear(req.query.year, curYear);

  const { from, to } = monthRange(year, 0);
  const cmYear = year;
  const cmMonth = year === curYear ? curMonth : 12;
  const cm = monthRange(cmYear, cmMonth);

  const [txRows, cardPayRows, loanPayRows, goalContribRows, expensesByCategory, incomeByCategory, cmExpensesByCategory, budgetRow, cardRows, loanRows, loanPaymentRows, goalRows, recentRows, yearRows, accounts, planSources, recurringOv] =
    await Promise.all([
      query<TxMonthRow>(
        `SELECT EXTRACT(MONTH FROM date)::int AS m,
                COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
                COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expenses
           FROM transactions
          WHERE date >= $1 AND date < $2
          GROUP BY 1`,
        [from, to],
      ),
      query<TotalMonthRow>(
        `SELECT EXTRACT(MONTH FROM date)::int AS m, COALESCE(SUM(amount), 0) AS total
           FROM card_payments WHERE date >= $1 AND date < $2 GROUP BY 1`,
        [from, to],
      ),
      query<TotalMonthRow>(
        `SELECT EXTRACT(MONTH FROM date)::int AS m, COALESCE(SUM(amount), 0) AS total
           FROM loan_payments WHERE date >= $1 AND date < $2 GROUP BY 1`,
        [from, to],
      ),
      query<TotalMonthRow>(
        `SELECT EXTRACT(MONTH FROM date)::int AS m, COALESCE(SUM(amount), 0) AS total
           FROM goal_contributions WHERE date >= $1 AND date < $2 GROUP BY 1`,
        [from, to],
      ),
      categoryTotals('expense', from, to),
      categoryTotals('income', from, to),
      categoryTotals('expense', cm.from, cm.to),
      query<BudgetRow>(
        `SELECT COUNT(*)::int AS n,
                COALESCE(SUM(b.amount), 0) AS budgeted,
                COALESCE(SUM(s.spent), 0) AS spent
           FROM budgets b
           LEFT JOIN (
             SELECT category_id, SUM(amount) AS spent
               FROM transactions
              WHERE type = 'expense' AND date >= $3 AND date < $4
              GROUP BY category_id
           ) s ON s.category_id = b.category_id
          WHERE b.year = $1 AND b.month = $2`,
        [cmYear, cmMonth, cm.from, cm.to],
      ),
      query<CardRow>(
        `SELECT c.id, c.name, c.credit_limit, c.payment_day,
                COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.credit_card_id = c.id AND t.type = 'expense'), 0) AS charged,
                COALESCE((SELECT SUM(p.amount) FROM card_payments p WHERE p.credit_card_id = c.id), 0) AS paid
           FROM credit_cards c`,
      ),
      query<LoanRow>(`SELECT l.id, l.principal, l.annual_rate, l.monthly_payment, l.start_date, l.term_months FROM loans l`),
      query<{ loan_id: number; amount: number; date: string }>(`SELECT loan_id, amount, date FROM loan_payments ORDER BY date, id`),
      query<GoalRow>(
        `SELECT g.id, g.target_amount,
                COALESCE((SELECT SUM(gc.amount) FROM goal_contributions gc WHERE gc.goal_id = g.id), 0) AS saved
           FROM savings_goals g`,
      ),
      query<RecentRow>(
        `SELECT t.id, t.type, t.amount, t.category_id,
                c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
                t.description, t.date, t.credit_card_id, cc.name AS card_name,
                t.account_id, a.name AS account_name, a.bank AS account_bank, t.installments, t.recurring_id, t.created_at
           FROM transactions t
           LEFT JOIN categories c ON c.id = t.category_id
           LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
           LEFT JOIN accounts a ON a.id = t.account_id
          ORDER BY t.date DESC, t.id DESC
          LIMIT 8`,
      ),
      query<{ y: number }>(
        `SELECT y FROM (
           SELECT DISTINCT EXTRACT(YEAR FROM date)::int AS y FROM transactions
           UNION SELECT DISTINCT EXTRACT(YEAR FROM date)::int FROM card_payments
           UNION SELECT DISTINCT EXTRACT(YEAR FROM date)::int FROM loan_payments
           UNION SELECT DISTINCT EXTRACT(YEAR FROM date)::int FROM goal_contributions
         ) u ORDER BY y DESC`,
      ),
      loadAccounts(),
      loadPlanSources(),
      recurringOverview(today),
    ]);

  // Rendimientos a hoy: reutiliza la lista completa de cuentas (server/accountsData.ts + server/yields.ts).
  const banks = await loadBanks(accounts);
  const yields = await yieldsSummary(banks, curYear);

  // --- Meses (siempre 12) ---
  const months: MonthSummary[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    income: 0,
    expenses: 0,
    card_payments: 0,
    loan_payments: 0,
    savings: 0,
    net: 0,
    savings_rate: 0,
  }));
  const at = (m: number): MonthSummary | undefined => months[Number(m) - 1];
  for (const r of txRows) {
    const ms = at(r.m);
    if (!ms) continue;
    ms.income = round2(num(r.income));
    ms.expenses = round2(num(r.expenses));
  }
  for (const r of cardPayRows) {
    const ms = at(r.m);
    if (ms) ms.card_payments = round2(num(r.total));
  }
  for (const r of loanPayRows) {
    const ms = at(r.m);
    if (ms) ms.loan_payments = round2(num(r.total));
  }
  for (const r of goalContribRows) {
    const ms = at(r.m);
    if (ms) ms.savings = round2(num(r.total));
  }
  for (const ms of months) {
    ms.net = round2(ms.income - ms.expenses - ms.loan_payments - ms.savings);
    ms.savings_rate = ms.income > 0 ? round4(ms.savings / ms.income) : 0;
  }

  // --- Totales del año ---
  const sumOf = (key: 'income' | 'expenses' | 'card_payments' | 'loan_payments' | 'savings'): number =>
    round2(months.reduce((acc, m) => acc + m[key], 0));
  const tIncome = sumOf('income');
  const tExpenses = sumOf('expenses');
  const tLoans = sumOf('loan_payments');
  const tSavings = sumOf('savings');
  const tCardPayments = sumOf('card_payments');
  const tNet = round2(tIncome - tExpenses - tLoans - tSavings);
  const activeMonths = months.filter((m) => m.income > 0 || m.expenses > 0 || m.loan_payments > 0 || m.savings !== 0 || m.card_payments > 0);
  const expenseMonths = months.filter((m) => m.income > 0 || m.expenses > 0);
  const avgMonthlyExpenses = expenseMonths.length > 0 ? round2(expenseMonths.reduce((acc, m) => acc + m.expenses, 0) / expenseMonths.length) : 0;
  let bestMonth: number | null = null;
  let worstMonth: number | null = null;
  if (activeMonths.length > 0) {
    bestMonth = activeMonths.reduce((b, m) => (m.net > b.net ? m : b)).month;
    worstMonth = activeMonths.reduce((w, m) => (m.net < w.net ? m : w)).month;
  }

  // --- Mes actual (o diciembre si el año no es el actual) ---
  const cmSummary = months[cmMonth - 1];
  const budget = budgetRow[0];
  const budgetOut = budget && num(budget.n) > 0 ? { budgeted: round2(num(budget.budgeted)), spent: round2(num(budget.spent)) } : null;

  // --- Tarjetas (compras a meses respecto al mes actual, server/installments.ts) ---
  const installmentsByCard = totalsByCard(planSources, currentYM());
  let totalDebt = 0;
  let totalLimit = 0;
  let installmentsDue = 0;
  let deferredRemaining = 0;
  let payThisMonth = 0;
  let nextPayment: DashboardYear['cards']['next_payment'] = null;
  for (const c of cardRows) {
    const balance = round2(Math.max(0, num(c.charged) - num(c.paid)));
    const inst = installmentsByCard.get(c.id);
    installmentsDue += inst?.installments_due_this_month ?? 0;
    deferredRemaining += inst?.deferred_remaining ?? 0;
    payThisMonth += Math.max(0, balance - (inst?.deferred_remaining ?? 0));
    totalDebt += balance;
    totalLimit += num(c.credit_limit);
    if (balance > 0) {
      const date = nextDateForDay(num(c.payment_day) || 1, today);
      if (!nextPayment || date < nextPayment.date || (date === nextPayment.date && balance > nextPayment.balance)) {
        nextPayment = { name: c.name, date, balance };
      }
    }
  }
  totalDebt = round2(totalDebt);
  totalLimit = round2(totalLimit);

  // --- Mi dinero (saldos a hoy, cuentas no archivadas) ---
  const accTotals = accountTotals(accounts);

  // --- Préstamos ---
  let totalRemaining = 0;
  let totalPrincipal = 0;
  let monthlyCommitment = 0;
  const paymentsByLoan = new Map<number, LoanPaymentLite[]>();
  for (const p of loanPaymentRows) {
    const list = paymentsByLoan.get(p.loan_id) ?? [];
    list.push({ amount: num(p.amount), date: p.date });
    paymentsByLoan.set(p.loan_id, list);
  }
  for (const l of loanRows) {
    // Mismo saldo con intereses que /api/loans (server/loanMath.ts).
    const { remaining } = loanStatus(
      { principal: num(l.principal), annual_rate: num(l.annual_rate), monthly_payment: num(l.monthly_payment), start_date: l.start_date, term_months: num(l.term_months) },
      paymentsByLoan.get(l.id) ?? [],
      today,
    );
    totalRemaining += remaining;
    totalPrincipal += num(l.principal);
    if (remaining > 0) monthlyCommitment += num(l.monthly_payment);
  }

  // --- Metas ---
  let totalSaved = 0;
  let totalTarget = 0;
  for (const g of goalRows) {
    totalSaved += num(g.saved);
    totalTarget += num(g.target_amount);
  }
  totalSaved = round2(totalSaved);
  totalTarget = round2(totalTarget);

  // --- Últimos movimientos ---
  const recent: Transaction[] = recentRows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: round2(num(r.amount)),
    category_id: r.category_id ?? null,
    category_name: r.category_name ?? null,
    category_color: r.category_color ?? null,
    category_icon: r.category_icon ?? null,
    description: r.description ?? '',
    date: String(r.date),
    credit_card_id: r.credit_card_id ?? null,
    card_name: r.card_name ?? null,
    account_id: r.account_id ?? null,
    account_name: r.account_name ?? null,
    account_bank: r.account_name != null ? (r.account_bank ?? '') : null,
    installments: Math.max(1, num(r.installments) || 1),
    recurring_id: r.recurring_id ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));

  // --- Años disponibles ---
  const yearSet = new Set<number>([curYear, year]);
  for (const r of yearRows) {
    const y = Number(r.y);
    if (Number.isInteger(y)) yearSet.add(y);
  }
  const availableYears = [...yearSet].sort((a, b) => b - a);

  const body: DashboardYear = {
    year,
    months,
    totals: {
      income: tIncome,
      expenses: tExpenses,
      loan_payments: tLoans,
      savings: tSavings,
      card_payments: tCardPayments,
      net: tNet,
      savings_rate: tIncome > 0 ? round4(tSavings / tIncome) : 0,
      avg_monthly_expenses: avgMonthlyExpenses,
      best_month: bestMonth,
      worst_month: worstMonth,
    },
    expenses_by_category: expensesByCategory,
    income_by_category: incomeByCategory,
    current_month: {
      year: cmYear,
      month: cmMonth,
      income: cmSummary.income,
      expenses: cmSummary.expenses,
      savings: cmSummary.savings,
      loan_payments: cmSummary.loan_payments,
      net: cmSummary.net,
      budget: budgetOut,
      expenses_by_category: cmExpensesByCategory,
    },
    cards: {
      count: cardRows.length,
      total_debt: totalDebt,
      total_limit: totalLimit,
      utilization: totalLimit > 0 ? round4(totalDebt / totalLimit) : 0,
      next_payment: nextPayment,
      installments_due_this_month: round2(installmentsDue),
      deferred_remaining: round2(deferredRemaining),
      pay_this_month: round2(payThisMonth),
    },
    loans: {
      count: loanRows.length,
      total_remaining: round2(totalRemaining),
      total_principal: round2(totalPrincipal),
      monthly_commitment: round2(monthlyCommitment),
    },
    goals: {
      count: goalRows.length,
      total_saved: totalSaved,
      total_target: totalTarget,
      progress: totalTarget > 0 ? round4(totalSaved / totalTarget) : 0,
    },
    money: {
      total: accTotals.total,
      disponible: accTotals.disponible,
      guardado: accTotals.guardado,
      accounts_count: accTotals.accounts,
      by_bank: bankTotals(accounts).slice(0, 5),
      est_yield_month: yields.est_month,
      est_yield_year: yields.est_year,
      over_cap_total: yields.over_cap_total,
      top_suggestion: yields.suggestions[0] ?? null,
    },
    recurring: {
      active: recurringOv.totals.active,
      monthly_expense: recurringOv.totals.monthly_expense,
      monthly_income: recurringOv.totals.monthly_income,
      upcoming: recurringOv.upcoming.slice(0, 6),
    },
    recent,
    available_years: availableYears,
  };
  res.json(body);
});
