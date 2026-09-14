/**
 * Mi dinero: cuentas por banco, transferencias y ajustes de saldo.
 * Contrato: sección "Mi dinero" de shared/types.ts. Saldos: server/accountsData.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, query } from '../db.js';
import { accountTotals, bankTotals, loadAccounts, monthlyBalances } from '../accountsData.js';
import { HttpError, notFound, parseId, round2, todayISO, validate, zColor, zDate, zMoney, zName, zNote } from '../util.js';
import type { Account, AccountMovement, AccountMovementSource, AccountsOverview, Transfer } from '../../shared/types.js';

export const accountsRouter = Router();

const MAX_ABS = 999_999_999_999;
const zKind = z.enum(['disponible', 'ahorro', 'inversion', 'efectivo']);
const zSigned = z.number().finite().min(-MAX_ABS, 'Monto demasiado grande').max(MAX_ABS, 'Monto demasiado grande');

const accountSchema = z.object({
  name: zName,
  bank: z.string().trim().max(60, 'Máximo 60 caracteres').optional(),
  kind: zKind,
  opening_balance: zSigned,
  opening_date: zDate.optional(),
  color: zColor.optional(),
  archived: z.boolean().optional(),
});

const adjustSchema = z.object({
  balance: zSigned,
  date: zDate.optional(),
  note: zNote.optional(),
});

const transferSchema = z.object({
  from_account_id: z.number().int().positive(),
  to_account_id: z.number().int().positive(),
  amount: zMoney,
  date: zDate,
  note: zNote.optional(),
});

async function loadAccount(id: number): Promise<Account> {
  const [acc] = await loadAccounts({ id });
  if (!acc) throw notFound('Cuenta');
  return acc;
}

function parseYear(raw: unknown): number {
  if (raw === undefined || raw === '') return Number(todayISO().slice(0, 4));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2000 || n > 2100) throw new HttpError(400, 'year inválido');
  return n;
}

// ---------------------------------------------------------------------------
// Resumen y lista
// ---------------------------------------------------------------------------
accountsRouter.get('/', async (req, res) => {
  const year = parseYear(req.query.year);
  const items = await loadAccounts();
  const [monthly, yearRows] = await Promise.all([
    monthlyBalances(year, items),
    query<{ y: number }>(
      `SELECT DISTINCT EXTRACT(YEAR FROM d)::int AS y FROM (
         SELECT opening_date AS d FROM accounts
         UNION ALL SELECT date FROM transfers
         UNION ALL SELECT date FROM balance_adjustments
         UNION ALL SELECT date FROM transactions WHERE account_id IS NOT NULL
       ) x`,
    ),
  ]);
  const years = new Set<number>([Number(todayISO().slice(0, 4)), year, ...yearRows.map((r) => Number(r.y))]);
  const body: AccountsOverview = {
    year,
    items,
    totals: accountTotals(items),
    by_bank: bankTotals(items),
    monthly,
    available_years: [...years].filter(Number.isInteger).sort((a, b) => b - a),
  };
  res.json(body);
});

accountsRouter.get('/list', async (_req, res) => {
  res.json(await loadAccounts());
});

// ---------------------------------------------------------------------------
// Transferencias (antes de las rutas /:id)
// ---------------------------------------------------------------------------
accountsRouter.post('/transfers', async (req, res) => {
  const data = validate(transferSchema, req.body);
  if (data.from_account_id === data.to_account_id) throw new HttpError(400, 'Elige dos cuentas distintas');
  const found = await query<{ id: number }>('SELECT id FROM accounts WHERE id = ANY($1::int[])', [[data.from_account_id, data.to_account_id]]);
  if (found.length !== 2) throw new HttpError(400, 'Alguna de las cuentas no existe');
  const row = await one<Transfer & Record<string, unknown>>(
    `INSERT INTO transfers (from_account_id, to_account_id, amount, date, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, from_account_id, to_account_id, amount, date, note, created_at`,
    [data.from_account_id, data.to_account_id, round2(data.amount), data.date, data.note ?? ''],
  );
  res.status(201).json(row);
});

accountsRouter.delete('/transfers/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM transfers WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Transferencia');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------
accountsRouter.post('/', async (req, res) => {
  const data = validate(accountSchema, req.body);
  const row = await one<{ id: number }>(
    `INSERT INTO accounts (name, bank, kind, opening_balance, opening_date, color, archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [data.name, data.bank ?? '', data.kind, round2(data.opening_balance), data.opening_date ?? todayISO(), data.color ?? '#e5202e', data.archived ?? false],
  );
  res.status(201).json(await loadAccount(row!.id));
});

accountsRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(accountSchema.partial(), req.body);
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown): void => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (data.name !== undefined) add('name', data.name);
  if (data.bank !== undefined) add('bank', data.bank);
  if (data.kind !== undefined) add('kind', data.kind);
  if (data.opening_balance !== undefined) add('opening_balance', round2(data.opening_balance));
  if (data.opening_date !== undefined) add('opening_date', data.opening_date);
  if (data.color !== undefined) add('color', data.color);
  if (data.archived !== undefined) add('archived', data.archived);
  if (sets.length === 0) {
    res.json(await loadAccount(id));
    return;
  }
  params.push(id);
  const row = await one<{ id: number }>(`UPDATE accounts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id`, params);
  if (!row) throw notFound('Cuenta');
  res.json(await loadAccount(id));
});

accountsRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM accounts WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Cuenta');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ajustes de saldo
// ---------------------------------------------------------------------------
accountsRouter.post('/:id/adjust', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(adjustSchema, req.body);
  const date = data.date ?? todayISO();
  const base = await one<{ opening_date: string }>('SELECT opening_date FROM accounts WHERE id = $1', [id]);
  if (!base) throw notFound('Cuenta');
  if (date < base.opening_date) throw new HttpError(400, 'La fecha del ajuste no puede ser anterior a la fecha de apertura de la cuenta');
  const [asOf] = await loadAccounts({ id, asOf: date });
  const delta = round2(data.balance - asOf.balance);
  if (Math.abs(delta) >= 0.01) {
    await query('INSERT INTO balance_adjustments (account_id, amount, date, note) VALUES ($1, $2, $3, $4)', [id, delta, date, data.note ?? '']);
  }
  res.json(await loadAccount(id));
});

accountsRouter.delete('/:id/adjustments/:adjustmentId', async (req, res) => {
  const id = parseId(req.params.id);
  const adjId = parseId(req.params.adjustmentId, 'adjustmentId');
  const row = await one<{ id: number }>('DELETE FROM balance_adjustments WHERE id = $1 AND account_id = $2 RETURNING id', [adjId, id]);
  if (!row) throw notFound('Ajuste');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Movimientos de una cuenta (libro con saldo acumulado)
// ---------------------------------------------------------------------------
accountsRouter.get('/:id/movements', async (req, res) => {
  const id = parseId(req.params.id);
  const acc = await one<{ opening_balance: number; opening_date: string; name: string }>(
    'SELECT opening_balance, opening_date, name FROM accounts WHERE id = $1',
    [id],
  );
  if (!acc) throw notFound('Cuenta');

  type Row = { source: AccountMovementSource; ref_id: number; date: string; description: string; amount: number; created_at: Date | string };
  const rows = await query<Row>(
    `SELECT CASE WHEN t.type = 'income' THEN 'income' ELSE 'expense' END AS source, t.id AS ref_id, t.date,
            COALESCE(NULLIF(t.description, ''), c.name, CASE WHEN t.type = 'income' THEN 'Ingreso' ELSE 'Gasto' END) AS description,
            CASE WHEN t.type = 'income' THEN t.amount ELSE -t.amount END AS amount, t.created_at
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE t.account_id = $1 AND (t.type = 'income' OR t.credit_card_id IS NULL)
     UNION ALL
     SELECT 'card_payment', p.id, p.date, 'Pago de tarjeta ' || cc.name || CASE WHEN p.note <> '' THEN ' · ' || p.note ELSE '' END, -p.amount, p.created_at
       FROM card_payments p JOIN credit_cards cc ON cc.id = p.credit_card_id
      WHERE p.account_id = $1
     UNION ALL
     SELECT 'loan_payment', p.id, p.date, 'Pago de préstamo ' || l.name || CASE WHEN p.note <> '' THEN ' · ' || p.note ELSE '' END, -p.amount, p.created_at
       FROM loan_payments p JOIN loans l ON l.id = p.loan_id
      WHERE p.account_id = $1
     UNION ALL
     SELECT 'transfer_in', tr.id, tr.date, 'Transferencia desde ' || fa.name || CASE WHEN fa.bank <> '' THEN ' (' || fa.bank || ')' ELSE '' END || CASE WHEN tr.note <> '' THEN ' · ' || tr.note ELSE '' END, tr.amount, tr.created_at
       FROM transfers tr JOIN accounts fa ON fa.id = tr.from_account_id
      WHERE tr.to_account_id = $1
     UNION ALL
     SELECT 'transfer_out', tr.id, tr.date, 'Transferencia a ' || ta.name || CASE WHEN ta.bank <> '' THEN ' (' || ta.bank || ')' ELSE '' END || CASE WHEN tr.note <> '' THEN ' · ' || tr.note ELSE '' END, -tr.amount, tr.created_at
       FROM transfers tr JOIN accounts ta ON ta.id = tr.to_account_id
      WHERE tr.from_account_id = $1
     UNION ALL
     SELECT 'adjustment', b.id, b.date, 'Ajuste de saldo' || CASE WHEN b.note <> '' THEN ' · ' || b.note ELSE '' END, b.amount, b.created_at
       FROM balance_adjustments b
      WHERE b.account_id = $1`,
    [id],
  );

  const today = todayISO();
  const keyPrefix: Record<AccountMovementSource, string> = {
    opening: 'opening',
    income: 'tx',
    expense: 'tx',
    card_payment: 'cp',
    loan_payment: 'lp',
    transfer_in: 'tr',
    transfer_out: 'tr',
    adjustment: 'adj',
  };
  const events = rows
    .filter((r) => r.date >= acc.opening_date)
    .map((r) => ({ ...r, createdMs: new Date(r.created_at).getTime() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdMs - b.createdMs || a.ref_id - b.ref_id);

  let balance = round2(Number(acc.opening_balance) || 0);
  const ledger: AccountMovement[] = [
    { key: 'opening', source: 'opening', ref_id: null, date: acc.opening_date, description: 'Saldo inicial', amount: balance, running_balance: balance, future: acc.opening_date > today },
  ];
  for (const e of events) {
    const amount = round2(Number(e.amount) || 0);
    balance = round2(balance + amount);
    ledger.push({
      key: `${keyPrefix[e.source]}-${e.ref_id}`,
      source: e.source,
      ref_id: e.ref_id,
      date: e.date,
      description: e.description,
      amount,
      running_balance: balance,
      future: e.date > today,
    });
  }
  res.json(ledger.reverse());
});
