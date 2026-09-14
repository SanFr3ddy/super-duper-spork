/**
 * Tipos compartidos entre servidor (Express) y cliente (Vite).
 *
 * Convenciones:
 *  - Fechas de calendario: string 'YYYY-MM-DD' (columna DATE).
 *  - Marcas de tiempo: string ISO 8601 (columna TIMESTAMPTZ).
 *  - Montos: number (NUMERIC(14,2) en PostgreSQL, convertido a número en server/db.ts).
 *  - Todos los endpoints viven bajo /api y responden JSON.
 *  - Errores: { error: string, details?: unknown } con el status HTTP adecuado (400, 401, 404, 500).
 *
 * REGLAS DE FLUJO DE EFECTIVO (las usan /api/dashboard y /api/budgets):
 *  - Ingresos  = transactions.type = 'income'
 *  - Gastos    = transactions.type = 'expense' (incluye compras con tarjeta, contadas en la fecha de la compra)
 *  - Pagos de tarjeta (card_payments) NO cuentan como gasto (evita duplicar); solo reducen la deuda de la tarjeta.
 *  - Pagos de préstamo (loan_payments) SÍ cuentan como salida ("Préstamos"), separada de Gastos.
 *  - Aportes a metas (goal_contributions) cuentan como "Ahorro".
 *  - Flujo neto del mes = Ingresos - Gastos - Préstamos - Ahorro   (antes llamado "Disponible")
 *  - Tasa de ahorro = Ahorro / Ingresos (0 si no hay ingresos)
 *
 * CUENTAS ("Mi dinero": dinero real y en qué banco está). Son independientes de las metas de ahorro.
 *  Saldo de una cuenta a una fecha D = opening_balance
 *    + ingresos con account_id                       (transactions.type='income')
 *    - gastos con account_id y SIN tarjeta de crédito (una compra con tarjeta no toca la cuenta)
 *    - pagos de tarjeta con account_id (card_payments) - pagos de préstamo con account_id (loan_payments)
 *    + transferencias recibidas - transferencias enviadas + ajustes de saldo (signo incluido)
 *  contando solo eventos con opening_date <= fecha <= D. El "saldo actual" usa D = hoy (TZ del servidor).
 *  Implementación única en server/accountsData.ts; no dupliques la fórmula.
 *
 * COMPRAS A MESES (diferidas / meses sin intereses), solo gastos con tarjeta de crédito:
 *  - transactions.installments = número de mensualidades (1 = una sola exhibición).
 *  - La compra sigue contando como GASTO COMPLETO en su fecha (flujo, presupuestos y resumen no cambian).
 *  - Mensualidad = round2(total / n); la última ajusta centavos (total - mensualidad * (n - 1)).
 *  - La mensualidad k (1..n) corresponde al mes (mes de compra + k): la primera se paga el mes siguiente a la compra.
 *  - Deuda diferida pendiente de una tarjeta = suma de mensualidades de meses POSTERIORES al mes de referencia.
 *  - Pago para no generar intereses este mes = max(0, deuda de la tarjeta - deuda diferida pendiente).
 *  Implementación única en server/installments.ts.
 */

export type TxType = 'income' | 'expense';

// ---------------------------------------------------------------------------
// Configuración pública: GET /api/config  (no requiere sesión)
// ---------------------------------------------------------------------------
export interface AppConfig {
  currency: string; // p. ej. 'MXN'
  locale: string; // p. ej. 'es-MX'
}

// ---------------------------------------------------------------------------
// Autenticación
//  GET  /api/auth/status  -> AuthStatus
//  POST /api/auth/login   { password: string } -> { ok: true }
//  POST /api/auth/logout  -> { ok: true }
// ---------------------------------------------------------------------------
export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

