/**
 * Tarjetas de crédito: CRUD, pagos a la tarjeta y compras hechas con ella.
 *
 * Campos calculados (ver CreditCard en shared/types.ts):
 *  - charged_total / charged_this_month: gastos (transactions.type='expense') con credit_card_id = tarjeta.
 *  - paid_total / paid_this_month: card_payments de la tarjeta.
 *  - balance = max(0, charged_total - paid_total); utilization = balance / credit_limit (0 si no hay límite).
 *  - next_cutoff_date / next_payment_date: próxima ocurrencia del día de corte / pago a partir de hoy.
 *  - active_plans / installments_due_this_month / deferred_remaining: compras a meses (server/installments.ts).
 *  - pay_this_month = max(0, balance - deferred_remaining): pago para no generar intereses.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db.js';
import { validate, parseId, HttpError, notFound, monthRange, round2, zDate, zMoney, zMoneyNonNeg, zColor, zName, zNote, todayISO } from '../util.js';
import { installmentsOverview, loadPlanSources, totalsByCard, type CardInstallmentTotals } from '../installments.js';
import type { CreditCard, CardPayment, Transaction } from '../../shared/types.js';

export const cardsRouter = Router();

const DEFAULT_COLOR = '#e5202e';

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------
const zDay = z.number().int('Debe ser un entero').min(1, 'Mínimo 1').max(31, 'Máximo 31');

const cardSchema = z.object({
  name: zName,
  credit_limit: zMoneyNonNeg,
  cutoff_day: zDay,
  payment_day: zDay,
  color: zColor.optional(),
});

const paymentSchema = z.object({
  amount: zMoney,
  date: zDate,
  note: zNote.optional(),
  account_id: z.number().int('La cuenta debe ser un id entero').positive('La cuenta debe ser un id positivo').nullable().optional(),
});

const installmentsQuerySchema = z.object({
  year: z.number({ invalid_type_error: 'Debe ser un número' }).int('Debe ser un entero').min(2000, 'Mínimo 2000').max(2100, 'Máximo 2100'),
  month: z.number({ invalid_type_error: 'Debe ser un número' }).int('Debe ser un entero').min(1, 'Mínimo 1').max(12, 'Máximo 12'),
});

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------
function lastDayOfMonth(year: number, month: number): number {
  // month es 1..12; el día 0 del mes siguiente es el último día de este mes.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Próxima fecha (>= hoy) en la que cae el día `day` del mes. Si el día de este mes ya pasó, usa el mes
 * siguiente. Cuando el mes no tiene ese día (31 en febrero), se ajusta al último día del mes.
 */
export function nextDateForDay(day: number, today: string): string {
  const [ty, tm, td] = today.slice(0, 10).split('-').map(Number);
  const thisMonthDay = Math.min(day, lastDayOfMonth(ty, tm));
  if (thisMonthDay >= td) return isoDate(ty, tm, thisMonthDay);
  const ny = tm === 12 ? ty + 1 : ty;
  const nm = tm === 12 ? 1 : tm + 1;
  return isoDate(ny, nm, Math.min(day, lastDayOfMonth(ny, nm)));
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v ?? '');
}

// ---------------------------------------------------------------------------
// Carga de tarjetas con agregados (una sola consulta, sin N+1)
// ---------------------------------------------------------------------------
type CardRow = {
  id: number;
  name: string;
  credit_limit: number;
  cutoff_day: number;
  payment_day: number;
  color: string;
  created_at: Date | string;
  charged_total: number;
  charged_this_month: number;
  paid_total: number;
  paid_this_month: number;
  last_payment_date: string | null;
};

const CARDS_SQL = `
  SELECT c.id, c.name, c.credit_limit, c.cutoff_day, c.payment_day, c.color, c.created_at,
         COALESCE(t.charged_total, 0)      AS charged_total,
         COALESCE(t.charged_this_month, 0) AS charged_this_month,
         COALESCE(p.paid_total, 0)         AS paid_total,
         COALESCE(p.paid_this_month, 0)    AS paid_this_month,
         p.last_payment_date
    FROM credit_cards c
    LEFT JOIN (
      SELECT credit_card_id,
             SUM(amount) AS charged_total,
             COALESCE(SUM(amount) FILTER (WHERE date >= $1 AND date < $2), 0) AS charged_this_month
        FROM transactions
       WHERE type = 'expense' AND credit_card_id IS NOT NULL
       GROUP BY credit_card_id
    ) t ON t.credit_card_id = c.id
    LEFT JOIN (
      SELECT credit_card_id,
             SUM(amount) AS paid_total,
             COALESCE(SUM(amount) FILTER (WHERE date >= $1 AND date < $2), 0) AS paid_this_month,
             MAX(date) AS last_payment_date
        FROM card_payments
       GROUP BY credit_card_id
    ) p ON p.credit_card_id = c.id
   WHERE ($3::int IS NULL OR c.id = $3::int)
   ORDER BY c.name, c.id`;

