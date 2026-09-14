/**
 * Cargos recurrentes: CRUD, próximos cargos y registro manual de vencidos (ver shared/types.ts).
 * Calendario: server/recurring.ts. Registro automático: server/recurringPost.ts. Lectura: server/recurringData.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { one, withTransaction, type Row } from '../db.js';
import { validate, parseId, HttpError, notFound, round2, todayISO, zColor, zDate, zMoney, zName, zTxType } from '../util.js';
import { lastOccurrenceBefore, occurrencesBetween, type ScheduleRule } from '../recurring.js';
import { postDueRecurring, postRule } from '../recurringPost.js';
import { loadRecurring, recurringOverview, upcomingCharges } from '../recurringData.js';
import type { RecurringCharge, RecurringFrequency, TxType } from '../../shared/types.js';

export const recurringRouter = Router();

const DEFAULT_COLOR = '#e5202e';

// ---------------------------------------------------------------------------
// Validación
// ---------------------------------------------------------------------------
const zOptId = (label: string) =>
  z.number({ invalid_type_error: `${label}: debe ser un id numérico` }).int(`${label}: debe ser un entero`).positive(`${label}: id inválido`).nullable().optional();
const zInt = (label: string, min: number, max: number) =>
  z
    .number({ invalid_type_error: `${label}: debe ser un número` })
    .int(`${label}: debe ser un entero`)
    .min(min, `${label}: mínimo ${min}`)
    .max(max, `${label}: máximo ${max}`);

const baseSchema = z.object({
  name: zName,
  type: zTxType.optional(),
  amount: zMoney,
  category_id: zOptId('Categoría'),
  account_id: zOptId('Cuenta'),
  credit_card_id: zOptId('Tarjeta'),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly'], { errorMap: () => ({ message: 'Frecuencia inválida (daily, weekly, monthly o yearly)' }) }),
  interval_n: zInt('Intervalo', 1, 365).optional(),
  day_of_month: zInt('Día del mes', 1, 31).nullable().optional(),
  weekday: zInt('Día de la semana', 0, 6).nullable().optional(),
  month_of_year: zInt('Mes', 1, 12).nullable().optional(),
  start_date: zDate.optional(),
  end_date: zDate.nullable().optional(),
  active: z.boolean().optional(),
  auto_post: z.boolean().optional(),
  color: zColor.optional(),
});
const createSchema = baseSchema.extend({ backfill: z.boolean().optional() });
const updateSchema = baseSchema.partial();

type UpdateData = z.infer<typeof updateSchema>;

interface ChargeValues extends ScheduleRule {
  name: string;
  type: TxType;
  amount: number;
  category_id: number | null;
  account_id: number | null;
  credit_card_id: number | null;
  active: boolean;
  auto_post: boolean;
  color: string;
}

const MAX_DAY_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

// end_date incluido: extender la fecha de fin de un cargo ya terminado no debe registrar los cargos del hueco.
const SCHEDULE_KEYS = ['frequency', 'interval_n', 'day_of_month', 'weekday', 'month_of_year', 'start_date', 'end_date'] as const;

/** Máximo de cargos pasados que se registran al crear con backfill (shared/types.ts). */
const MAX_BACKFILL = 400;

/** Consulta de una fila; en PUT usa el cliente de la transacción para no pedir otra conexión con la fila bloqueada. */
type OneFn = <T extends Row>(text: string, params: unknown[]) => Promise<T | null>;
const poolOne: OneFn = (text, params) => one(text, params);
const clientOne =
  (client: PoolClient): OneFn =>
  async <T extends Row>(text: string, params: unknown[]) =>
    ((await client.query(text, params)).rows[0] as T | undefined) ?? null;

