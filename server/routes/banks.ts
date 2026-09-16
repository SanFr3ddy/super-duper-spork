/**
 * Mis bancos: rendimiento anual con tope.
 * Contrato: sección "Mis bancos" de shared/types.ts. Cálculos: server/accountsData.ts (loadBanks) y server/yields.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, withTransaction } from '../db.js';
import { loadBanks } from '../accountsData.js';
import { HttpError, notFound, parseId, round2, todayISO, validate, zColor, zMoneyNonNeg, zName } from '../util.js';
import type { Bank } from '../../shared/types.js';

export const banksRouter = Router();

const zRate = z.number().finite().min(0, 'La tasa no puede ser negativa').max(1000, 'La tasa máxima es 1000%');

const bankSchema = z.object({
  name: zName,
  color: zColor.optional(),
  annual_rate: zRate,
  yield_cap: zMoneyNonNeg.nullable().optional(),
  rate_above_cap: zRate.optional(),
  auto_yield: z.boolean().optional(),
});

const DUPLICATE = 'Ya existe un banco con ese nombre';
const round3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000;

async function assertUniqueName(name: string, exceptId: number | null): Promise<void> {
  const dup = await one<{ id: number }>('SELECT id FROM banks WHERE lower(name) = lower($1) AND ($2::int IS NULL OR id <> $2::int)', [
    name,
    exceptId,
  ]);
  if (dup) throw new HttpError(409, DUPLICATE);
}

/** Traduce la violación del índice único de nombre (carrera entre dos peticiones) a 409 con mensaje claro. */
function mapDuplicate(err: unknown): never {
  if ((err as { code?: string })?.code === '23505') throw new HttpError(409, DUPLICATE);
  throw err;
}

async function loadBank(id: number): Promise<Bank> {
  const bank = (await loadBanks()).find((b) => b.id === id);
  if (!bank) throw notFound('Banco');
  return bank;
}

banksRouter.get('/', async (_req, res) => {
  res.json(await loadBanks());
});

banksRouter.post('/', async (req, res) => {
  const data = validate(bankSchema, req.body);
  await assertUniqueName(data.name, null);
  const row = await one<{ id: number }>(
    `INSERT INTO banks (name, color, annual_rate, yield_cap, rate_above_cap, auto_yield, rate_since)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      data.name,
      data.color ?? '#e5202e',
      round3(data.annual_rate),
      data.yield_cap === undefined || data.yield_cap === null ? null : round2(data.yield_cap),
      round3(data.rate_above_cap ?? 0),
      data.auto_yield ?? true,
      todayISO(), // el abono diario automático empieza hoy (no se abonan días anteriores)
    ],
  ).catch(mapDuplicate);
  res.status(201).json(await loadBank(row!.id));
});

banksRouter.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(bankSchema.partial(), req.body);
  const current = await one<{ name: string; annual_rate: number; rate_above_cap: number; auto_yield: boolean }>(
    'SELECT name, annual_rate, rate_above_cap, auto_yield FROM banks WHERE id = $1',
    [id],
  );
  if (!current) throw notFound('Banco');
  if (data.name !== undefined && data.name.toLocaleLowerCase('es') !== current.name.toLocaleLowerCase('es')) {
    await assertUniqueName(data.name, id);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (col: string, value: unknown): void => {
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  };
  if (data.name !== undefined) add('name', data.name);
  if (data.color !== undefined) add('color', data.color);
  if (data.annual_rate !== undefined) add('annual_rate', round3(data.annual_rate));
  if (data.yield_cap !== undefined) add('yield_cap', data.yield_cap === null ? null : round2(data.yield_cap));
  if (data.rate_above_cap !== undefined) add('rate_above_cap', round3(data.rate_above_cap));
  if (data.auto_yield !== undefined) add('auto_yield', data.auto_yield);
  // Si antes no generaba abono automático (tasa 0 o auto_yield apagado) y ahora sí, empieza a contar desde hoy.
  const wasEarning = current.auto_yield && (Number(current.annual_rate) > 0 || Number(current.rate_above_cap) > 0);
  const nextRate = data.annual_rate ?? Number(current.annual_rate);
  const nextAbove = data.rate_above_cap ?? Number(current.rate_above_cap);
  const nextAuto = data.auto_yield ?? current.auto_yield;
  if (!wasEarning && nextAuto && (nextRate > 0 || nextAbove > 0)) add('rate_since', todayISO());

  if (sets.length > 0) {
    params.push(id);
    const sql = `UPDATE banks SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, name`;
    await withTransaction(async (client) => {
      const { rows } = await client.query<{ id: number; name: string }>(sql, params);
      if (!rows[0]) throw notFound('Banco');
      if (data.name !== undefined) {
        // accounts.bank es la copia del nombre que usan agrupaciones y descripciones
        await client.query('UPDATE accounts SET bank = $1 WHERE bank_id = $2 AND bank IS DISTINCT FROM $1', [rows[0].name, id]);
      }
    }).catch(mapDuplicate);
  }
  res.json(await loadBank(id));
});

banksRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  // Borrado atómico: solo si no tiene cuentas (incluidas archivadas)
  const deleted = await one<{ id: number }>(
    'DELETE FROM banks WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM accounts WHERE bank_id = $1) RETURNING id',
    [id],
  );
  if (deleted) {
    res.json({ ok: true });
    return;
  }
  const info = await one<{ found: boolean; n: number; archived: number }>(
    `SELECT EXISTS (SELECT 1 FROM banks WHERE id = $1) AS found,
            (SELECT count(*)::int FROM accounts WHERE bank_id = $1) AS n,
            (SELECT count(*)::int FROM accounts WHERE bank_id = $1 AND archived) AS archived`,
    [id],
  );
  if (!info?.found) throw notFound('Banco');
  // accounts_count del banco solo cuenta las activas: se aclara cuando hay archivadas para que el 409 no confunda
  const extra = info.archived > 0 ? ` (${info.archived} archivada(s))` : '';
  throw new HttpError(409, `El banco tiene ${info.n} cuenta(s)${extra}; cámbialas de banco o elimínalas primero`);
});