const NO_PLANS: CardInstallmentTotals = { active_plans: 0, installments_due_this_month: 0, deferred_remaining: 0 };

function toCard(r: CardRow, today: string, plans: CardInstallmentTotals = NO_PLANS): CreditCard {
  const credit_limit = round2(Number(r.credit_limit) || 0);
  const charged_total = round2(Number(r.charged_total) || 0);
  const paid_total = round2(Number(r.paid_total) || 0);
  const balance = Math.max(0, round2(charged_total - paid_total));
  const utilization = credit_limit > 0 ? Math.round((balance / credit_limit) * 10_000) / 10_000 : 0;
  return {
    id: r.id,
    name: r.name,
    credit_limit,
    cutoff_day: r.cutoff_day,
    payment_day: r.payment_day,
    color: r.color,
    created_at: toIso(r.created_at),
    charged_total,
    paid_total,
    balance,
    utilization,
    charged_this_month: round2(Number(r.charged_this_month) || 0),
    paid_this_month: round2(Number(r.paid_this_month) || 0),
    last_payment_date: r.last_payment_date ?? null,
    next_cutoff_date: nextDateForDay(r.cutoff_day, today),
    next_payment_date: nextDateForDay(r.payment_day, today),
    active_plans: plans.active_plans,
    installments_due_this_month: round2(plans.installments_due_this_month),
    deferred_remaining: round2(plans.deferred_remaining),
    pay_this_month: Math.max(0, round2(balance - plans.deferred_remaining)),
  };
}

async function loadCards(id: number | null): Promise<CreditCard[]> {
  const today = todayISO();
  const [y, m] = today.split('-').map(Number);
  const { from, to } = monthRange(y, m);
  // Dos consultas en paralelo (tarjetas con agregados + compras a meses), sin N+1.
  const [rows, sources] = await Promise.all([query<CardRow>(CARDS_SQL, [from, to, id]), loadPlanSources(id ?? undefined)]);
  const plans = totalsByCard(sources, today.slice(0, 7));
  return rows.map((r) => toCard(r, today, plans.get(r.id)));
}

/** Devuelve la tarjeta completa (con calculados) o lanza 404. */
async function loadCard(id: number): Promise<CreditCard> {
  const [card] = await loadCards(id);
  if (!card) throw notFound('Tarjeta');
  return card;
}

async function ensureCardExists(id: number): Promise<void> {
  const row = await one<{ id: number }>('SELECT id FROM credit_cards WHERE id = $1', [id]);
  if (!row) throw notFound('Tarjeta');
}

// ---------------------------------------------------------------------------
// Tarjetas
// ---------------------------------------------------------------------------
cardsRouter.get('/', async (_req, res) => {
  const cards = await loadCards(null);
  res.json(cards);
});

// ---------------------------------------------------------------------------
// Compras a meses (antes de las rutas /:id)
// ---------------------------------------------------------------------------
function queryNumber(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  return Number(Array.isArray(raw) ? raw[0] : raw);
}

cardsRouter.get('/installments', async (req, res) => {
  const [ty, tm] = todayISO().split('-').map(Number);
  const { year, month } = validate(installmentsQuerySchema, {
    year: queryNumber(req.query.year, ty),
    month: queryNumber(req.query.month, tm),
  });
  res.json(await installmentsOverview(year, month));
});

