/**
 * Metas de ahorro: /api/goals
 *
 *  GET    /                                   -> SavingsGoal[] (con calculados, una sola consulta)
 *  POST   /                                   SavingsGoalInput -> SavingsGoal
 *  PUT    /:id                                Partial<SavingsGoalInput> -> SavingsGoal
 *  DELETE /:id                                -> { ok: true }   (borra en cascada los aportes)
 *  GET    /:id/contributions                  -> GoalContribution[] (date DESC, id DESC)
 *  POST   /:id/contributions                  GoalContributionInput -> GoalContribution (negativo = retiro)
 *  DELETE /:id/contributions/:contributionId  -> { ok: true }
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../db.js';
import { validate, parseId, HttpError, notFound, round2, zDate, zMoney, zColor, zIcon, zName, zNote, todayISO } from '../util.js';
import type { SavingsGoal, GoalContribution } from '../../shared/types.js';

export const goalsRouter = Router();

const DEFAULT_COLOR = '#e5202e';
const MAX_AMOUNT = 999_999_999_999;

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------
const goalSchema = z.object({
  name: zName,
  target_amount: zMoney,
  // '' se interpreta como "sin fecha límite" para tolerar inputs de fecha vacíos.
  deadline: z.preprocess((v) => (v === '' ? null : v), zDate.nullable()).optional(),
  color: zColor.optional(),
  icon: zIcon,
});

const contributionSchema = z.object({
  amount: z.number().finite().min(-MAX_AMOUNT, 'Monto demasiado grande').max(MAX_AMOUNT, 'Monto demasiado grande'),
  date: zDate,
  note: zNote.optional(),
});

// ---------------------------------------------------------------------------
// Filas y cálculo de campos derivados
// ---------------------------------------------------------------------------
type GoalRow = {
  id: number;
  name: string;
  target_amount: number;
  deadline: string | null;
  color: string;
  icon: string | null;
  created_at: Date | string;
  saved_total: number;
  contributions_count: number;
};

type ContributionRow = {
  id: number;
  goal_id: number;
  amount: number;
  date: string;
  note: string;
  created_at: Date | string;
};

/** Consulta base: metas + agregados de aportes (sin N+1). */
const GOAL_SELECT = `
  SELECT g.id, g.name, g.target_amount, g.deadline, g.color, g.icon, g.created_at,
         COALESCE(c.saved_total, 0) AS saved_total,
         COALESCE(c.contributions_count, 0) AS contributions_count
  FROM savings_goals g
  LEFT JOIN (
    SELECT goal_id, SUM(amount) AS saved_total, COUNT(*)::int AS contributions_count
    FROM goal_contributions
    GROUP BY goal_id
  ) c ON c.goal_id = g.id`;

/** Incompletas primero, luego por fecha límite (nulos al final), luego por creación. */
const GOAL_ORDER = `
  ORDER BY (COALESCE(c.saved_total, 0) >= g.target_amount) ASC,
           g.deadline ASC NULLS LAST,
           g.created_at ASC,
           g.id ASC`;

function toIso(v: Date | string | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  return String(v ?? '');
}

