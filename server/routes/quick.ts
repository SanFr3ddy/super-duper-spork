/**
 * API rápida para Atajos de iPhone / Siri / widgets (autenticación en server/apiTokens.ts: token Bearer o sesión).
 * Contrato: sección "Registro rápido desde fuera de la web" de shared/types.ts.
 *
 *  GET  /options      -> QuickOptions (nombres para los menús del Atajo)
 *  POST /transaction  QuickTransactionInput -> QuickResult (201)
 *  GET  /summary      -> QuickResult
 *
 * Todos los errores de estas rutas responden { ok: false, message, error } para que el Atajo muestre el texto.
 * Los movimientos siguen las reglas de server/routes/transactions.ts: ingreso sin tarjeta, con tarjeta account_id = null,
 * y siempre en una sola exhibición (installments = 1).
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { one, query } from '../db.js';
import { accountTotals, bankLabel, loadAccounts } from '../accountsData.js';
import { addDaysISO } from '../yieldAccrual.js';
import { HttpError, isRealDate, monthRange, round2, todayISO, validate, zNote } from '../util.js';
import type { AccountKind, QuickOptions, QuickResult, TxType } from '../../shared/types.js';

export const quickRouter = Router();

const MAX_AMOUNT = 999_999_999_999;
const NO_PAYMENT = 'Sin especificar';

// Los Atajos pueden mandar el cuerpo como JSON (ya lo lee index.ts) o como "Formulario".
// El formulario solo se lee con token (res.locals.apiTokenId, ver server/apiTokens.ts): con la cookie de sesión se exige
// JSON, así un formulario HTML de otro sitio no puede registrar movimientos aprovechando la sesión abierta.
const formParser = express.urlencoded({ extended: false, limit: '100kb' });
quickRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (res.locals.apiTokenId) return formParser(req, res, next);
  next();
});

// ---------------------------------------------------------------------------
// Normalización de nombres
// ---------------------------------------------------------------------------
/** Minúsculas, sin acentos (NFD sin diacríticos), sin espacios extremos y con espacios colapsados. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Como normalizeName pero además ignora signos y emojis ("BBVA · Nómina" = "bbva nomina"). */
function looseKey(s: string): string {
  return normalizeName(s)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function money(n: number): string {
  return moneyFormat().format(round2(n) || 0);
}

let moneyFmt: Intl.NumberFormat | null = null;
function moneyFormat(): Intl.NumberFormat {
  if (!moneyFmt) {
    try {
      moneyFmt = new Intl.NumberFormat(process.env.LOCALE || 'es-MX', { style: 'currency', currency: process.env.CURRENCY || 'MXN' });
    } catch {
      moneyFmt = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
    }
  }
  return moneyFmt;
}

function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(process.env.LOCALE || 'es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(Date.UTC(y, m - 1, d)),
    );
  } catch {
    return isoDate;
  }
}