// ---------------------------------------------------------------------------
// Categorías
//  GET    /api/categories?type=income|expense  -> Category[]
//  POST   /api/categories        CategoryInput -> Category
//  PUT    /api/categories/:id    Partial<CategoryInput> -> Category
//  DELETE /api/categories/:id    -> { ok: true }
// ---------------------------------------------------------------------------
export interface Category {
  id: number;
  name: string;
  type: TxType;
  color: string; // hex '#rrggbb'
  icon: string | null; // emoji opcional
  created_at: string;
}
export interface CategoryInput {
  name: string;
  type: TxType;
  color?: string;
  icon?: string | null;
}

// ---------------------------------------------------------------------------
// Movimientos (ingresos y gastos)
//  GET    /api/transactions?year=2026&month=9&type=&category_id=&credit_card_id=&account_id=&q=
//           -> TransactionsResponse
//           (year y month opcionales; si faltan se usa el mes actual. month=0 => todo el año)
//  POST   /api/transactions       TransactionInput -> Transaction
//  PUT    /api/transactions/:id   Partial<TransactionInput> -> Transaction
//  DELETE /api/transactions/:id   -> { ok: true }
// ---------------------------------------------------------------------------
export interface Transaction {
  id: number;
  type: TxType;
  amount: number;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
  description: string;
  date: string;
  credit_card_id: number | null;
  card_name: string | null;
  account_id: number | null; // cuenta de donde salió (gasto) o a donde entró (ingreso)
  account_name: string | null;
  account_bank: string | null;
  installments: number; // 1 = una sola exhibición; >1 = compra a meses con tarjeta
  recurring_id: number | null; // si lo registró automáticamente un cargo recurrente
  created_at: string;
}
export interface TransactionInput {
  type: TxType;
  amount: number;
  category_id?: number | null;
  description?: string;
  date: string;
  credit_card_id?: number | null; // solo para gastos pagados con tarjeta de crédito
  account_id?: number | null; // cuenta; el servidor la fuerza a null si hay credit_card_id
  installments?: number; // 1..48; el servidor lo fuerza a 1 si no es gasto con tarjeta
}
export interface TransactionsResponse {
  items: Transaction[];
  totals: { income: number; expenses: number; net: number };
}

// ---------------------------------------------------------------------------
// Tarjetas de crédito
//  GET    /api/cards                -> CreditCard[] (con campos calculados)
//  POST   /api/cards                CreditCardInput -> CreditCard
//  PUT    /api/cards/:id            Partial<CreditCardInput> -> CreditCard
//  DELETE /api/cards/:id            -> { ok: true }
//  GET    /api/cards/:id/payments   -> CardPayment[]
//  POST   /api/cards/:id/payments   CardPaymentInput -> CardPayment
//  DELETE /api/cards/:id/payments/:paymentId -> { ok: true }
//  GET    /api/cards/:id/charges?limit=20 -> Transaction[] (compras hechas con la tarjeta)
//  GET    /api/cards/installments?year=2026&month=9 -> InstallmentsResponse (compras a meses; por defecto el mes actual)
// ---------------------------------------------------------------------------
export interface CreditCard {
  id: number;
  name: string;
  credit_limit: number;
  cutoff_day: number; // día de corte (1-31)
  payment_day: number; // día límite de pago (1-31)
  color: string;
  created_at: string;
  // calculados
  charged_total: number; // suma de gastos con esta tarjeta (histórico)
  paid_total: number; // suma de pagos a la tarjeta (histórico)
  balance: number; // charged_total - paid_total (deuda actual, mínimo 0)
  utilization: number; // balance / credit_limit (0..1+), 0 si no hay límite
  charged_this_month: number; // gastos con la tarjeta en el mes actual
  paid_this_month: number; // pagos a la tarjeta en el mes actual
  last_payment_date: string | null;
  next_cutoff_date: string; // próxima fecha de corte 'YYYY-MM-DD'
  next_payment_date: string; // próxima fecha límite de pago 'YYYY-MM-DD'
  // compras a meses (mes de referencia = mes actual)
  active_plans: number; // compras a meses con mensualidades pendientes o del mes actual
  installments_due_this_month: number; // suma de mensualidades que tocan este mes
  deferred_remaining: number; // mensualidades de meses posteriores (aún no exigibles)
  pay_this_month: number; // pago para no generar intereses = max(0, balance - deferred_remaining)
}

