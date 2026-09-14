import { Router } from 'express';
import { z } from 'zod';
import { query, one, type Row } from '../db.js';
import { validate, parseId, HttpError, notFound, yearMonth, monthRange, round2, zDate, zMoney, zNote, zTxType } from '../util.js';
import { normalizeSegments, validatePlan } from '../installments.js';
import type { InstallmentSegment, Transaction, TransactionsResponse, TxType } from '../../shared/types.js';

export const transactionsRouter = Router();

type TxRow = Transaction & Row;

const zOptId = z.number().int().positive().nullable().optional();
const zInstallments = z.number().int('Meses: debe ser un número entero').min(1, 'Meses: mínimo 1').max(48, 'Meses: máximo 48');
const txSchema = z.object({
  type: zTxType,
  amount: zMoney,
  date: zDate,
  description: zNote.default(''),
  category_id: zOptId,
  credit_card_id: zOptId,
  account_id: zOptId,
  installments: zInstallments.optional(),
  installment_plan: z
    .array(z.object({ months: z.number().int('Meses del tramo: entero').min(1, 'Meses del tramo: mínimo 1').max(48), amount: zMoney }))
    .max(48)
    .nullable()
    .optional(),
  installment_first_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Primera mensualidad: formato YYYY-MM').nullable().optional(),
});
const txPartial = txSchema.partial();

const TX_FROM = `FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id
  LEFT JOIN accounts a ON a.id = t.account_id`;
const TX_SELECT = `SELECT t.id, t.type, t.amount, t.category_id,
    c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
    t.description, t.date, t.credit_card_id, cc.name AS card_name,
    t.account_id, a.name AS account_name, a.bank AS account_bank, t.installments, t.installment_plan, t.installment_first_month, t.recurring_id, t.created_at
  ${TX_FROM}`;

interface TxValues {
  type: TxType;
  amount: number;
  date: string;
  description: string;
  category_id: number | null;
  credit_card_id: number | null;
  account_id: number | null;
  installments: number;
  installment_plan: InstallmentSegment[] | null;
  installment_first_month: string | null;
}

function qstr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Escapa comodines de LIKE para que la búsqueda sea literal. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

async function fetchTx(id: number): Promise<Transaction> {
  const row = await one<TxRow>(`${TX_SELECT} WHERE t.id = $1`, [id]);
  if (!row) throw notFound('Movimiento');
  return row;
}

/**
 * Aplica las reglas de coherencia y verifica referencias. Devuelve los valores definitivos.
 *  - Ingreso: sin tarjeta y en una sola exhibición.
 *  - Gasto con tarjeta: no sale de una cuenta (account_id = null).
 *  - Sin tarjeta: installments = 1.
 *  - Desglose (installment_plan): solo gastos con tarjeta; debe sumar el total (server/installments.ts) y fija
 *    installments = suma de meses. Sin tarjeta o en una sola exhibición se borran desglose y primera mensualidad.
 */
async function normalize(v: TxValues): Promise<TxValues> {
  const out: TxValues = { ...v, amount: round2(v.amount) };
  if (out.type === 'income') {
    out.credit_card_id = null;
    out.installments = 1;
  }
  if (out.credit_card_id !== null) out.account_id = null;
  else out.installments = 1;

  out.installment_plan = out.credit_card_id !== null ? normalizeSegments(out.installment_plan) : null;
  if (out.installment_plan) out.installments = validatePlan(out.amount, out.installment_plan);
  if (out.installments <= 1) {
    out.installments = 1;
    out.installment_plan = null;
    out.installment_first_month = null;
  }

  if (out.category_id !== null) {
    const cat = await one<{ type: TxType }>('SELECT type FROM categories WHERE id = $1', [out.category_id]);
    if (!cat) throw new HttpError(400, 'La categoría no existe');
    if (cat.type !== out.type) throw new HttpError(400, 'La categoría no corresponde al tipo de movimiento');
  }
  if (out.credit_card_id !== null) {
    const card = await one<{ id: number }>('SELECT id FROM credit_cards WHERE id = $1', [out.credit_card_id]);
    if (!card) throw new HttpError(400, 'La tarjeta de crédito no existe');
  }
  if (out.account_id !== null) {
    const acc = await one<{ id: number }>('SELECT id FROM accounts WHERE id = $1', [out.account_id]);
    if (!acc) throw new HttpError(400, 'La cuenta no existe');
  }
  return out;
}