/** Reglas de coherencia de la regla y la forma de pago; verifica referencias. Devuelve los valores definitivos. */
async function normalize(v: ChargeValues, lookup: OneFn = poolOne): Promise<ChargeValues> {
  const out: ChargeValues = { ...v, amount: round2(v.amount), interval_n: Math.max(1, Math.floor(v.interval_n || 1)) };

  switch (out.frequency) {
    case 'daily':
      out.day_of_month = null;
      out.weekday = null;
      out.month_of_year = null;
      break;
    case 'weekly':
      if (out.weekday === null) throw new HttpError(400, 'Para un cargo semanal indica el día de la semana (weekday 0 = domingo … 6 = sábado)');
      out.day_of_month = null;
      out.month_of_year = null;
      break;
    case 'monthly':
      if (out.day_of_month === null) throw new HttpError(400, 'Para un cargo mensual indica el día del mes (day_of_month 1..31)');
      out.weekday = null;
      out.month_of_year = null;
      break;
    case 'yearly':
      if (out.day_of_month === null || out.month_of_year === null) {
        throw new HttpError(400, 'Para un cargo anual indica el día (day_of_month 1..31) y el mes (month_of_year 1..12)');
      }
      // Mes fijo: el día debe existir en ese mes (29 de febrero se permite y cae el 28 en años no bisiestos).
      if (out.day_of_month > MAX_DAY_IN_MONTH[out.month_of_year - 1]) {
        throw new HttpError(400, `${MONTH_NAMES[out.month_of_year - 1]} no tiene día ${out.day_of_month}: elige un día válido para ese mes`);
      }
      out.weekday = null;
      break;
  }

  if (out.end_date !== null && out.end_date < out.start_date) {
    throw new HttpError(400, 'La fecha de fin no puede ser anterior a la fecha de inicio');
  }

  if (out.category_id !== null) {
    const cat = await lookup<{ type: TxType }>('SELECT type FROM categories WHERE id = $1', [out.category_id]);
    if (!cat) throw new HttpError(400, 'La categoría no existe');
    if (cat.type !== out.type) throw new HttpError(400, 'La categoría no corresponde al tipo (ingreso o gasto) del cargo');
  }
  if (out.credit_card_id !== null) {
    if (out.type !== 'expense') throw new HttpError(400, 'Solo los gastos pueden pagarse con tarjeta de crédito');
    const card = await lookup<{ id: number }>('SELECT id FROM credit_cards WHERE id = $1', [out.credit_card_id]);
    if (!card) throw new HttpError(400, 'La tarjeta de crédito no existe');
    out.account_id = null;
  }
  if (out.account_id !== null) {
    const acc = await lookup<{ id: number }>('SELECT id FROM accounts WHERE id = $1', [out.account_id]);
    if (!acc) throw new HttpError(400, 'La cuenta no existe');
  }
  return out;
}

const laterDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

async function loadCharge(id: number): Promise<RecurringCharge> {
  const [item] = await loadRecurring({ id });
  if (!item) throw notFound('Cargo recurrente');
  return item;
}

