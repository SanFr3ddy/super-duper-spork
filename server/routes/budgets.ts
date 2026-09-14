/**
 * Presupuestos mensuales por categoría de gasto.
 *
 *  GET    /api/budgets?year&month  -> BudgetsResponse
 *  PUT    /api/budgets             BudgetInput -> Budget (upsert por categoría + año + mes)
 *  DELETE /api/budgets/:id         -> { ok: true }
 *  POST   /api/budgets/copy        { from_year, from_month, to_year, to_month } -> { copied }
 *
 * "Gastado" = SUM(transactions.amount) con type = 'expense' de esa categoría dentro del mes
 * (incluye compras con tarjeta; los pagos de tarjeta no cuentan). Ver reglas en shared/types.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db.js';
import { validate, parseId, HttpError, notFound, yearMonth, monthRange, round2, zMoneyNonNeg } from '../util.js';
import type { Budget, BudgetsResponse } from '../../shared/types.js';

export const budgetsRouter = Router();

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------
const zYear = z.number().int('Año inválido').min(2000, 'Año inválido').max(2100, 'Año inválido');
const zMonth = z.number().int('Mes inválido').min(1, 'Mes inválido').max(12, 'Mes inválido');

const budgetInput = z.object({
  category_id: z.number().int('Categoría inválida').positive('Categoría inválida'),
  year: zYear,
  month: zMonth,
  amount: zMoneyNonNeg,
});

const copyInput = z.object({
  from_year: zYear,
  from_month: zMonth,
  to_year: zYear,
  to_month: zMonth,
});

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------
type BudgetRow = {
  id: number;
  category_id: number;
  category_name: string;
  category_color: string;
  category_icon: string | null;
  year: number;
  month: number;
  amount: number;
  spent: number;
};

type UnbudgetedRow = {
  category_id: number;
  category_name: string;
  category_color: string;
  category_icon: string | null;
  spent: number;
};

/** Selección base de un presupuesto. $1 = desde, $2 = hasta (rango [desde, hasta) del mes). */
const BUDGET_SELECT = `
  SELECT b.id, b.category_id, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
         b.year, b.month, b.amount,
         COALESCE((
           SELECT SUM(t.amount) FROM transactions t
           WHERE t.type = 'expense' AND t.category_id = b.category_id AND t.date >= $1 AND t.date < $2
         ), 0) AS spent
  FROM budgets b
  JOIN categories c ON c.id = b.category_id`;

function toBudget(r: BudgetRow): Budget {
  const amount = round2(Number(r.amount) || 0);
  const spent = round2(Number(r.spent) || 0);
  const ratio = amount > 0 ? Math.round((spent / amount) * 10_000) / 10_000 : 0;
  return {
    id: r.id,
    category_id: r.category_id,
    category_name: r.category_name,
    category_color: r.category_color,
    category_icon: r.category_icon ?? null,
    year: r.year,
    month: r.month,
    amount,
    spent,
    remaining: round2(amount - spent),
    ratio,
  };
}

/** Presupuestos de un mes con lo gastado, ordenados por ratio DESC y luego nombre. */
async function listBudgets(year: number, month: number): Promise<Budget[]> {
  const { from, to } = monthRange(year, month);
  const rows = await query<BudgetRow>(`${BUDGET_SELECT} WHERE b.year = $3 AND b.month = $4`, [from, to, year, month]);
  return rows.map(toBudget).sort((a, b) => b.ratio - a.ratio || a.category_name.localeCompare(b.category_name, 'es'));
}

/** Carga un presupuesto completo (con spent/ratio) por id; 404 si no existe. */
async function loadBudget(id: number): Promise<Budget> {
  const base = await one<{ year: number; month: number }>('SELECT year, month FROM budgets WHERE id = $1', [id]);
  if (!base) throw notFound('Presupuesto');
  const { from, to } = monthRange(base.year, base.month);
  const row = await one<BudgetRow>(`${BUDGET_SELECT} WHERE b.id = $3`, [from, to, id]);
  if (!row) throw notFound('Presupuesto');
  return toBudget(row);
}