export type InstallmentStatus = 'pendiente' | 'activa' | 'terminada';

export interface InstallmentPlan {
  transaction_id: number;
  credit_card_id: number;
  card_name: string;
  description: string; // descripción o, si está vacía, nombre de la categoría
  category_icon: string | null;
  purchase_date: string;
  total: number;
  installments: number;
  monthly_amount: number; // mensualidad normal (la última puede diferir por centavos)
  first_month: string; // 'YYYY-MM' de la mensualidad 1
  last_month: string; // 'YYYY-MM' de la última mensualidad
  current_number: number; // mensualidad que toca en el mes de referencia (0 = aún no empieza; > installments = terminada)
  status: InstallmentStatus;
  due_this_month: number; // monto de la mensualidad del mes de referencia (0 si no toca)
  billed_amount: number; // suma de mensualidades hasta el mes de referencia (incluido)
  remaining_amount: number; // total - billed_amount
  remaining_installments: number; // mensualidades después del mes de referencia
}

export interface InstallmentsResponse {
  year: number;
  month: number;
  items: InstallmentPlan[]; // activas y pendientes primero (por fecha de fin), luego terminadas (máx. 12 más recientes)
  totals: { due_this_month: number; deferred_remaining: number; active_plans: number };
  by_card: { credit_card_id: number; card_name: string; due_this_month: number; deferred_remaining: number; active_plans: number }[];
  schedule: { month: string; amount: number }[]; // próximos 12 meses desde el mes de referencia (incluido): 'YYYY-MM' y total de mensualidades
}
export interface CreditCardInput {
  name: string;
  credit_limit: number;
  cutoff_day: number;
  payment_day: number;
  color?: string;
}
export interface CardPayment {
  id: number;
  credit_card_id: number;
  amount: number;
  date: string;
  note: string;
  account_id: number | null; // cuenta con la que se pagó
  account_name: string | null;
  created_at: string;
}
export interface CardPaymentInput {
  amount: number;
  date: string;
  note?: string;
  account_id?: number | null;
}

// ---------------------------------------------------------------------------
// Préstamos
//  GET    /api/loans                 -> Loan[] (con calculados)
//  POST   /api/loans                 LoanInput -> Loan
//  PUT    /api/loans/:id             Partial<LoanInput> -> Loan
//  DELETE /api/loans/:id             -> { ok: true }
//  GET    /api/loans/:id/payments    -> LoanPayment[]
//  POST   /api/loans/:id/payments    LoanPaymentInput -> LoanPayment
//  DELETE /api/loans/:id/payments/:paymentId -> { ok: true }
//  GET    /api/loans/:id/schedule    -> LoanScheduleRow[] (tabla de amortización teórica)
// ---------------------------------------------------------------------------
export interface Loan {
  id: number;
  name: string;
  principal: number; // monto original
  annual_rate: number; // tasa anual en porcentaje, p. ej. 18.5
  monthly_payment: number; // pago mensual acordado
  start_date: string;
  term_months: number;
  created_at: string;
  // calculados
  paid_total: number;
  payments_count: number;
  remaining: number; // saldo actual CON intereses mensuales hasta hoy, menos pagos (mínimo 0). Ver server/loanMath.ts
  progress: number; // capital amortizado / principal (0..1)
  interest_paid: number; // intereses generados hasta hoy
  last_payment_date: string | null;
  end_date: string; // start_date + term_months
  estimated_months_left: number | null; // meses para liquidar el saldo con el pago mensual; null si el pago es 0 o no cubre intereses
  total_interest_estimate: number; // interés total estimado según la tabla de amortización
}
export interface LoanInput {
  name: string;
  principal: number;
  annual_rate: number;
  monthly_payment: number;
  start_date: string;
  term_months: number;
}
export interface LoanPayment {
  id: number;
  loan_id: number;
  amount: number;
  date: string;
  note: string;
  account_id: number | null; // cuenta con la que se pagó
  account_name: string | null;
  created_at: string;
}
export interface LoanPaymentInput {
  amount: number;
  date: string;
  note?: string;
  account_id?: number | null;
}
export interface LoanScheduleRow {
  period: number; // 1..term_months
  date: string;
  payment: number;
  interest: number;
  principal: number;
  balance: number; // saldo después del pago
}

