import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { one, query } from './db.js';
import type { AuthStatus } from '../shared/types.js';

/**
 * Autenticación de un solo usuario por contraseña.
 *  - APP_PASSWORD vacío  => la app queda abierta (útil en local).
 *  - APP_PASSWORD puesto => /api/* exige una sesión válida.
 *
 * Sesiones: cada login crea un id aleatorio guardado en la tabla `sessions` (con expiración) y la cookie
 * lleva `id.firma`, donde la firma es HMAC(SESSION_SECRET, id + APP_PASSWORD). Así:
 *  - cerrar sesión borra la fila y la cookie copiada deja de servir;
 *  - las sesiones caducan en el servidor a los 30 días;
 *  - cambiar APP_PASSWORD o SESSION_SECRET invalida todas las cookies.
 */
const APP_PASSWORD = (process.env.APP_PASSWORD ?? '').trim();
const SESSION_SECRET = (process.env.SESSION_SECRET ?? '').trim() || crypto.randomBytes(32).toString('hex');
const IS_PROD = process.env.NODE_ENV === 'production';

if (APP_PASSWORD && !(process.env.SESSION_SECRET ?? '').trim()) {
  console.warn('[auth] SESSION_SECRET no definido: las sesiones se invalidarán en cada reinicio.');
}
if (!APP_PASSWORD && IS_PROD) {
  console.warn('[auth] APP_PASSWORD vacío en producción: la app está abierta a cualquiera con la URL.');
}

export const authRequired = APP_PASSWORD.length > 0;
export const COOKIE_NAME = 'fin_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 días
const CACHE_TTL_MS = 60 * 1000; // evita consultar la BD en cada petición

function sign(sid: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`${sid}.${APP_PASSWORD}`).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Devuelve el id de sesión si la cookie tiene formato y firma válidos (sin consultar la BD). */
function sidFromCookie(req: Request): string | null {
  const raw = (req.cookies as Record<string, string | undefined> | undefined)?.[COOKIE_NAME];
  if (!raw) return null;
  const [sid, sig] = raw.split('.');
  if (!sid || !sig || !/^[a-f0-9]{48}$/.test(sid)) return null;
  return safeEqual(sig, sign(sid)) ? sid : null;
}

// sid -> hasta cuándo se confía en el resultado de la BD
const validCache = new Map<string, number>();

async function sessionIsValid(sid: string): Promise<boolean> {
  const now = Date.now();
  const cached = validCache.get(sid);
  if (cached && cached > now) return true;
  const row = await one<{ sid: string }>('SELECT sid FROM sessions WHERE sid = $1 AND expires_at > now()', [sid]);
  if (!row) {
    validCache.delete(sid);
    return false;
  }
  validCache.set(sid, now + CACHE_TTL_MS);
  return true;
}

export async function isAuthenticated(req: Request): Promise<boolean> {
  if (!authRequired) return true;
  const sid = sidFromCookie(req);
  return sid ? sessionIsValid(sid) : false;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await isAuthenticated(req)) return next();
  res.status(401).json({ error: 'No autorizado' });
}

// Límite de intentos por IP: 8 fallos dentro de 15 minutos => bloqueo de 15 minutos.
const attempts = new Map<string, { count: number; firstAt: number; blockedUntil: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;
const BLOCK_MS = 15 * 60 * 1000;

function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

export const authRouter = Router();

authRouter.get('/status', async (req, res) => {
  const body: AuthStatus = { required: authRequired, authenticated: await isAuthenticated(req) };
  res.json(body);
});

authRouter.post('/login', async (req, res) => {
  if (!authRequired) {
    res.json({ ok: true });
    return;
  }
  const ip = clientIp(req);
  const now = Date.now();
  let rec = attempts.get(ip);
  if (rec && rec.blockedUntil > now) {
    const mins = Math.ceil((rec.blockedUntil - now) / 60000);
    res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${mins} min.` });
    return;
  }
  // Bloqueo vencido o ventana expirada: se empieza a contar de nuevo.
  if (rec && (rec.blockedUntil > 0 || now - rec.firstAt > WINDOW_MS)) rec = undefined;

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!safeEqual(password, APP_PASSWORD)) {
    const count = (rec?.count ?? 0) + 1;
    attempts.set(ip, { count, firstAt: rec?.firstAt ?? now, blockedUntil: count >= MAX_ATTEMPTS ? now + BLOCK_MS : 0 });
    // Limpieza ocasional del mapa para que no crezca sin límite.
    if (attempts.size > 5000) {
      for (const [k, v] of attempts) if (v.blockedUntil < now && now - v.firstAt > WINDOW_MS) attempts.delete(k);
    }
    res.status(401).json({ error: count >= MAX_ATTEMPTS ? 'Contraseña incorrecta. Demasiados intentos: espera 15 min.' : 'Contraseña incorrecta' });
    return;
  }

  attempts.delete(ip);
  const sid = crypto.randomBytes(24).toString('hex');
  await query("DELETE FROM sessions WHERE expires_at <= now()");
  await query('INSERT INTO sessions (sid, expires_at) VALUES ($1, $2)', [sid, new Date(now + SESSION_TTL_MS)]);
  res.cookie(COOKIE_NAME, `${sid}.${sign(sid)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  const sid = sidFromCookie(req);
  if (sid) {
    validCache.delete(sid);
    await query('DELETE FROM sessions WHERE sid = $1', [sid]);
  }
  res.clearCookie(COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax', secure: IS_PROD });
  res.json({ ok: true });
});
