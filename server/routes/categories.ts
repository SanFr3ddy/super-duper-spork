import { Router } from 'express';
import { z } from 'zod';
import { query, one, type Row } from '../db.js';
import { validate, parseId, HttpError, notFound, zColor, zIcon, zName, zTxType } from '../util.js';
import type { Category } from '../../shared/types.js';

export const categoriesRouter = Router();

type CategoryRow = Category & Row;

const DEFAULT_COLOR = '#e5202e';

const categorySchema = z.object({
  name: zName,
  type: zTxType,
  color: zColor.optional(),
  icon: zIcon,
});
const categoryPartial = categorySchema.partial();

const SELECT = 'SELECT id, name, type, color, icon, created_at FROM categories';

async function fetchCategory(id: number): Promise<Category> {
  const row = await one<CategoryRow>(`${SELECT} WHERE id = $1`, [id]);
  if (!row) throw notFound('Categoría');
  return row;
}

/** Lanza 409 si ya existe otra categoría con el mismo nombre (sin distinguir mayúsculas) y tipo. */
async function assertUnique(name: string, type: string, excludeId: number | null): Promise<void> {
  const dup = await one<{ id: number }>(
    'SELECT id FROM categories WHERE lower(name) = lower($1) AND type = $2 AND ($3::int IS NULL OR id <> $3) LIMIT 1',
    [name, type, excludeId],
  );
  if (dup) throw new HttpError(409, 'Ya existe una categoría con ese nombre');
}

// GET /api/categories?type=income|expense
categoriesRouter.get('/', async (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : '';
  if (type && type !== 'income' && type !== 'expense') throw new HttpError(400, 'type inválido (income|expense)');
  const rows = type
    ? await query<CategoryRow>(`${SELECT} WHERE type = $1 ORDER BY type, name`, [type])
    : await query<CategoryRow>(`${SELECT} ORDER BY type, name`);
  res.json(rows satisfies Category[]);
});

// POST /api/categories
categoriesRouter.post('/', async (req, res) => {
  const data = validate(categorySchema, req.body);
  await assertUnique(data.name, data.type, null);
  const row = await one<{ id: number }>(
    'INSERT INTO categories (name, type, color, icon) VALUES ($1, $2, $3, $4) RETURNING id',
    [data.name, data.type, data.color ?? DEFAULT_COLOR, data.icon ?? null],
  );
  res.status(201).json(await fetchCategory(row!.id));
});

// PUT /api/categories/:id
categoriesRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(categoryPartial, req.body);
  const existing = await fetchCategory(id);

  const name = data.name ?? existing.name;
  const type = data.type ?? existing.type;
  if (data.name !== undefined || data.type !== undefined) await assertUnique(name, type, id);

  // Cambiar el tipo solo si no deja datos incoherentes: movimientos del otro tipo o presupuestos
  // (que solo existen para categorías de gasto).
  if (data.type !== undefined && data.type !== existing.type) {
    const usedTx = await one<{ n: number }>('SELECT count(*)::int AS n FROM transactions WHERE category_id = $1 AND type <> $2', [id, data.type]);
    const usedBudget = data.type === 'income' ? await one<{ n: number }>('SELECT count(*)::int AS n FROM budgets WHERE category_id = $1', [id]) : null;
    const nTx = usedTx?.n ?? 0;
    const nBud = usedBudget?.n ?? 0;
    if (nTx > 0 || nBud > 0) {
      const parts = [nTx > 0 ? `${nTx} movimiento${nTx === 1 ? '' : 's'}` : '', nBud > 0 ? `${nBud} presupuesto${nBud === 1 ? '' : 's'}` : ''].filter(Boolean);
      throw new HttpError(409, `No se puede cambiar el tipo: la categoría tiene ${parts.join(' y ')}. Crea una categoría nueva del otro tipo.`);
    }
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (data.name !== undefined) {
    params.push(data.name);
    sets.push(`name = $${params.length}`);
  }
  if (data.type !== undefined) {
    params.push(data.type);
    sets.push(`type = $${params.length}`);
  }
  if (data.color !== undefined) {
    params.push(data.color);
    sets.push(`color = $${params.length}`);
  }
  if (data.icon !== undefined) {
    params.push(data.icon);
    sets.push(`icon = $${params.length}`);
  }
  if (sets.length) {
    params.push(id);
    await query(`UPDATE categories SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
  }
  res.json(await fetchCategory(id));
});

// DELETE /api/categories/:id
// Los movimientos conservan su fila con category_id NULL (ON DELETE SET NULL);
// los presupuestos de la categoría se eliminan (ON DELETE CASCADE).
categoriesRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM categories WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Categoría');
  res.json({ ok: true });
});
