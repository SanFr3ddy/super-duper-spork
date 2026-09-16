/**
 * Tokens de API (Atajos de iPhone). Protegido por la sesión normal (montado después de requireAuth).
 * Contrato: sección "Registro rápido desde fuera de la web" de shared/types.ts.
 */
import { Router } from 'express';
import { z } from 'zod';
import { one, query, withTransaction } from '../db.js';
import { HttpError, notFound, parseId, validate, zName } from '../util.js';
import { generateToken, MAX_TOKENS } from '../apiTokens.js';
import type { ApiToken, ApiTokenCreated } from '../../shared/types.js';

export const tokensRouter = Router();

type TokenRow = {
  id: number;
  name: string;
  prefix: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
};

const TOKEN_COLUMNS = 'id, name, prefix, created_at, last_used_at';

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

function toToken(r: TokenRow): ApiToken {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    created_at: iso(r.created_at),
    last_used_at: r.last_used_at === null || r.last_used_at === undefined ? null : iso(r.last_used_at),
  };
}

const createSchema = z.object({ name: zName });

// GET /api/tokens -> ApiToken[] (sin hash)
tokensRouter.get('/', async (_req, res) => {
  const rows = await query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at DESC, id DESC`);
  const body: ApiToken[] = rows.map(toToken);
  res.json(body);
});

// POST /api/tokens { name } -> ApiTokenCreated (el token completo solo se devuelve aquí)
tokensRouter.post('/', async (req, res) => {
  const { name } = validate(createSchema, req.body);
  const { token, prefix, hash } = generateToken();
  const row = await withTransaction(async (client) => {
    // Serializa las altas para que dos peticiones simultáneas no pasen del máximo.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('api_tokens'))");
    const count = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM api_tokens');
    if ((count.rows[0]?.n ?? 0) >= MAX_TOKENS) {
      throw new HttpError(409, `Ya tienes ${MAX_TOKENS} tokens. Borra uno que no uses antes de crear otro.`);
    }
    const inserted = await client.query<TokenRow>(
      `INSERT INTO api_tokens (name, token_hash, prefix) VALUES ($1, $2, $3) RETURNING ${TOKEN_COLUMNS}`,
      [name, hash, prefix],
    );
    return inserted.rows[0];
  });
  const body: ApiTokenCreated = { ...toToken(row), token };
  res.status(201).json(body);
});

// DELETE /api/tokens/:id -> { ok: true }
tokensRouter.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  const row = await one<{ id: number }>('DELETE FROM api_tokens WHERE id = $1 RETURNING id', [id]);
  if (!row) throw notFound('Token');
  res.json({ ok: true });
});
