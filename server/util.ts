import type { Request, Response, NextFunction } from 'express';
import { z, type ZodTypeAny } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'Recurso') => new HttpError(404, `${what} no encontrado`);

/** Valida el cuerpo con Zod; lanza 400 con detalle legible si falla. */
export function validate<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`);
    throw new HttpError(400, `Datos inválidos: ${issues.join('; ')}`, parsed.error.issues);
  }
  return parsed.data;
}

/** Parsea un parámetro de ruta como entero positivo; 400 si no lo es. */
export function parseId(raw: string | undefined, name = 'id'): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Parámetro ${name} inválido`);
  return n;
}

/** Fecha local de hoy como 'YYYY-MM-DD' (zona horaria del servidor). */
export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Lee ?year=&month= de la query; por defecto el mes actual. month=0 significa "todo el año". */
export function yearMonth(q: Request['query']): { year: number; month: number } {
  const now = new Date();
  const year = q.year !== undefined && q.year !== '' ? Number(q.year) : now.getFullYear();
  const month = q.month !== undefined && q.month !== '' ? Number(q.month) : now.getMonth() + 1;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HttpError(400, 'year inválido');
  if (!Number.isInteger(month) || month < 0 || month > 12) throw new HttpError(400, 'month inválido');
  return { year, month };
}

/** Rango [desde, hasta) para un año/mes. month=0 => todo el año. */
export function monthRange(year: number, month: number): { from: string; to: string } {
  if (month === 0) return { from: `${year}-01-01`, to: `${year + 1}-01-01` };
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const ny = month === 12 ? year + 1 : year;
  const nm = month === 12 ? 1 : month + 1;
  const to = `${ny}-${String(nm).padStart(2, '0')}-01`;
  return { from, to };
}

// Esquemas Zod reutilizables
/** true si 'YYYY-MM-DD' es una fecha real del calendario (rechaza 2026-02-30, mes 13, etc.). */
export function isRealDate(s: string): boolean {
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d || y < 1900 || y > 2200) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export const zDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato de fecha esperado: YYYY-MM-DD')
  .refine(isRealDate, 'Fecha inválida');
export const zMoney = z.number().finite().min(0.01, 'Debe ser mayor a 0').max(999_999_999_999, 'Monto demasiado grande');
export const zMoneyNonNeg = z.number().finite().min(0).max(999_999_999_999);
export const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color hex esperado (#rrggbb)');
export const zName = z.string().trim().min(1, 'Requerido').max(80, 'Máximo 80 caracteres');
export const zNote = z.string().trim().max(300, 'Máximo 300 caracteres');
export const zTxType = z.enum(['income', 'expense']);

/** Cuenta grafemas (un emoji compuesto como 👨‍👩‍👧 cuenta como 1). */
export function graphemeCount(s: string): number {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)).length;
  }
  return Array.from(s).length;
}

/** Icono opcional: hasta 4 grafemas (máx. 32 unidades UTF-16); '' se guarda como null. */
export const zIcon = z
  .string()
  .trim()
  .max(32, 'Icono demasiado largo')
  .refine((s) => graphemeCount(s) <= 4, 'El icono admite máximo 4 caracteres')
  .nullable()
  .optional()
  // undefined = no se envió (en PUT conserva el valor); '' o null = sin icono.
  .transform((s) => (s === undefined ? undefined : s ? s : null));

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Middleware final de errores: JSON consistente y log en servidor. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // La API rápida (Atajos de iPhone) muestra "message" en la notificación: se agrega a cualquier error de /api/quick.
  if (req.originalUrl?.startsWith('/api/quick')) {
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (body && typeof body === 'object' && 'error' in body && !('message' in body)) {
        return json({ ok: false, message: String((body as { error: unknown }).error), ...(body as object) });
      }
      return json(body);
    };
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  // Errores de JSON malformado del body-parser
  if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'JSON inválido' });
    return;
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23505') {
    res.status(409).json({ error: 'Ya existe un registro con esos datos' });
    return;
  }
  if (pgCode === '23503') {
    res.status(400).json({ error: 'Referencia inválida (el registro relacionado no existe)' });
    return;
  }
  if (pgCode === '23514') {
    res.status(400).json({ error: 'Los datos no cumplen las restricciones (revisa montos y fechas)' });
    return;
  }
  console.error('[api] error no controlado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
}