/** Recorta textos del usuario que se repiten en mensajes. */
function clip(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Catálogos: categorías, cuentas activas y tarjetas
// ---------------------------------------------------------------------------
type CategoryRow = { id: number; name: string; type: TxType };
type AccountRow = { id: number; name: string; bank: string; kind: AccountKind };
type CardRow = { id: number; name: string };

type PaymentTarget = { kind: 'account'; id: number; label: string } | { kind: 'card'; id: number; label: string };
type PaymentOption = PaymentTarget & { account?: AccountRow; card?: CardRow };

async function loadCatalogs(): Promise<{ categories: CategoryRow[]; accounts: AccountRow[]; cards: CardRow[] }> {
  const [categories, accounts, cards] = await Promise.all([
    query<CategoryRow>('SELECT id, name, type FROM categories ORDER BY lower(name), id'),
    query<AccountRow>(
      `SELECT a.id, a.name, COALESCE(b.name, a.bank, '') AS bank, a.kind
         FROM accounts a
         LEFT JOIN banks b ON b.id = a.bank_id
        WHERE a.archived = false
        ORDER BY lower(COALESCE(b.name, a.bank, '')), lower(a.name), a.id`,
    ),
    query<CardRow>('SELECT id, name FROM credit_cards ORDER BY lower(name), id'),
  ]);
  return { categories, accounts, cards };
}

/**
 * Etiquetas de forma de pago en el orden de los menús: cada cuenta activa con su nombre si es único entre las
 * cuentas activas (sin distinguir mayúsculas/acentos) o "Banco · Cuenta"; luego "Tarjeta <nombre>" por tarjeta.
 */
function paymentOptions(accounts: AccountRow[], cards: CardRow[]): PaymentOption[] {
  const nameCount = new Map<string, number>();
  for (const a of accounts) {
    const k = normalizeName(a.name);
    nameCount.set(k, (nameCount.get(k) ?? 0) + 1);
  }
  const out: PaymentOption[] = [];
  for (const a of accounts) {
    const unique = (nameCount.get(normalizeName(a.name)) ?? 0) === 1;
    out.push({ kind: 'account', id: a.id, label: unique ? a.name : `${bankLabel(a)} · ${a.name}`, account: a });
  }
  for (const c of cards) out.push({ kind: 'card', id: c.id, label: `Tarjeta ${c.name}`, card: c });
  return out;
}

/** Lista de nombres sin repetir (sin distinguir mayúsculas/acentos), conservando el orden. */
function uniqueLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of labels) {
    const k = normalizeName(l);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out;
}

function optionsText(options: PaymentOption[]): string {
  const labels = uniqueLabels([NO_PAYMENT, ...options.map((o) => o.label)]);
  const shown = labels.slice(0, 20);
  return shown.join(', ') + (labels.length > shown.length ? ', …' : '');
}

/** Devuelve el único candidato, null si no hay, o 400 si hay varios. */
function pickOne(input: string, candidates: PaymentOption[]): PaymentTarget | null {
  const byId = new Map<string, PaymentOption>();
  for (const c of candidates) byId.set(`${c.kind}-${c.id}`, c);
  const list = [...byId.values()];
  if (list.length === 0) return null;
  if (list.length === 1) return { kind: list[0].kind, id: list[0].id, label: list[0].label };
  const labels = uniqueLabels(list.map((c) => c.label));
  if (labels.length === 1) {
    throw new HttpError(400, `Hay varias formas de pago llamadas «${labels[0]}». Cambia el nombre de una en la web para distinguirlas.`);
  }
  throw new HttpError(400, `«${clip(input)}» coincide con varias formas de pago: ${labels.join(', ')}. Usa una de estas.`);
}

/**
 * Resuelve el texto de forma de pago:
 *  1. "" o "Sin especificar" => sin forma de pago.
 *  2. Etiqueta exacta de /options (sin distinguir mayúsculas/acentos; luego ignorando signos).
 *  3. "Tarjeta X" explícito.
 *  4. Coincidencia aproximada: nombre de tarjeta, nombre de cuenta, "Banco Cuenta" o solo el banco. Se evalúan juntas:
 *     si apuntan a formas de pago distintas (p. ej. «Nu» = tarjeta Nu y la cuenta del banco Nu) responde 400 con las
 *     opciones, para no cargar un gasto a la tarjeta cuando salió de la cuenta (o al revés).
 */
function resolvePayment(input: string, accounts: AccountRow[], cards: CardRow[]): PaymentTarget | null {
  const n = normalizeName(input);
  if (!n || n === normalizeName(NO_PAYMENT)) return null;
  const options = paymentOptions(accounts, cards);
  const k = looseKey(input);
  const notFoundError = () => new HttpError(400, `No encontré la forma de pago «${clip(input)}». Opciones: ${optionsText(options)}`);

  const exact = pickOne(input, options.filter((o) => normalizeName(o.label) === n));
  if (exact) return exact;
  if (!k) throw notFoundError();

  const loose = pickOne(input, options.filter((o) => looseKey(o.label) === k));
  if (loose) return loose;

  if (k.startsWith('tarjeta ')) {
    const rest = k.slice('tarjeta '.length);
    const card = pickOne(input, options.filter((o) => !!o.card && looseKey(o.card.name) === rest));
    if (card) return card;
  }

  const fuzzy = options.filter((o) => {
    if (o.card) return looseKey(o.card.name) === k;
    if (!o.account) return false;
    const bank = bankLabel(o.account);
    return looseKey(o.account.name) === k || looseKey(`${bank} ${o.account.name}`) === k || looseKey(bank) === k;
  });
  const found = pickOne(input, fuzzy);
  if (found) return found;
  throw notFoundError();
}

