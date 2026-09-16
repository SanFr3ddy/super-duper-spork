/**
 * Tareas diarias automáticas: cargos recurrentes vencidos y abono diario de rendimientos.
 * Se ejecutan al arrancar, cada hora mientras el servidor está despierto y, como máximo cada 5 minutos,
 * antes de atender peticiones con sesión (así Render se pone al día después de dormir).
 */
import type { Request, Response, NextFunction } from 'express';
import { todayISO } from './util.js';
import { postDueRecurring } from './recurringPost.js';
import { accrueDailyYields } from './yieldAccrual.js';

const THROTTLE_MS = 5 * 60 * 1000;
let lastRunAt = 0;
let lastRunDay = '';
let inFlight: Promise<void> | null = null;

export function runDailyJobs(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const posted = await postDueRecurring();
      if (posted > 0) console.log(`[jobs] ${posted} cargo(s) recurrente(s) registrado(s)`);
    } catch (err) {
      console.error('[jobs] error en cargos recurrentes:', err);
    }
    try {
      const accrued = await accrueDailyYields();
      if (accrued > 0) console.log(`[jobs] ${accrued} abono(s) diario(s) de rendimiento`);
    } catch (err) {
      console.error('[jobs] error en rendimientos diarios:', err);
    }
    lastRunAt = Date.now();
    lastRunDay = todayISO();
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Middleware (después de requireAuth): ejecuta las tareas si pasó el intervalo o cambió el día. */
export async function autoDailyJobs(_req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (Date.now() - lastRunAt > THROTTLE_MS || lastRunDay !== todayISO()) await runDailyJobs();
  next();
}

export function startDailyJobsTimer(): void {
  void runDailyJobs();
  setInterval(() => void runDailyJobs(), 60 * 60 * 1000).unref();
}