// ---------------------------------------------------------------------------
// Metas de ahorro
//  GET    /api/goals                       -> SavingsGoal[]
//  POST   /api/goals                       SavingsGoalInput -> SavingsGoal
//  PUT    /api/goals/:id                   Partial<SavingsGoalInput> -> SavingsGoal
//  DELETE /api/goals/:id                   -> { ok: true }
//  GET    /api/goals/:id/contributions     -> GoalContribution[]
//  POST   /api/goals/:id/contributions     GoalContributionInput -> GoalContribution
//  DELETE /api/goals/:id/contributions/:contributionId -> { ok: true }
// ---------------------------------------------------------------------------
export interface SavingsGoal {
  id: number;
  name: string;
  target_amount: number;
  deadline: string | null;
  color: string;
  icon: string | null;
  created_at: string;
  // calculados
  saved_total: number;
  remaining: number; // target - saved (mínimo 0)
  progress: number; // saved / target (0..1+)
  contributions_count: number;
  monthly_needed: number | null; // remaining / meses hasta deadline, null si no hay deadline o ya pasó
  completed: boolean;
}
export interface SavingsGoalInput {
  name: string;
  target_amount: number;
  deadline?: string | null;
  color?: string;
  icon?: string | null;
}
export interface GoalContribution {
  id: number;
  goal_id: number;
  amount: number; // puede ser negativo para retiros
  date: string;
  note: string;
  created_at: string;
}
export interface GoalContributionInput {
  amount: number;
  date: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Presupuestos mensuales por categoría de gasto
//  GET    /api/budgets?year=2026&month=9  -> BudgetsResponse
//  PUT    /api/budgets                    BudgetInput -> Budget (upsert por categoría+año+mes)
//  DELETE /api/budgets/:id                -> { ok: true }
//  POST   /api/budgets/copy               { from_year, from_month, to_year, to_month } -> { copied: number }
// ---------------------------------------------------------------------------
export interface Budget {
  id: number;
  category_id: number;
  category_name: string;
  category_color: string;
  category_icon: string | null;
  year: number;
  month: number;
  amount: number; // límite
  spent: number; // gastado en ese mes en esa categoría
  remaining: number; // amount - spent (puede ser negativo)
  ratio: number; // spent / amount (0..1+), 0 si amount = 0
}
export interface BudgetInput {
  category_id: number;
  year: number;
  month: number;
  amount: number;
}
export interface BudgetsResponse {
  year: number;
  month: number;
  items: Budget[];
  totals: { budgeted: number; spent: number; remaining: number };
  /** Categorías de gasto sin presupuesto ese mes, con lo gastado, para sugerir agregar */
  unbudgeted: {
    category_id: number;
    category_name: string;
    category_color: string;
    category_icon: string | null;
    spent: number;
  }[];
}

// ---------------------------------------------------------------------------
// Dashboard
//  GET /api/dashboard?year=2026  -> DashboardYear
// ---------------------------------------------------------------------------
export interface MonthSummary {
  month: number; // 1..12
  income: number;
  expenses: number;
  card_payments: number; // informativo, no se resta
  loan_payments: number;
  savings: number;
  net: number; // income - expenses - loan_payments - savings
  savings_rate: number; // savings / income (0 si income = 0)
}
export interface CategoryTotal {
  category_id: number | null;
  name: string;
  color: string;
  icon: string | null;
  total: number;
  share: number; // total / suma de la lista (0..1)
}
export interface DashboardYear {
  year: number;
  months: MonthSummary[]; // siempre 12 elementos, enero..diciembre
  totals: {
    income: number;
    expenses: number;
    loan_payments: number;
    savings: number;
    card_payments: number;
    net: number;
    savings_rate: number;
    avg_monthly_expenses: number; // promedio sobre meses con actividad
    best_month: number | null; // mes con mayor net (solo meses con actividad)
    worst_month: number | null; // mes con menor net (solo meses con actividad)
  };
  expenses_by_category: CategoryTotal[]; // del año, ordenado desc
  income_by_category: CategoryTotal[]; // del año, ordenado desc
  current_month: {
    year: number;
    month: number;
    income: number;
    expenses: number;
    savings: number;
    loan_payments: number;
    net: number;
    budget: { budgeted: number; spent: number } | null; // null si no hay presupuestos ese mes
    expenses_by_category: CategoryTotal[]; // del mes actual
  };
  cards: {
    count: number;
    total_debt: number;
    total_limit: number;
    utilization: number;
    next_payment: { name: string; date: string; balance: number } | null;
    installments_due_this_month: number; // mensualidades de compras a meses que tocan este mes (todas las tarjetas)
    deferred_remaining: number; // deuda diferida pendiente (meses posteriores)
    pay_this_month: number; // suma de pay_this_month de las tarjetas
  };
  loans: { count: number; total_remaining: number; total_principal: number; monthly_commitment: number };
  goals: { count: number; total_saved: number; total_target: number; progress: number };
  /** Dinero real en cuentas (no archivadas), saldo a hoy. */
  money: {
    total: number;
    disponible: number; // kind disponible + efectivo
    guardado: number; // kind ahorro + inversion
    accounts_count: number;
    by_bank: BankTotal[]; // top 5 por total desc
    est_yield_month: number; // rendimiento mensual estimado de todos los bancos
    est_yield_year: number;
    over_cap_total: number; // dinero por encima de topes de rendimiento
    top_suggestion: YieldSuggestion | null; // la sugerencia que más gana al año
  };
  /** Cargos recurrentes activos (suscripciones, pagos fijos). */
  recurring: {
    active: number;
    monthly_expense: number; // equivalente mensual de los cargos (gastos) activos
    monthly_income: number; // equivalente mensual de los ingresos recurrentes activos
    upcoming: UpcomingCharge[]; // próximos 30 días (máx. 6), por fecha
  };
  recent: Transaction[]; // últimos 8 movimientos
  available_years: number[]; // años con datos, desc (incluye el actual)
}

// ---------------------------------------------------------------------------
// Mi dinero: cuentas por banco, transferencias y ajustes
//  GET    /api/accounts?year=2026            -> AccountsOverview
//  GET    /api/accounts/list                 -> Account[] (todas, para selects; archivadas con archived=true)
//  POST   /api/accounts                      AccountInput -> Account
//  PUT    /api/accounts/:id                  Partial<AccountInput> -> Account
//  DELETE /api/accounts/:id                  -> { ok: true }
//           (movimientos/pagos quedan con account_id NULL; sus transferencias y ajustes se borran)
//  GET    /api/accounts/:id/movements        -> AccountMovement[] (más reciente primero, con saldo acumulado)
//  POST   /api/accounts/:id/adjust           AccountAdjustInput -> Account (crea un ajuste = saldo real - saldo calculado)
//  DELETE /api/accounts/:id/adjustments/:adjustmentId -> { ok: true }
//  POST   /api/accounts/transfers            TransferInput -> Transfer
//  DELETE /api/accounts/transfers/:id        -> { ok: true }
//  POST   /api/accounts/:id/yield            YieldInput -> Account (registra rendimiento pagado por el banco;
//           se guarda en balance_adjustments con source='rendimiento'; se borra con DELETE .../adjustments/:id)
//
// Mis bancos (rendimiento anual con tope)
//  GET    /api/banks                         -> Bank[] (con calculados, orden por nombre)
//  POST   /api/banks                         BankInput -> Bank   (409 si ya existe el nombre, sin distinguir mayúsculas)
//  PUT    /api/banks/:id                     Partial<BankInput> -> Bank (renombrar actualiza accounts.bank de sus cuentas)
//  DELETE /api/banks/:id                     -> { ok: true } (409 si tiene cuentas: primero muévelas o edítalas)
//
// RENDIMIENTOS (implementación única en server/yields.ts):
//  - Saldo que rinde de un banco = suma de balance de sus cuentas NO archivadas con earns_yield = true (mínimo 0).
//  - Rendimiento anual estimado = min(saldo, tope) * annual_rate/100 + max(0, saldo - tope) * rate_above_cap/100
//    (sin tope: saldo * annual_rate/100). Mensual = anual/12; diario = anual/365. Interés simple, es una ESTIMACIÓN.
//  - Por cuenta: parte proporcional a su saldo (si earns_yield y saldo > 0).
//  - Sugerencias: el dinero por encima del tope de un banco (que rinde rate_above_cap) se sugiere mover a bancos con
//    mayor tasa y espacio bajo su tope (o sin tope), en orden de tasa desc; solo si gana >= $1 al año.
// ---------------------------------------------------------------------------
export interface Bank {
  id: number;
  name: string;
  color: string;
  annual_rate: number; // % anual, p. ej. 15
  yield_cap: number | null; // monto máximo que genera annual_rate; null = sin tope
  rate_above_cap: number; // % anual para lo que exceda el tope (normalmente 0)
  created_at: string;
  // calculados (a hoy, cuentas no archivadas)
  accounts_count: number;
  balance: number; // suma de saldos de sus cuentas
  yield_balance: number; // saldo que rinde (cuentas con earns_yield, mínimo 0)
  over_cap: number; // saldo que rinde por encima del tope (0 si no hay tope)
  cap_room: number | null; // espacio libre bajo el tope (null si no hay tope)
  est_yield_day: number;
  est_yield_month: number;
  est_yield_year: number;
  effective_rate: number; // % anual efectivo sobre yield_balance (annual_rate si yield_balance = 0)
  yield_registered_year: number; // rendimientos registrados en el año actual en sus cuentas
}
export interface BankInput {
  name: string;
  color?: string;
  annual_rate: number; // 0..1000
  yield_cap?: number | null;
  rate_above_cap?: number;
}
export interface YieldInput {
  amount: number; // > 0
  date?: string; // por defecto hoy
  note?: string;
}
export interface YieldSuggestion {
  from_bank_id: number;
  from_bank: string;
  to_bank_id: number;
  to_bank: string;
  amount: number;
  extra_year: number; // rendimiento adicional estimado al año
}
export interface YieldsSummary {
  est_day: number;
  est_month: number;
  est_year: number;
  effective_rate: number; // % anual efectivo sobre todo el saldo que rinde
  yield_balance: number;
  over_cap_total: number;
  registered_year: number; // rendimientos registrados en el año del overview
  monthly_registered: { month: number; amount: number }[]; // 12 meses del año del overview
  suggestions: YieldSuggestion[];
}

export type AccountKind = 'disponible' | 'ahorro' | 'inversion' | 'efectivo';

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  disponible: 'Disponible (débito / nómina)',
  ahorro: 'Ahorro',
  inversion: 'Inversión',
  efectivo: 'Efectivo',
};

