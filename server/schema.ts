import { pool, query } from './db.js';

/**
 * Crea las tablas si no existen y siembra categorías por defecto.
 * Es idempotente: se ejecuta en cada arranque del servidor.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  color       TEXT NOT NULL DEFAULT '#e5202e',
  icon        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name, type)
);

CREATE TABLE IF NOT EXISTS credit_cards (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  credit_limit  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  cutoff_day    INT NOT NULL DEFAULT 1 CHECK (cutoff_day BETWEEN 1 AND 31),
  payment_day   INT NOT NULL DEFAULT 20 CHECK (payment_day BETWEEN 1 AND 31),
  color         TEXT NOT NULL DEFAULT '#e5202e',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id              SERIAL PRIMARY KEY,
  type            TEXT NOT NULL CHECK (type IN ('income', 'expense')),
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  category_id     INT REFERENCES categories(id) ON DELETE SET NULL,
  description     TEXT NOT NULL DEFAULT '',
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  credit_card_id  INT REFERENCES credit_cards(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_transactions_card ON transactions(credit_card_id);

CREATE TABLE IF NOT EXISTS card_payments (
  id              SERIAL PRIMARY KEY,
  credit_card_id  INT NOT NULL REFERENCES credit_cards(id) ON DELETE CASCADE,
  amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  note            TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_card_payments_card ON card_payments(credit_card_id);
CREATE INDEX IF NOT EXISTS idx_card_payments_date ON card_payments(date);

CREATE TABLE IF NOT EXISTS loans (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  principal       NUMERIC(14,2) NOT NULL CHECK (principal > 0),
  annual_rate     NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (annual_rate >= 0),
  monthly_payment NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_payment >= 0),
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  term_months     INT NOT NULL DEFAULT 12 CHECK (term_months > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS loan_payments (
  id          SERIAL PRIMARY KEY,
  loan_id     INT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loan_payments_loan ON loan_payments(loan_id);
CREATE INDEX IF NOT EXISTS idx_loan_payments_date ON loan_payments(date);

CREATE TABLE IF NOT EXISTS savings_goals (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  target_amount  NUMERIC(14,2) NOT NULL CHECK (target_amount > 0),
  deadline       DATE,
  color          TEXT NOT NULL DEFAULT '#e5202e',
  icon           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goal_contributions (
  id          SERIAL PRIMARY KEY,
  goal_id     INT NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_goal_contributions_goal ON goal_contributions(goal_id);
CREATE INDEX IF NOT EXISTS idx_goal_contributions_date ON goal_contributions(date);

-- Mi dinero: cuentas por banco (independientes de las metas de ahorro)
CREATE TABLE IF NOT EXISTS accounts (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  bank             TEXT NOT NULL DEFAULT '',
  kind             TEXT NOT NULL CHECK (kind IN ('disponible', 'ahorro', 'inversion', 'efectivo')),
  opening_balance  NUMERIC(14,2) NOT NULL DEFAULT 0,
  opening_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  color            TEXT NOT NULL DEFAULT '#e5202e',
  archived         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE transactions  ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE card_payments ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE loan_payments ADD COLUMN IF NOT EXISTS account_id INT REFERENCES accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);

-- Compras a meses (solo gastos con tarjeta): 1 = una sola exhibición
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS installments INT NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 48);
CREATE INDEX IF NOT EXISTS idx_card_payments_account ON card_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_loan_payments_account ON loan_payments(account_id);

CREATE TABLE IF NOT EXISTS transfers (
  id               SERIAL PRIMARY KEY,
  from_account_id  INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_account_id    INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  date             DATE NOT NULL DEFAULT CURRENT_DATE,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_account_id <> to_account_id)
);
CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_account_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_account_id);

CREATE TABLE IF NOT EXISTS balance_adjustments (
  id          SERIAL PRIMARY KEY,
  account_id  INT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  date        DATE NOT NULL DEFAULT CURRENT_DATE,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_balance_adjustments_account ON balance_adjustments(account_id);

CREATE TABLE IF NOT EXISTS sessions (
  sid         TEXT PRIMARY KEY,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS budgets (
  id           SERIAL PRIMARY KEY,
  category_id  INT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  year         INT NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month        INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount       NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category_id, year, month)
);
`;

/** Paleta de la marca: rojos (rampa ordinal validada) + neutros. */
export const DEFAULT_CATEGORIES: { name: string; type: 'income' | 'expense'; color: string; icon: string }[] = [
  { name: 'Comida', type: 'expense', color: '#ec2d3c', icon: '🍔' },
  { name: 'Transporte', type: 'expense', color: '#f3646f', icon: '🚗' },
  { name: 'Vivienda', type: 'expense', color: '#9e1220', icon: '🏠' },
  { name: 'Servicios', type: 'expense', color: '#c9192a', icon: '💡' },
  { name: 'Salud', type: 'expense', color: '#f79aa1', icon: '🩺' },
  { name: 'Entretenimiento', type: 'expense', color: '#fbc8cc', icon: '🎬' },
  { name: 'Ropa', type: 'expense', color: '#bdbdbd', icon: '👕' },
  { name: 'Educación', type: 'expense', color: '#e0e0e0', icon: '📚' },
  { name: 'Suscripciones', type: 'expense', color: '#8a8a8a', icon: '📺' },
  { name: 'Otros gastos', type: 'expense', color: '#5e5e5e', icon: '📦' },
  { name: 'Salario', type: 'income', color: '#f2f2f2', icon: '💼' },
  { name: 'Freelance', type: 'income', color: '#d6d6d6', icon: '💻' },
  { name: 'Inversiones', type: 'income', color: '#f3646f', icon: '📈' },
  { name: 'Regalos', type: 'income', color: '#fbc8cc', icon: '🎁' },
  { name: 'Otros ingresos', type: 'income', color: '#a3a3a3', icon: '➕' },
];

export async function ensureSchema(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(DDL);
  } finally {
    client.release();
  }

  const [{ n }] = await query<{ n: number }>('SELECT count(*)::int AS n FROM categories');
  if (n === 0) {
    for (const c of DEFAULT_CATEGORIES) {
      await query(
        'INSERT INTO categories (name, type, color, icon) VALUES ($1, $2, $3, $4) ON CONFLICT (name, type) DO NOTHING',
        [c.name, c.type, c.color, c.icon],
      );
    }
    console.log(`[db] categorías por defecto creadas (${DEFAULT_CATEGORIES.length})`);
  }
}
