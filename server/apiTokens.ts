/**
 * Tokens de API para registrar desde fuera de la web (Atajos de iPhone / Siri / widgets).
 * Contrato: sección "Registro rápido desde fuera de la web" de shared/types.ts.
 *
 *  - Formato: 'fin_' + 32 bytes aleatorios en base64url (43 caracteres). Se muestra UNA sola vez al crearlo.
 *  - En la base solo se guarda el SHA-256 (hex) en api_tokens.token_hash y los primeros 12 caracteres (prefix).
 *  - quickAuth protege SOLO /api/quick (montado así en server/index.ts): requireAuth nunca acepta tokens.
 */
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { one, query } from './db.js';
import { isAuthenticated } from './auth.js';

export const TOKEN_PREFIX = 'fin_';
export const TOKEN_PREFIX_LENGTH = 12;
export const MAX_TOKENS = 10;

/** Token con el formato que genera generateToken() (evita consultar la BD con basura). */
const TOKEN_RE = /^fin_[A-Za-z0-9_-]{43}$/;
/** last_used_at se actualiza como máximo una vez por minuto por token. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Token nuevo: valor completo (solo para mostrarlo una vez), prefijo visible y hash a guardar. */
export function generateToken(): { token: string; prefix: string; hash: string } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, prefix: token.slice(0, TOKEN_PREFIX_LENGTH), hash: hashToken(token) };
}

// id de token -> última vez (ms) que se mandó a actualizar last_used_at desde este proceso
const lastTouch = new Map<number, number>();

/** Actualiza last_used_at sin bloquear la petición (y sin repetir antes de un minuto). */
function touchToken(id: number): void {
  const now = Date.now();
  const prev = lastTouch.get(id) ?? 0;
  if (now - prev < TOUCH_INTERVAL_MS) return;
  lastTouch.set(id, now);
  if (lastTouch.size > 1000) {
    for (const [k, v] of lastTouch) if (now - v > TOUCH_INTERVAL_MS) lastTouch.delete(k);
  }
  query(
    `UPDATE api_tokens SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [id],
  ).catch((err: unknown) => {
    console.error('[tokens] no se pudo actualizar last_used_at:', (err as Error)?.message ?? err);
  });
}

/**
 * Devuelve el token de "Authorization: Bearer <token>" ('' si viene vacío) o null si no hay token en la cabecera.
 * Tolera errores comunes al armar el Atajo: "Bearer Bearer <token>" y el token pegado sin "Bearer".
 */
function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const m = /^\s*Bearer(?:\s+(.*))?$/i.exec(header);
  if (m) return (m[1] ?? '').replace(/^(?:Bearer(?:\s+|$))+/i, '').trim();
  const raw = header.trim();
  return raw.startsWith(TOKEN_PREFIX) ? raw : null;
}

const MSG_NO_TOKEN = 'No autorizado: falta el token. En el Atajo agrega el encabezado Authorization con «Bearer» y tu token.';
const MSG_BAD_TOKEN = 'Token inválido o revocado: cópialo completo o crea uno nuevo en la web (sección iPhone).';

function deny(res: Response, message: string): void {
  // `error` es el formato general de la API; ok/message permiten que el Atajo muestre la notificación tal cual.
  res.status(401).json({ ok: false, message, error: message });
}

/**
 * Autenticación de /api/quick:
 *  - Con "Authorization: Bearer <token>": el token debe existir (búsqueda por hash exacto); si no, 401 (token inválido).
 *  - Sin cabecera Bearer: sesión normal (si la app no tiene contraseña queda abierta, igual que el resto de /api).
 */
export async function quickAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearerToken(req);
    if (token !== null) {
      if (!TOKEN_RE.test(token)) return deny(res, token ? MSG_BAD_TOKEN : MSG_NO_TOKEN);
      const row = await one<{ id: number }>('SELECT id FROM api_tokens WHERE token_hash = $1', [hashToken(token)]);
      if (!row) return deny(res, MSG_BAD_TOKEN);
      // routes/quick.ts usa esta marca: solo con token se aceptan cuerpos de formulario.
      res.locals.apiTokenId = row.id;
      touchToken(row.id);
      return next();
    }
    if (await isAuthenticated(req)) return next();
    deny(res, MSG_NO_TOKEN);
  } catch (err) {
    next(err);
  }
}