export interface Account {
  id: number;
  name: string; // p. ej. "Nómina", "Cuenta de ahorro"
  bank: string; // nombre del banco (copia de banks.name); '' si no tiene banco
  bank_id: number | null;
  earns_yield: boolean; // si su saldo cuenta para el rendimiento de su banco
  kind: AccountKind;
  opening_balance: number; // saldo al inicio de opening_date
  opening_date: string;
  color: string;
  archived: boolean;
  created_at: string;
  // calculados (a hoy)
  balance: number;
  est_yield_month: number; // parte proporcional del rendimiento mensual estimado de su banco
  inflow_this_month: number; // entradas del mes actual (ingresos, transferencias recibidas, ajustes +)
  outflow_this_month: number; // salidas del mes actual (positivo)
  last_movement_date: string | null;
  movements_count: number;
}
export interface AccountInput {
  name: string;
  bank_id?: number | null; // el nombre del banco lo pone el servidor
  earns_yield?: boolean; // por defecto true
  kind: AccountKind;
  opening_balance: number; // puede ser negativo (sobregiro)
  opening_date?: string; // por defecto hoy
  color?: string;
  archived?: boolean;
}
export interface AccountAdjustInput {
  balance: number; // saldo real que marca el banco
  date?: string; // por defecto hoy
  note?: string;
}

