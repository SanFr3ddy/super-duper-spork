import { Router } from 'express';
import { z } from 'zod';
import { query, one, type Row } from '../db.js';
import { validate, parseId, HttpError, notFound, yearMonth, monthRange, round2, zDate, zMoney, zNote, zTxType } from '../util.js';
import type { Transaction, TransactionsResponse, TxType } from '../../shared/types.js';

export const transactionsRouter = Router();

type TxRow = Transaction & Row;

const zOptId = z.number().int().positive().nullable().optional();
const txSchema = z.object({
  type: zTxType,
  amount: zMoney,
  date: zDate,
  description: zNote.default(''),
  category_id: zOptId,
  credit_card_id: zOptId,
});
const txPartial = txSchema.partial();

const TX_FROM = `FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN credit_cards cc ON cc.id = t.credit_card_id`;
const TX_SELECT = `SELECT t.id, t.type, t.amount, t.category_id,
    c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
    t.description, t.date, t.credit_card_id, cc.name AS card_name, t.created_at
  ${TX_FROM}`;

interface TxValues {
  type: TxType;
  amount: number;
  date: string;
  description: string;
  category_id: number | null;
  credit_card_id: number | null;
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

/** Aplica las reglas de coherencia y verifica referencias. Devuelve los valores definitivos. */
async function normalize(v: TxValues): Promise<TxValues> {
  const out: TxValues = { ...v };
  if (out.type === 'income') out.credit_card_id = null;
  if (out.category_id !== null) {
    const cat = await one<{ type: TxType }>('SELECT type FROM categories WHERE id = $1', [out.category_id]);
    if (!cat) throw new HttpError(400, 'La categoría no existe');
    if (cat.type !== out.type) throw new HttpError(400, 'La categoría no corresponde al tipo de movimiento');
  }
  if (out.credit_card_id !== null) {
    const card = await one<{ id: number }>('SELECT id FROM credit_cards WHERE id = $1', [out.credit_card_id]);
    if (!card) throw new HttpError(400, 'La tarjeta de crédito no existe');
  }
  return out;
}

// GET /api/transactions?year=&month=&type=&category_id=&credit_card_id=&q=
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
  });
  const row = await one<{ id: number }>(
    `INSERT INTO transactions (type, amount, category_id, description, date, credit_card_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [v.type, v.amount, v.category_id, v.description, v.date, v.credit_card_id],
  );
  res.status(201).json(await fetchTx(row!.id));
});

// PUT /api/transactions/:id
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
  });
  await query(
    `UPDATE transactions
     SET type = $1, amount = $2, category_id = $3, description = $4, date = $5, credit_card_id = $6
     WHERE id = $7`,
    [v.type, v.amount, v.category_id, v.description, v.date, v.credit_card_id, id],
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
