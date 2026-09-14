/**
 * Préstamos: CRUD, pagos registrados y tabla de amortización teórica (sistema francés).
 * Contrato: sección "Préstamos" de shared/types.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db.js';
import { validate, parseId, HttpError, notFound, round2, todayISO, zDate, zMoney, zMoneyNonNeg, zName, zNote } from '../util.js';
import { addMonths, buildSchedule, interestEstimate, loanStatus, type LoanPaymentLite, type LoanTerms } from '../loanMath.js';
import type { Loan, LoanPayment, LoanScheduleRow } from '../../shared/types.js';

export const loansRouter = Router();

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------
const loanSchema = z.object({
  name: zName,
  principal: zMoney,
  annual_rate: z.number().finite().min(0, 'La tasa no puede ser negativa').max(500, 'Tasa demasiado alta'),
  monthly_payment: zMoneyNonNeg,
  start_date: zDate,
  term_months: z.number().int('Debe ser un entero').min(1, 'Mínimo 1 mes').max(600, 'Máximo 600 meses'),
});
const loanUpdateSchema = loanSchema.partial();
const LOAN_COLUMNS = ['name', 'principal', 'annual_rate', 'monthly_payment', 'start_date', 'term_months'] as const;

const paymentSchema = z.object({
  amount: zMoney,
  date: zDate,
  note: zNote.optional(),
});

// ---------------------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------------------
type LoanRow = {
  id: number;
  name: string;
  principal: number;
  annual_rate: number;
  monthly_payment: number;
  start_date: string;
  term_months: number;
  created_at: Date | string;
  paid_total: number;
  payments_count: number;
  last_payment_date: string | null;
};

const LOAN_SELECT = `
  SELECT l.id, l.name, l.principal, l.annual_rate, l.monthly_payment, l.start_date, l.term_months, l.created_at,
         COALESCE(p.paid_total, 0)     AS paid_total,
         COALESCE(p.payments_count, 0) AS payments_count,
         p.last_payment_date
  FROM loans l
  LEFT JOIN (
    SELECT loan_id, SUM(amount) AS paid_total, COUNT(*) AS payments_count, MAX(date) AS last_payment_date
    FROM loan_payments
    GROUP BY loan_id
  ) p ON p.loan_id = l.id`;

function toIso(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function toLoan(row: LoanRow, payments: LoanPaymentLite[], today: string): Loan {
  const principal = Number(row.principal) || 0;
  const paidTotal = round2(Number(row.paid_total) || 0);
  const monthly = Number(row.monthly_payment) || 0;
  const terms: LoanTerms = {
    principal,
    annual_rate: Number(row.annual_rate) || 0,
    monthly_payment: monthly,
    start_date: row.start_date,
    term_months: row.term_months,
  };
  // Saldo con intereses mensuales (ver server/loanMath.ts).
  const status = loanStatus(terms, payments, today);
  return {
    id: row.id,
    name: row.name,
    principal,
    annual_rate: terms.annual_rate,
    monthly_payment: monthly,
    start_date: row.start_date,
    term_months: row.term_months,
    created_at: toIso(row.created_at),
    paid_total: paidTotal,
    payments_count: Number(row.payments_count) || 0,
    remaining: status.remaining,
    progress: status.progress,
    interest_paid: status.interest_paid,
    last_payment_date: row.last_payment_date ?? null,
    end_date: addMonths(row.start_date, row.term_months),
    estimated_months_left: status.estimated_months_left,
    total_interest_estimate: interestEstimate(terms),
  };
}

/** Pagos (monto y fecha) agrupados por préstamo; null = todos los préstamos. */
async function paymentsByLoan(loanId: number | null): Promise<Map<number, LoanPaymentLite[]>> {
  const rows = await query<{ loan_id: number; amount: number; date: string }>(
    'SELECT loan_id, amount, date FROM loan_payments WHERE ($1::int IS NULL OR loan_id = $1::int) ORDER BY date, id',
    [loanId],
  );
  const map = new Map<number, LoanPaymentLite[]>();
  for (const r of rows) {
    const list = map.get(r.loan_id) ?? [];
    list.push({ amount: Number(r.amount) || 0, date: r.date });
    map.set(r.loan_id, list);
  }
  return map;
}