export type AccountMovementSource =
  | 'opening'
  | 'income'
  | 'expense'
  | 'card_payment'
  | 'loan_payment'
  | 'transfer_in'
  | 'transfer_out'
  | 'adjustment'
  | 'yield';

export interface AccountMovement {
  key: string; // único: 'opening', 'tx-12', 'cp-3', 'lp-5', 'tr-7', 'adj-2'
  source: AccountMovementSource;
  ref_id: number | null; // id del registro de origen (transacción, pago, transferencia o ajuste)
  date: string;
  description: string;
  amount: number; // con signo: + entra, - sale
  running_balance: number; // saldo después de este movimiento
  future: boolean; // fecha posterior a hoy (no cuenta en el saldo actual)
}

export interface Transfer {
  id: number;
  from_account_id: number;
  to_account_id: number;
  amount: number;
  date: string;
  note: string;
  created_at: string;
}
export interface TransferInput {
  from_account_id: number;
  to_account_id: number;
  amount: number;
  date: string;
  note?: string;
}

export interface BankTotal {
  bank: string; // nombre mostrado; 'Efectivo' para cuentas de efectivo sin banco, 'Sin banco' si está vacío
  total: number;
  share: number; // max(0,total) / suma de max(0,total) (0..1)
  accounts: number;
  disponible: number; // disponible + efectivo
  guardado: number; // ahorro + inversion
}