cardsRouter.post('/', async (req, res) => {
  const data = validate(cardSchema, req.body);
  const row = await one<{ id: number }>(
    `INSERT INTO credit_cards (name, credit_limit, cutoff_day, payment_day, color)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [data.name, data.credit_limit, data.cutoff_day, data.payment_day, data.color ?? DEFAULT_COLOR],
  );
  if (!row) throw new HttpError(500, 'No se pudo crear la tarjeta');
  res.status(201).json(await loadCard(row.id));
});

cardsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(cardSchema.partial(), req.body);

  // Solo columnas conocidas (lista blanca) y solo las presentes en el body.
  const columns = ['name', 'credit_limit', 'cutoff_day', 'payment_day', 'color'] as const;
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const col of columns) {
    const value = data[col];
    if (value === undefined) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (sets.length === 0) {
    res.json(await loadCard(id));
    return;
  }
  params.push(id);
  const updated = await one<{ id: number }>(`UPDATE credit_cards SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
  if (!updated) throw notFound('Tarjeta');
  res.json(await loadCard(id));
});

cardsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  // Los pagos se borran en cascada; los gastos hechos con la tarjeta quedan con credit_card_id NULL (FK ON DELETE SET NULL).
  const deleted = await one<{ id: number }>('DELETE FROM credit_cards WHERE id = $1 RETURNING id', [id]);
  if (!deleted) throw notFound('Tarjeta');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Pagos a la tarjeta
// ---------------------------------------------------------------------------
type PaymentRow = {
  id: number;
  credit_card_id: number;
  amount: number;
  date: string;
  note: string;
  account_id: number | null;
  account_name: string | null;
  created_at: Date | string;
};

function toPayment(r: PaymentRow): CardPayment {
  return {
    id: r.id,
    credit_card_id: r.credit_card_id,
    amount: round2(Number(r.amount) || 0),
    date: r.date,
    note: r.note ?? '',
    account_id: r.account_id ?? null,
    account_name: r.account_name ?? null,
    created_at: toIso(r.created_at),
  };
}

cardsRouter.get('/:id/payments', async (req, res) => {
  const id = parseId(req.params.id);
  await ensureCardExists(id);
  const rows = await query<PaymentRow>(
    `SELECT p.id, p.credit_card_id, p.amount, p.date, p.note, p.account_id, a.name AS account_name, p.created_at
       FROM card_payments p
       LEFT JOIN accounts a ON a.id = p.account_id
      WHERE p.credit_card_id = $1
      ORDER BY p.date DESC, p.id DESC`,
    [id],
  );
  res.json(rows.map(toPayment));
});

cardsRouter.post('/:id/payments', async (req, res) => {
  const id = parseId(req.params.id);
  await ensureCardExists(id);
  const data = validate(paymentSchema, req.body);
  const accountId = data.account_id ?? null;
  if (accountId !== null) {
    const acc = await one<{ id: number }>('SELECT id FROM accounts WHERE id = $1', [accountId]);
    if (!acc) throw new HttpError(400, 'La cuenta no existe');
  }
  const row = await one<PaymentRow>(
    `WITH ins AS (
       INSERT INTO card_payments (credit_card_id, amount, date, note, account_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, credit_card_id, amount, date, note, account_id, created_at
     )
     SELECT ins.id, ins.credit_card_id, ins.amount, ins.date, ins.note, ins.account_id, a.name AS account_name, ins.created_at
       FROM ins LEFT JOIN accounts a ON a.id = ins.account_id`,
    [id, round2(data.amount), data.date, data.note ?? '', accountId],
  );
  if (!row) throw new HttpError(500, 'No se pudo registrar el pago');
  res.status(201).json(toPayment(row));
});

cardsRouter.delete('/:id/payments/:paymentId', async (req, res) => {
  const id = parseId(req.params.id);
  const paymentId = parseId(req.params.paymentId, 'paymentId');
  const deleted = await one<{ id: number }>('DELETE FROM card_payments WHERE id = $1 AND credit_card_id = $2 RETURNING id', [paymentId, id]);
  if (!deleted) throw notFound('Pago');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Compras hechas con la tarjeta
// ---------------------------------------------------------------------------
type TxRow = {
  id: number;
  type: 'income' | 'expense';
  amount: number;
  category_id: number | null;
  category_name: string | null;
  category_color: string | null;
  category_icon: string | null;
  description: string;
  date: string;
  credit_card_id: number | null;
  card_name: string | null;
  account_id: number | null;
  account_name: string | null;
  account_bank: string | null;
  installments: number;
  recurring_id: number | null;
  created_at: Date | string;
};

function parseLimit(raw: unknown): number {
  if (raw === undefined || raw === '') return 20;
  const n = Number(String(raw));
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new HttpError(400, 'limit debe ser un entero entre 1 y 200');
  return n;
}

cardsRouter.get('/:id/charges', async (req, res) => {
  const id = parseId(req.params.id);
  const limit = parseLimit(req.query.limit);
  await ensureCardExists(id);
  const rows = await query<TxRow>(
    `SELECT t.id, t.type, t.amount, t.category_id,
            c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            t.description, t.date, t.credit_card_id, cc.name AS card_name,
            t.account_id, a.name AS account_name, a.bank AS account_bank, t.installments, t.recurring_id, t.created_at
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
       LEFT JOIN accounts a ON a.id = t.account_id
      WHERE t.credit_card_id = $1 AND t.type = 'expense'
      ORDER BY t.date DESC, t.id DESC
      LIMIT $2`,
    [id, limit],
  );
  const items: Transaction[] = rows.map((r) => ({
    id: r.id,
    type: r.type,
    amount: round2(Number(r.amount) || 0),
    category_id: r.category_id ?? null,
    category_name: r.category_name ?? null,
    category_color: r.category_color ?? null,
    category_icon: r.category_icon ?? null,
    description: r.description ?? '',
    date: r.date,
    credit_card_id: r.credit_card_id ?? null,
    card_name: r.card_name ?? null,
    account_id: r.account_id ?? null,
    account_name: r.account_name ?? null,
    account_bank: r.account_bank ?? null,
    installments: Math.max(1, Number(r.installments) || 1),
    recurring_id: r.recurring_id ?? null,
    created_at: toIso(r.created_at),
  }));
  res.json(items);
});