/** Registra lo vencido de un cargo; si falla, el temporizador lo reintenta (el cargo ya quedó guardado). */
async function postSafely(id: number): Promise<void> {
  try {
    await postRule(id);
  } catch (err) {
    console.error(`[recurring] no se pudo registrar el cargo ${id}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Rutas (las fijas antes de /:id)
// ---------------------------------------------------------------------------
recurringRouter.get('/', async (_req, res) => {
  res.json(await recurringOverview());
});

recurringRouter.get('/upcoming', async (req, res) => {
  const raw = Array.isArray(req.query.days) ? req.query.days[0] : req.query.days;
  const days = raw === undefined || raw === '' ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new HttpError(400, 'days debe ser un entero entre 1 y 366');
  const today = todayISO();
  res.json(upcomingCharges(await loadRecurring({ today }), days, today));
});

recurringRouter.post('/run', async (_req, res) => {
  const posted = await postDueRecurring();
  res.json({ posted });
});

recurringRouter.post('/', async (req, res) => {
  const data = validate(createSchema, req.body);
  const today = todayISO();
  const v = await normalize({
    name: data.name,
    type: data.type ?? 'expense',
    amount: data.amount,
    category_id: data.category_id ?? null,
    account_id: data.account_id ?? null,
    credit_card_id: data.credit_card_id ?? null,
    frequency: data.frequency as RecurringFrequency,
    interval_n: data.interval_n ?? 1,
    day_of_month: data.day_of_month ?? null,
    weekday: data.weekday ?? null,
    month_of_year: data.month_of_year ?? null,
    start_date: data.start_date ?? today,
    end_date: data.end_date ?? null,
    active: data.active ?? true,
    auto_post: data.auto_post ?? true,
    color: data.color ?? DEFAULT_COLOR,
  });
  // Sin backfill no se registran cargos anteriores a hoy (el de hoy sí).
  const lastPosted = data.backfill ? null : lastOccurrenceBefore(v, today);
  // Con backfill se registran como máximo 400 cargos pasados; más que eso casi siempre es una fecha de inicio equivocada
  // (y recurringPost.ts seguiría registrando lotes de 400 en cada ejecución).
  if (data.backfill && occurrencesBetween(v, null, today, MAX_BACKFILL + 1).length > MAX_BACKFILL) {
    throw new HttpError(400, `Registrar desde la fecha de inicio crearía más de ${MAX_BACKFILL} movimientos: usa una fecha de inicio más reciente o desactiva el registro de cargos pasados`);
  }
  const row = await one<{ id: number }>(
    `INSERT INTO recurring_charges (name, type, amount, category_id, account_id, credit_card_id, frequency, interval_n,
       day_of_month, weekday, month_of_year, start_date, end_date, active, auto_post, last_posted_date, color)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING id`,
    [
      v.name, v.type, v.amount, v.category_id, v.account_id, v.credit_card_id, v.frequency, v.interval_n,
      v.day_of_month, v.weekday, v.month_of_year, v.start_date, v.end_date, v.active, v.auto_post, lastPosted, v.color,
    ],
  );
  if (!row) throw new HttpError(500, 'No se pudo crear el cargo recurrente');
  await postSafely(row.id);
  res.status(201).json(await loadCharge(row.id));
});

recurringRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data: UpdateData = validate(updateSchema, req.body);
  const today = todayISO();

  await withTransaction(async (client) => {
    // Bloquea la fila para no competir con el registro automático mientras se recalcula last_posted_date.
    const { rows } = await client.query<ChargeValues & { last_posted_date: string | null }>(
      `SELECT name, type, amount, category_id, account_id, credit_card_id, frequency, interval_n, day_of_month, weekday,
              month_of_year, start_date, end_date, active, auto_post, color, last_posted_date
         FROM recurring_charges WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const ex = rows[0];
    if (!ex) throw notFound('Cargo recurrente');
    const pick = <K extends keyof UpdateData & keyof ChargeValues>(key: K): ChargeValues[K] =>
      (data[key] === undefined ? ex[key] : data[key]) as ChargeValues[K];

    const v = await normalize({
      name: pick('name'),
      type: pick('type'),
      amount: pick('amount'),
      category_id: pick('category_id'),
      account_id: pick('account_id'),
      credit_card_id: pick('credit_card_id'),
      frequency: pick('frequency'),
      interval_n: pick('interval_n'),
      day_of_month: pick('day_of_month'),
      weekday: pick('weekday'),
      month_of_year: pick('month_of_year'),
      start_date: pick('start_date'),
      end_date: pick('end_date'),
      active: pick('active'),
      auto_post: pick('auto_post'),
      color: pick('color'),
    }, clientOne(client));

    // Cambiar la regla, o reanudar un cargo pausado / sin registro automático, no registra cargos pasados.
    const scheduleChanged = SCHEDULE_KEYS.some((k) => v[k] !== ex[k]);
    const resumed = (v.active && !ex.active) || (v.auto_post && !ex.auto_post);
    let lastPosted = ex.last_posted_date ?? null;
    if (scheduleChanged || resumed) lastPosted = laterDate(lastPosted, lastOccurrenceBefore(v, today));

    await client.query(
      `UPDATE recurring_charges
          SET name = $1, type = $2, amount = $3, category_id = $4, account_id = $5, credit_card_id = $6, frequency = $7,
              interval_n = $8, day_of_month = $9, weekday = $10, month_of_year = $11, start_date = $12, end_date = $13,
              active = $14, auto_post = $15, color = $16, last_posted_date = $17
        WHERE id = $18`,
      [
        v.name, v.type, v.amount, v.category_id, v.account_id, v.credit_card_id, v.frequency, v.interval_n,
        v.day_of_month, v.weekday, v.month_of_year, v.start_date, v.end_date, v.active, v.auto_post, v.color, lastPosted, id,
      ],
    );
  });

  await postSafely(id);
  res.json(await loadCharge(id));
});

recurringRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  // Los movimientos ya registrados se conservan con recurring_id NULL (FK ON DELETE SET NULL).
  const deleted = await one<{ id: number }>('DELETE FROM recurring_charges WHERE id = $1 RETURNING id', [id]);
  if (!deleted) throw notFound('Cargo recurrente');
  res.json({ ok: true });
});