// ---------------------------------------------------------------------------
// Lectura de campos del Atajo
// ---------------------------------------------------------------------------
/** Texto opcional: acepta string o número; null/undefined => ''. */
const zText = (max: number, label: string) =>
  z
    .union([z.string(), z.number()])
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .refine((s) => s.length <= max, `${label}: máximo ${max} caracteres`);

const quickSchema = z.object({
  type: zText(20, 'Tipo'),
  amount: z.unknown(),
  description: z
    .union([z.string(), z.number()])
    .nullable()
    .optional()
    .transform((v) => (v === null || v === undefined ? '' : String(v))),
  category: zText(200, 'Categoría'),
  payment: zText(200, 'Forma de pago'),
  date: zText(40, 'Fecha'),
});

function parseType(raw: string): TxType {
  const n = normalizeName(raw);
  if (!n || n === 'gasto' || n === 'gastos' || n === 'expense') return 'expense';
  if (n === 'ingreso' || n === 'ingresos' || n === 'income') return 'income';
  throw new HttpError(400, `Tipo «${clip(raw, 20)}» no válido: usa gasto o ingreso.`);
}

/**
 * Monto como número o texto: quita "$", espacios y separadores de miles ("$1,250.50" => 1250.5).
 * Si solo hay una coma seguida de 1-2 dígitos se toma como decimal ("150,50" => 150.5), para teclados que usan coma.
 */
export function parseAmount(raw: unknown): number {
  let n: number;
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'string') {
    let s = raw.replace(/[\s\u00a0\u202f$]/g, '').replace(/^(mxn|usd)|(mxn|usd)$/gi, '');
    if (!s) throw new HttpError(400, 'Falta el monto.');
    if (s.startsWith('-')) throw new HttpError(400, 'El monto debe ser mayor a 0.');
    if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) s = s.replace(/,/g, '');
    else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d*,\d{1,2}$/.test(s)) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) {
      throw new HttpError(400, `Monto inválido: «${clip(raw.trim(), 30)}». Escribe solo el número, por ejemplo 150.50.`);
    }
    n = Number(s);
  } else if (raw === null || raw === undefined) {
    throw new HttpError(400, 'Falta el monto.');
  } else {
    throw new HttpError(400, 'Monto inválido: envía un número, por ejemplo 150.50.');
  }
  if (!Number.isFinite(n)) throw new HttpError(400, 'Monto inválido.');
  const v = round2(n);
  if (!(v > 0)) throw new HttpError(400, 'El monto debe ser mayor a 0.');
  if (v > MAX_AMOUNT) throw new HttpError(400, 'El monto es demasiado grande.');
  return v;
}

/** Fecha 'YYYY-MM-DD' (también acepta una fecha ISO con hora y toma el día); vacía => hoy. */
function parseDate(raw: string): string {
  if (!raw) return todayISO();
  const s = /^\d{4}-\d{2}-\d{2}T/.test(raw) ? raw.slice(0, 10) : raw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new HttpError(400, `Fecha «${clip(raw, 30)}» no válida: usa el formato AAAA-MM-DD.`);
  if (!isRealDate(s)) throw new HttpError(400, `La fecha ${s} no existe.`);
  return s;
}

