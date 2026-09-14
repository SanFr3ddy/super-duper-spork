/**
 * Registro automático de cargos recurrentes vencidos (ver reglas en shared/types.ts y calendario en server/recurring.ts).
 *
 * Idempotente y seguro ante ejecuciones simultáneas:
 *  - Cada cargo se procesa en su propia transacción con SELECT ... FOR UPDATE (bloquea la fila del cargo).
 *  - Las transacciones generadas usan ON CONFLICT (recurring_id, date) DO NOTHING (índice único parcial).
 *  - last_posted_date avanza a la última ocurrencia registrada, así borrar un movimiento no lo recrea.
 */
import type { Request, Response, NextFunction } from 'express';
import { pool, query } from './db.js';
import { todayISO } from './util.js';
import { occurrencesBetween, type ScheduleRule } from './recurring.js';

type RuleRow = ScheduleRule & {
  id: number;
  name: string;
  type: 'income' | 'expense';
  amount: number;
  category_id: number | null;
  account_id: number | null;
  credit_card_id: number | null;
  last_posted_date: string | null;
};

const MAX_PER_RULE = 400;

/** Registra las ocurrencias vencidas de un cargo. Devuelve cuántos movimientos creó. */
export async function postRule(id: number, today = todayISO()): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<RuleRow>(
      `SELECT id, name, type, amount, category_id, account_id, credit_card_id, frequency, interval_n, day_of_month,
              weekday, month_of_year, start_date, end_date, last_posted_date
         FROM recurring_charges
        WHERE id = $1 AND active AND auto_post
        FOR UPDATE`,
      [id],
    );
    const rule = rows[0];
    if (!rule) {
      await client.query('ROLLBACK');
      return 0;
    }
    const dates = occurrencesBetween(rule, rule.last_posted_date, today, MAX_PER_RULE);
    let created = 0;
    const isCard = rule.type === 'expense' && rule.credit_card_id !== null;
    for (const date of dates) {
      const r = await client.query(
        `INSERT INTO transactions (type, amount, category_id, description, date, credit_card_id, account_id, installments, recurring_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)
         ON CONFLICT (recurring_id, date) WHERE recurring_id IS NOT NULL DO NOTHING`,
        [rule.type, rule.amount, rule.category_id, rule.name, date, isCard ? rule.credit_card_id : null, isCard ? null : rule.account_id, rule.id],
      );
      created += r.rowCount ?? 0;
    }
    if (dates.length > 0) {
      await client.query('UPDATE recurring_charges SET last_posted_date = $2 WHERE id = $1', [rule.id, dates[dates.length - 1]]);
    }
    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Registra todos los cargos vencidos. Devuelve el total de movimientos creados. */
export async function postDueRecurring(today = todayISO()): Promise<number> {
  const due = await query<{ id: number }>(
    `SELECT id FROM recurring_charges
      WHERE active AND auto_post AND start_date <= $1::date
        AND (end_date IS NULL OR last_posted_date IS NULL OR last_posted_date < end_date)
        AND (last_posted_date IS NULL OR last_posted_date < $1::date)
      ORDER BY id`,
    [today],
  );
  let total = 0;
  for (const { id } of due) total += await postRule(id, today);
  return total;
}

// ---------------------------------------------------------------------------
// Disparadores: al arrancar, cada hora mientras el servidor está despierto y, como máximo cada 5 minutos,
// antes de atender peticiones con sesión (así Render se pone al día después de dormir).
// ---------------------------------------------------------------------------
const THROTTLE_MS = 5 * 60 * 1000;
let lastRunAt = 0;
let lastRunDay = '';
let inFlight: Promise<number> | null = null;

export function runRecurringNow(): Promise<number> {
  if (inFlight) return inFlight;
  inFlight = postDueRecurring()
    .then((n) => {
      lastRunAt = Date.now();
      lastRunDay = todayISO();
      if (n > 0) console.log(`[recurring] ${n} cargo(s) recurrente(s) registrado(s)`);
      return n;
    })
    .catch((err) => {
      console.error('[recurring] error al registrar cargos:', err);
      return 0;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Middleware (después de requireAuth): registra cargos vencidos si pasó el intervalo o cambió el día. */
export async function autoPostRecurring(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (Date.now() - lastRunAt > THROTTLE_MS || lastRunDay !== todayISO()) await runRecurringNow();
  next();
}

export function startRecurringTimer(): void {
  void runRecurringNow();
  setInterval(() => void runRecurringNow(), 60 * 60 * 1000).unref();
}