export interface AccountsMonth {
  month: number; // 1..12
  total: number | null; // saldo al cierre del mes (o a hoy en el mes actual); null = futuro o sin cuentas abiertas
  disponible: number | null;
  guardado: number | null;
}

export interface AccountsOverview {
  year: number;
  items: Account[]; // todas; activas primero, luego archivadas
  totals: {
    total: number;
    disponible: number; // disponible + efectivo
    guardado: number; // ahorro + inversion
    ahorro: number;
    inversion: number;
    efectivo: number;
    accounts: number; // cuentas activas
  }; // solo cuentas no archivadas
  by_bank: BankTotal[]; // solo no archivadas, total desc
  monthly: AccountsMonth[]; // siempre 12
  available_years: number[]; // desc, incluye el actual
  banks: Bank[]; // todos los bancos (también sin cuentas)
  yields: YieldsSummary;
}

// ---------------------------------------------------------------------------
// Cargos recurrentes (suscripciones, renta, pagos fijos, ingresos fijos)
//  GET    /api/recurring                     -> RecurringOverview
//  POST   /api/recurring                     RecurringInput -> RecurringCharge
//  PUT    /api/recurring/:id                 Partial<RecurringInput> -> RecurringCharge
//  DELETE /api/recurring/:id                 -> { ok: true } (los movimientos ya registrados se conservan)
//  POST   /api/recurring/run                 -> { posted: number } (registra ya los cargos vencidos)
//  GET    /api/recurring/upcoming?days=30    -> UpcomingCharge[] (1..366 días, por fecha)
//
// REGLAS (implementación única del calendario en server/recurring.ts):
//  - frequency 'daily':   start_date + k * interval_n días.
//  - frequency 'weekly':  primer día >= start_date con weekday (0 = domingo); luego cada 7 * interval_n días.
//  - frequency 'monthly': día day_of_month (ajustado al último día si el mes no lo tiene) del primer mes cuya fecha
//                         sea >= start_date; luego cada interval_n meses.
//  - frequency 'yearly':  month_of_year/day_of_month (ajustado) del primer año con fecha >= start_date; cada interval_n años.
//  - Nunca después de end_date (si hay).
//  - Registro automático (auto_post = true y active = true): cada ocurrencia con fecha <= hoy y > last_posted_date se
//    guarda como transacción (type, amount, category_id, description = name, account_id o credit_card_id,
//    installments = 1, recurring_id). Índice único (recurring_id, date): nunca se duplica. Se ejecuta al arrancar el
//    servidor, cada hora mientras está despierto y como máximo cada 5 minutos al recibir peticiones con sesión, así
//    se ponen al día los días en que Render estuvo dormido.
//  - Al crear: si backfill = false (por defecto) y start_date es pasado, last_posted_date = última ocurrencia ANTES de
//    hoy (no se registran cargos pasados; el de hoy sí). Con backfill = true se registran desde start_date (máx. 400).
//  - Borrar un movimiento generado no lo vuelve a crear (last_posted_date ya avanzó).
//  - Forma de pago igual que en movimientos: credit_card_id solo para gastos y entonces account_id = null.
//  - Equivalente mensual: daily = amount * 30.4375 / n; weekly = amount * 52 / 12 / n; monthly = amount / n;
//    yearly = amount / (12 * n).
// ---------------------------------------------------------------------------
export type RecurringFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