/** Diferencia de meses calendario entre dos fechas 'YYYY-MM-DD' (to - from). */
function monthsBetween(fromISO: string, toISO: string): number {
  const [y1, m1] = fromISO.slice(0, 10).split('-').map(Number);
  const [y2, m2] = toISO.slice(0, 10).split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

function decorate(row: GoalRow, today: string): SavingsGoal {
  const target = Number(row.target_amount) || 0;
  const saved = round2(Number(row.saved_total) || 0);
  const remaining = Math.max(0, round2(target - saved));
  const progress = target > 0 ? Math.max(0, Math.round((saved / target) * 10_000) / 10_000) : 0;
  const completed = saved >= target;

  let monthly_needed: number | null = null;
  if (row.deadline && row.deadline >= today && remaining > 0) {
    monthly_needed = round2(remaining / Math.max(1, monthsBetween(today, row.deadline)));
  }

  return {
    id: row.id,
    name: row.name,
    target_amount: target,
    deadline: row.deadline,
    color: row.color,
    icon: row.icon,
    created_at: toIso(row.created_at),
    saved_total: saved,
    remaining,
    progress,
    contributions_count: Number(row.contributions_count) || 0,
    monthly_needed,
    completed,
  };
}

function mapContribution(row: ContributionRow): GoalContribution {
  return {
    id: row.id,
    goal_id: row.goal_id,
    amount: Number(row.amount) || 0,
    date: row.date,
    note: row.note ?? '',
    created_at: toIso(row.created_at),
  };
}

async function loadGoal(id: number): Promise<SavingsGoal> {
  const row = await one<GoalRow>(`${GOAL_SELECT} WHERE g.id = $1`, [id]);
  if (!row) throw notFound('Meta');
  return decorate(row, todayISO());
}

async function ensureGoal(id: number): Promise<void> {
  const row = await one<{ id: number }>('SELECT id FROM savings_goals WHERE id = $1', [id]);
  if (!row) throw notFound('Meta');
}

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------
goalsRouter.get('/', async (_req, res) => {
  const rows = await query<GoalRow>(`${GOAL_SELECT}${GOAL_ORDER}`);
  const today = todayISO();
  const body: SavingsGoal[] = rows.map((r) => decorate(r, today));
  res.json(body);
});

goalsRouter.post('/', async (req, res) => {
  const data = validate(goalSchema, req.body);
  const row = await one<{ id: number }>(
    `INSERT INTO savings_goals (name, target_amount, deadline, color, icon)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [data.name, round2(data.target_amount), data.deadline ?? null, data.color ?? DEFAULT_COLOR, data.icon || null],
  );
  if (!row) throw new HttpError(500, 'No se pudo crear la meta');
  res.status(201).json(await loadGoal(row.id));
});

goalsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(goalSchema.partial(), req.body);

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (data.name !== undefined) add('name', data.name);
  if (data.target_amount !== undefined) add('target_amount', round2(data.target_amount));
  if (data.deadline !== undefined) add('deadline', data.deadline);
  if (data.color !== undefined) add('color', data.color);
  if (data.icon !== undefined) add('icon', data.icon || null);
  if (sets.length === 0) throw new HttpError(400, 'No hay campos para actualizar');

  params.push(id);
  const row = await one<{ id: number }>(`UPDATE savings_goals SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
  if (!row) throw notFound('Meta');
  res.json(await loadGoal(id));
});

goalsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM savings_goals WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Meta');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Aportes / retiros
// ---------------------------------------------------------------------------
goalsRouter.get('/:id/contributions', async (req, res) => {
  const id = parseId(req.params.id);
  await ensureGoal(id);
  const rows = await query<ContributionRow>(
    `SELECT id, goal_id, amount, date, note, created_at
     FROM goal_contributions
     WHERE goal_id = $1
     ORDER BY date DESC, id DESC`,
    [id],
  );
  const body: GoalContribution[] = rows.map(mapContribution);
  res.json(body);
});

goalsRouter.post('/:id/contributions', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(contributionSchema, req.body);
  const amount = round2(data.amount);
  if (amount === 0) throw new HttpError(400, 'El monto no puede ser 0');
  await ensureGoal(id);
  const row = await one<ContributionRow>(
    `INSERT INTO goal_contributions (goal_id, amount, date, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id, goal_id, amount, date, note, created_at`,
    [id, amount, data.date, data.note ?? ''],
  );
  if (!row) throw new HttpError(500, 'No se pudo registrar el aporte');
  res.status(201).json(mapContribution(row));
});

goalsRouter.delete('/:id/contributions/:contributionId', async (req, res) => {
  const id = parseId(req.params.id);
  const contributionId = parseId(req.params.contributionId, 'contributionId');
  const row = await one<{ id: number }>('DELETE FROM goal_contributions WHERE id = $1 AND goal_id = $2 RETURNING id', [contributionId, id]);
  if (!row) throw notFound('Aporte');
  res.json({ ok: true });
});
