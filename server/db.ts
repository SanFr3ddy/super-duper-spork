import './env.js';
import pg from 'pg';

const { Pool, types } = pg;

// NUMERIC -> number (montos). BIGINT (count/sum de enteros) -> number. DATE -> 'YYYY-MM-DD' sin zona horaria.
types.setTypeParser(1700, (v: string) => parseFloat(v));
types.setTypeParser(20, (v: string) => parseInt(v, 10));
types.setTypeParser(1082, (v: string) => v);

if (!process.env.DATABASE_URL) {
  throw new Error('Falta la variable de entorno DATABASE_URL (cadena de conexión de Neon).');
}

/**
 * pg trata 'require' como alias de 'verify-full' (y avisa en consola). Lo hacemos explícito para
 * conservar la verificación completa del certificado sin la advertencia. 'channel_binding' no aplica en pg.
 */
function normalizeUrl(input: string): string {
  // Tolera errores comunes al pegar en paneles: espacios, saltos de línea, comillas o el prefijo "DATABASE_URL=".
  const raw = input
    .trim()
    .replace(/^DATABASE_URL\s*=\s*/i, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/\s+/g, '');
  try {
    const u = new URL(raw);
    const mode = u.searchParams.get('sslmode');
    if (mode === 'require' || mode === 'prefer' || mode === 'verify-ca') u.searchParams.set('sslmode', 'verify-full');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch {
    return raw;
  }
}

export const pool = new Pool({
  connectionString: normalizeUrl(process.env.DATABASE_URL),
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] error en cliente inactivo del pool:', err.message);
});

export type Row = Record<string, unknown>;

/** Ejecuta una consulta y devuelve todas las filas tipadas. */
export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

/** Devuelve la primera fila o null. */
export async function one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Ejecuta varias consultas dentro de una transacción SQL. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