async function loadLoan(id: number): Promise<Loan> {
  const [row, payments] = await Promise.all([one<LoanRow>(`${LOAN_SELECT} WHERE l.id = $1`, [id]), paymentsByLoan(id)]);
  if (!row) throw notFound('Préstamo');
  return toLoan(row, payments.get(id) ?? [], todayISO());
}

async function assertLoanExists(id: number): Promise<void> {
  const row = await one<{ id: number }>('SELECT id FROM loans WHERE id = $1', [id]);
  if (!row) throw notFound('Préstamo');
}

type PaymentRow = {
  id: number;
  loan_id: number;
  amount: number;
  date: string;
  note: string;
  created_at: Date | string;
};
const toPayment = (r: PaymentRow): LoanPayment => ({
  id: r.id,
  loan_id: r.loan_id,
  amount: Number(r.amount) || 0,
  date: r.date,
  note: r.note ?? '',
  created_at: toIso(r.created_at),
});

// ---------------------------------------------------------------------------
// Rutas: préstamos
// ---------------------------------------------------------------------------
loansRouter.get('/', async (_req, res) => {
  const [rows, payments] = await Promise.all([query<LoanRow>(`${LOAN_SELECT} ORDER BY l.created_at ASC, l.id ASC`), paymentsByLoan(null)]);
  const today = todayISO();
  res.json(rows.map((r) => toLoan(r, payments.get(r.id) ?? [], today)));
});

loansRouter.post('/', async (req, res) => {
  const data = validate(loanSchema, req.body);
  const row = await one<{ id: number }>(
    `INSERT INTO loans (name, principal, annual_rate, monthly_payment, start_date, term_months)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [data.name, data.principal, data.annual_rate, data.monthly_payment, data.start_date, data.term_months],
  );
  res.status(201).json(await loadLoan(row!.id));
});

loansRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(loanUpdateSchema, req.body);
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const col of LOAN_COLUMNS) {
    const value = data[col];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) throw new HttpError(400, 'No hay campos para actualizar');
  const row = await one<{ id: number }>(`UPDATE loans SET ${sets.join(', ')} WHERE id = $1 RETURNING id`, params);
  if (!row) throw notFound('Préstamo');
  res.json(await loadLoan(id));
});

loansRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM loans WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Préstamo');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Rutas: pagos
// ---------------------------------------------------------------------------
loansRouter.get('/:id/payments', async (req, res) => {
  const id = parseId(req.params.id);
  await assertLoanExists(id);
  const rows = await query<PaymentRow>(
    'SELECT id, loan_id, amount, date, note, created_at FROM loan_payments WHERE loan_id = $1 ORDER BY date DESC, id DESC',
    [id],
  );
  res.json(rows.map(toPayment));
});

loansRouter.post('/:id/payments', async (req, res) => {
  const id = parseId(req.params.id);
  await assertLoanExists(id);
  const data = validate(paymentSchema, req.body);
  const row = await one<PaymentRow>(
    `INSERT INTO loan_payments (loan_id, amount, date, note) VALUES ($1, $2, $3, $4)
     RETURNING id, loan_id, amount, date, note, created_at`,
    [id, data.amount, data.date, data.note ?? ''],
  );
  res.status(201).json(toPayment(row!));
});

loansRouter.delete('/:id/payments/:paymentId', async (req, res) => {
  const id = parseId(req.params.id);
  const paymentId = parseId(req.params.paymentId, 'paymentId');
  const row = await one<{ id: number }>('DELETE FROM loan_payments WHERE id = $1 AND loan_id = $2 RETURNING id', [paymentId, id]);
  if (!row) throw notFound('Pago');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Rutas: tabla de amortización
// ---------------------------------------------------------------------------
loansRouter.get('/:id/schedule', async (req, res) => {
  const id = parseId(req.params.id);
  const loan = await loadLoan(id);
  res.json(buildSchedule(loan));
});