// ---------------------------------------------------------------------------
// Rutas
// ---------------------------------------------------------------------------
// GET /api/quick/options
quickRouter.get('/options', async (_req, res) => {
  const { categories, accounts, cards } = await loadCatalogs();
  const names = (type: TxType): string[] => uniqueLabels(categories.filter((c) => c.type === type).map((c) => c.name));
  const body: QuickOptions = {
    categories_expense: names('expense'),
    categories_income: names('income'),
    payments: uniqueLabels([NO_PAYMENT, ...paymentOptions(accounts, cards).map((o) => o.label)]),
  };
  res.json(body);
});

// POST /api/quick/transaction
quickRouter.post('/transaction', async (req, res) => {
  const data = validate(quickSchema, req.body ?? {});
  const type = parseType(data.type);
  const amount = parseAmount(data.amount);
  const date = parseDate(data.date);
  const note = zNote.safeParse(data.description);
  if (!note.success) throw new HttpError(400, 'La descripción admite máximo 300 caracteres.');
  const description = note.data;

  const { categories, accounts, cards } = await loadCatalogs();

  let categoryId: number | null = null;
  let categoryName: string | null = null;
  let categoryMissing: string | null = null;
  if (data.category) {
    const ofType = categories.filter((c) => c.type === type);
    const n = normalizeName(data.category);
    const k = looseKey(data.category);
    const found = ofType.find((c) => normalizeName(c.name) === n) ?? (k ? ofType.find((c) => looseKey(c.name) === k) : undefined);
    if (found) {
      categoryId = found.id;
      categoryName = found.name;
    } else {
      categoryMissing = data.category;
    }
  }

  const payment = resolvePayment(data.payment, accounts, cards);
  if (payment?.kind === 'card' && type === 'income') {
    throw new HttpError(400, `Un ingreso no puede registrarse en ${payment.label}. Elige una cuenta o «${NO_PAYMENT}».`);
  }
  const creditCardId = payment?.kind === 'card' ? payment.id : null;
  const accountId = payment?.kind === 'account' ? payment.id : null;

  const row = await one<{ id: number }>(
    `INSERT INTO transactions (type, amount, category_id, description, date, credit_card_id, account_id, installments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1) RETURNING id`,
    [type, amount, categoryId, description, date, creditCardId, accountId],
  );
  const transactionId = row!.id;

  let balance: number | null = null;
  let tail = '';
  if (payment?.kind === 'account') {
    const [acc] = await loadAccounts({ id: payment.id });
    balance = acc ? acc.balance : null;
  } else if (payment?.kind === 'card') {
    const debt = await one<{ debt: number }>(
      `SELECT COALESCE((SELECT SUM(amount) FROM transactions WHERE type = 'expense' AND credit_card_id = $1), 0)
            - COALESCE((SELECT SUM(amount) FROM card_payments WHERE credit_card_id = $1), 0) AS debt`,
      [payment.id],
    );
    tail = ` · deuda: ${money(Math.max(0, round2(Number(debt?.debt) || 0)))}`;
  }

  const amountText = money(amount);
  let message: string;
  if (type === 'expense') {
    message = `Gasto de ${amountText}${categoryName ? ` en ${categoryName}` : ''}`;
    if (payment?.kind === 'card') message += ` con ${payment.label} registrado${tail}`;
    else if (payment?.kind === 'account') {
      message += ' registrado';
      message += balance !== null ? ` · ${payment.label}: te quedan ${money(balance)}` : ` · ${payment.label}`;
    } else message += ' registrado';
  } else {
    message = `Ingreso de ${amountText}${categoryName ? ` por ${categoryName}` : ''} registrado`;
    if (payment?.kind === 'account') message += ` en ${payment.label}${balance !== null ? ` · saldo: ${money(balance)}` : ''}`;
  }
  if (date !== todayISO()) message += ` · fecha: ${shortDate(date)}`;
  if (categoryMissing) message += ` (categoría ${clip(categoryMissing, 40)} no encontrada)`;

  const body: QuickResult = { ok: true, message, transaction_id: transactionId, balance };
  res.status(201).json(body);
});