export const RECURRING_FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  daily: 'Cada día',
  weekly: 'Cada semana',
  monthly: 'Cada mes',
  yearly: 'Cada año',
};

export const WEEKDAY_LABELS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export interface RecurringCharge {
  id: number;
  name: string; // p. ej. "Netflix"; se usa como descripción del movimiento
  type: TxType;
  amount: number;
  category_id: number | null;
  category_name: string | null;
  category_icon: string | null;
  account_id: number | null;
  account_name: string | null;
  credit_card_id: number | null;
  card_name: string | null;
  frequency: RecurringFrequency;
  interval_n: number; // cada N días/semanas/meses/años (1 = cada uno)
  day_of_month: number | null; // monthly / yearly
  weekday: number | null; // weekly (0 = domingo)
  month_of_year: number | null; // yearly (1..12)
  start_date: string;
  end_date: string | null;
  active: boolean;
  auto_post: boolean;
  last_posted_date: string | null;
  color: string;
  created_at: string;
  // calculados
  schedule_label: string; // p. ej. "Cada mes el día 5", "Cada 2 semanas los lunes"
  next_date: string | null; // próxima ocurrencia > last_posted_date (o >= hoy si no hay), null si terminó
  next_dates: string[]; // próximas 3
  monthly_equivalent: number;
  posted_count: number; // movimientos generados por este cargo
  posted_total: number; // suma de esos movimientos
}

export interface RecurringInput {
  name: string;
  type?: TxType; // por defecto 'expense'
  amount: number;
  category_id?: number | null;
  account_id?: number | null;
  credit_card_id?: number | null;
  frequency: RecurringFrequency;
  interval_n?: number; // 1..365, por defecto 1
  day_of_month?: number | null; // requerido para monthly y yearly
  weekday?: number | null; // requerido para weekly
  month_of_year?: number | null; // requerido para yearly
  start_date?: string; // por defecto hoy
  end_date?: string | null;
  active?: boolean;
  auto_post?: boolean;
  color?: string;
  backfill?: boolean; // solo al crear
}

export interface UpcomingCharge {
  recurring_id: number;
  name: string;
  type: TxType;
  amount: number;
  date: string;
  payment_label: string; // "Tarjeta X", "Banco · Cuenta" o "Sin especificar"
  category_icon: string | null;
}

export interface RecurringOverview {
  items: RecurringCharge[]; // activos primero, luego por próxima fecha
  totals: {
    active: number;
    monthly_expense: number;
    monthly_income: number;
    next_30_days_expense: number;
  };
  upcoming: UpcomingCharge[]; // próximos 30 días
}