// GET /api/transactions?year=&month=&type=&category_id=&credit_card_id=&account_id=&q=
transactionsRouter.get('/', async (req, res) => {
  const { year, month } = yearMonth(req.query);
  const { from, to } = monthRange(year, month);
  const where: string[] = ['t.date >= $1', 't.date < $2'];
  const params: unknown[] = [from, to];

  const type = qstr(req.query.type);
  if (type) {
    if (type !== 'income' && type !== 'expense') throw new HttpError(400, 'type inválido (income|expense)');
    params.push(type);
    where.push(`t.type = $${params.length}`);
  }
  const categoryId = qstr(req.query.category_id);
  if (categoryId) {
    params.push(parseId(categoryId, 'category_id'));
    where.push(`t.category_id = $${params.length}`);
  }
  const cardId = qstr(req.query.credit_card_id);
  if (cardId) {
    params.push(parseId(cardId, 'credit_card_id'));
    where.push(`t.credit_card_id = $${params.length}`);
  }
  const accountId = qstr(req.query.account_id);
  if (accountId) {
    params.push(parseId(accountId, 'account_id'));
    where.push(`t.account_id = $${params.length}`);
  }
  const q = qstr(req.query.q).trim();
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    where.push(`(t.description ILIKE $${params.length} OR c.name ILIKE $${params.length})`);
  }
  const whereSql = where.join(' AND ');

  const [items, sums] = await Promise.all([
    query<TxRow>(`${TX_SELECT} WHERE ${whereSql} ORDER BY t.date DESC, t.id DESC`, params),
    one<{ income: number; expenses: number }>(
      `SELECT COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount ELSE 0 END), 0) AS income,
              COALESCE(SUM(CASE WHEN t.type = 'expense' THEN t.amount ELSE 0 END), 0) AS expenses
       ${TX_FROM} WHERE ${whereSql}`,
      params,
    ),
  ]);
  const income = round2(Number(sums?.income) || 0);
  const expenses = round2(Number(sums?.expenses) || 0);
  const body: TransactionsResponse = { items, totals: { income, expenses, net: round2(income - expenses) } };
  res.json(body);
});

// POST /api/transactions
transactionsRouter.post('/', async (req, res) => {
  const data = validate(txSchema, req.body);
  const v = await normalize({
    type: data.type,
    amount: data.amount,
    date: data.date,
    description: data.description,
    category_id: data.category_id ?? null,
    credit_card_id: data.credit_card_id ?? null,
    account_id: data.account_id ?? null,
    installments: data.installments ?? 1,
    installment_plan: data.installment_plan ?? null,
    installment_first_month: data.installment_first_month ?? null,
  });
  const row = await one<{ id: number }>(
    `INSERT INTO transactions (type, amount, category_id, description, date, credit_card_id, account_id, installments, installment_plan, installment_first_month)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [v.type, v.amount, v.category_id, v.description, v.date, v.credit_card_id, v.account_id, v.installments, v.installment_plan ? JSON.stringify(v.installment_plan) : null, v.installment_first_month],
  );
  res.status(201).json(await fetchTx(row!.id));
});

// PUT /api/transactions/:id  (los campos omitidos conservan su valor; luego se aplican las mismas reglas)
transactionsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(txPartial, req.body);
  const existing = await fetchTx(id);
  const v = await normalize({
    type: data.type ?? existing.type,
    amount: data.amount ?? existing.amount,
    date: data.date ?? existing.date,
    description: data.description ?? existing.description,
    category_id: data.category_id === undefined ? existing.category_id : data.category_id,
    credit_card_id: data.credit_card_id === undefined ? existing.credit_card_id : data.credit_card_id,
    account_id: data.account_id === undefined ? existing.account_id : data.account_id,
    installments: data.installments ?? (Number(existing.installments) || 1),
    // Si mandan installments sin desglose, pasa a pagos iguales; si no mandan nada, conserva el desglose existente.
    // (Si mandan el mismo número de meses que ya tenía, el desglose se conserva: Movimientos siempre manda installments.)
    installment_plan:
      data.installment_plan !== undefined
        ? data.installment_plan
        : data.installments !== undefined && data.installments !== Number(existing.installments)
          ? null
          : normalizeSegments(existing.installment_plan),
    installment_first_month: data.installment_first_month !== undefined ? data.installment_first_month : (existing.installment_first_month ?? null),
  });
  await query(
    `UPDATE transactions
     SET type = $1, amount = $2, category_id = $3, description = $4, date = $5, credit_card_id = $6,
         account_id = $7, installments = $8, installment_plan = $9, installment_first_month = $10
     WHERE id = $11`,
    [v.type, v.amount, v.category_id, v.description, v.date, v.credit_card_id, v.account_id, v.installments, v.installment_plan ? JSON.stringify(v.installment_plan) : null, v.installment_first_month, id],
  );
  res.json(await fetchTx(id));
});

// DELETE /api/transactions/:id
transactionsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM transactions WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Movimiento');
  res.json({ ok: true });
});