// GET /api/quick/summary
quickRouter.get('/summary', async (_req, res) => {
  const today = todayISO();
  const [y, m] = today.split('-').map(Number);
  const { from, to } = monthRange(y, m);
  const yesterday = addDaysISO(today, -1);
  const [accounts, spent, yieldRow] = await Promise.all([
    loadAccounts(),
    one<{ today: number; month: number }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE date = $1::date), 0) AS today,
              COALESCE(SUM(amount), 0) AS month
         FROM transactions
        WHERE type = 'expense' AND date >= $2::date AND date < $3::date`,
      [today, from, to],
    ),
    one<{ total: number }>(
      `SELECT COALESCE(SUM(b.amount), 0) AS total
         FROM balance_adjustments b
         JOIN accounts a ON a.id = b.account_id
        WHERE b.auto AND b.source = 'rendimiento' AND b.date = $1::date
          AND b.date >= a.opening_date AND a.archived = false`,
      [yesterday],
    ),
  ]);
  const totals = accountTotals(accounts);
  const parts: string[] = [];
  parts.push(totals.accounts > 0 ? `Tienes ${money(totals.total)} (disponible ${money(totals.disponible)})` : 'Aún no tienes cuentas registradas');
  parts.push(`Hoy gastaste ${money(Number(spent?.today) || 0)}`);
  parts.push(`Este mes ${money(Number(spent?.month) || 0)}`);
  const earned = round2(Number(yieldRow?.total) || 0);
  if (earned > 0) parts.push(`Tu dinero rindió ayer ${money(earned)}`);
  const body: QuickResult = { ok: true, message: parts.join(' · ') };
  res.json(body);
});

// Método equivocado en una ruta existente (error típico al armar el Atajo: dejar GET en /transaction).
quickRouter.all('/transaction', (_req, res) => {
  const message = 'Usa el método POST para registrar en /api/quick/transaction (en el Atajo: «Mostrar más» → Método POST).';
  res.set('Allow', 'POST').status(405).json({ ok: false, message, error: message });
});
quickRouter.all(['/options', '/summary'], (req, res) => {
  const message = `Usa el método GET en /api/quick${req.path} (en el Atajo: «Mostrar más» → Método GET).`;
  res.set('Allow', 'GET, HEAD').status(405).json({ ok: false, message, error: message });
});

// Rutas desconocidas dentro de /api/quick (así un error en la URL del Atajo no parece un problema de token).
quickRouter.use((_req, res) => {
  const message = 'Ruta no encontrada en la API rápida (usa /api/quick/options, /transaction o /summary)';
  res.status(404).json({ ok: false, message, error: message });
});

// Errores de /api/quick: { ok: false, message, error } con el mismo status que el manejador general.
quickRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let message = 'Error interno del servidor';
  const pgCode = (err as { code?: string })?.code;
  if (err instanceof HttpError) {
    status = err.status;
    message = err.message;
  } else if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.parse.failed') {
    status = 400;
    message = 'JSON inválido';
  } else if (typeof err === 'object' && err !== null && (err as { type?: string }).type === 'entity.too.large') {
    status = 413;
    message = 'La petición es demasiado grande.';
  } else if (
    typeof err === 'object' &&
    err !== null &&
    (err as { expose?: boolean }).expose === true &&
    Number((err as { status?: number }).status) >= 400 &&
    Number((err as { status?: number }).status) < 500
  ) {
    // Otros errores del lector de cuerpo (charset o encoding no soportado, etc.)
    status = Number((err as { status?: number }).status);
    message = 'No se pudo leer el cuerpo de la petición: envíalo como JSON.';
  } else if (pgCode === '23503') {
    status = 400;
    message = 'La categoría o la forma de pago ya no existe; vuelve a intentarlo';
  } else if (pgCode === '23514') {
    status = 400;
    message = 'Los datos no cumplen las restricciones (revisa monto y fecha)';
  } else {
    console.error('[quick] error no controlado:', err);
  }
  res.status(status).json({ ok: false, message, error: message });
});