/** Categorías de gasto sin presupuesto en el mes, con lo gastado (incluye spent = 0). */
async function listUnbudgeted(year: number, month: number): Promise<BudgetsResponse['unbudgeted']> {
  const { from, to } = monthRange(year, month);
  const rows = await query<UnbudgetedRow>(
    `SELECT c.id AS category_id, c.name AS category_name, c.color AS category_color, c.icon AS category_icon,
            COALESCE(SUM(t.amount), 0) AS spent
     FROM categories c
     LEFT JOIN transactions t
       ON t.category_id = c.id AND t.type = 'expense' AND t.date >= $1 AND t.date < $2
     WHERE c.type = 'expense'
       AND NOT EXISTS (SELECT 1 FROM budgets b WHERE b.category_id = c.id AND b.year = $3 AND b.month = $4)
     GROUP BY c.id, c.name, c.color, c.icon
     ORDER BY spent DESC, c.name ASC`,
    [from, to, year, month],
  );
  return rows.map((r) => ({
    category_id: r.category_id,
    category_name: r.category_name,
    category_color: r.category_color,
    category_icon: r.category_icon ?? null,
    spent: round2(Number(r.spent) || 0),
  }));
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------

// GET /api/budgets?year&month
budgetsRouter.get('/', async (req, res) => {
  const { year, month } = yearMonth(req.query);
  if (month === 0) throw new HttpError(400, 'Selecciona un mes');

  const [items, unbudgeted] = await Promise.all([listBudgets(year, month), listUnbudgeted(year, month)]);
  const budgeted = round2(items.reduce((acc, b) => acc + b.amount, 0));
  const spent = round2(items.reduce((acc, b) => acc + b.spent, 0));

  const body: BudgetsResponse = {
    year,
    month,
    items,
    totals: { budgeted, spent, remaining: round2(budgeted - spent) },
    unbudgeted,
  };
  res.json(body);
});

// PUT /api/budgets  (upsert por categoría + año + mes)
budgetsRouter.put('/', async (req, res) => {
  const body = validate(budgetInput, req.body);

  const cat = await one<{ type: string }>('SELECT type FROM categories WHERE id = $1', [body.category_id]);
  if (!cat) throw new HttpError(400, 'La categoría no existe');
  if (cat.type !== 'expense') throw new HttpError(400, 'Solo se pueden presupuestar categorías de gasto');

  const row = await one<{ id: number }>(
    `INSERT INTO budgets (category_id, year, month, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (category_id, year, month) DO UPDATE SET amount = EXCLUDED.amount
     RETURNING id`,
    [body.category_id, body.year, body.month, round2(body.amount)],
  );
  if (!row) throw new HttpError(500, 'No se pudo guardar el presupuesto');
  res.json(await loadBudget(row.id));
});

// POST /api/budgets/copy  (copia sin sobrescribir los existentes)
budgetsRouter.post('/copy', async (req, res) => {
  const b = validate(copyInput, req.body);
  if (b.from_year === b.to_year && b.from_month === b.to_month) {
    throw new HttpError(400, 'El mes de origen y el de destino son el mismo');
  }
  const rows = await query<{ id: number }>(
    `INSERT INTO budgets (category_id, year, month, amount)
     SELECT category_id, $3::int, $4::int, amount
     FROM budgets
     WHERE year = $1 AND month = $2
     ON CONFLICT (category_id, year, month) DO NOTHING
     RETURNING id`,
    [b.from_year, b.from_month, b.to_year, b.to_month],
  );
  res.json({ copied: rows.length });
});

// DELETE /api/budgets/:id
budgetsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const rows = await query<{ id: number }>('DELETE FROM budgets WHERE id = $1 RETURNING id', [id]);
  if (rows.length === 0) throw notFound('Presupuesto');
  res.json({ ok: true });
});
