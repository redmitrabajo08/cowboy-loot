-- Migración Postgres para Cowboy Loot (Neon).
-- Equivale a drizzle/0001 + drizzle/0002 del artefacto (SQLite),
-- traducida a Postgres. Es idempotente: se puede ejecutar varias veces
-- sin borrar datos (CREATE TABLE IF NOT EXISTS).
--
-- NO incluye el reseteo de contraseña de drizzle/0003: en el despliegue
-- nuevo el panel arranca sin contraseña y Gary crea la suya al entrar
-- por primera vez (acción adminSetup). Si algún día hay que resetearla
-- en Neon, la sentencia equivalente es:
--   DELETE FROM settings WHERE key IN ('admin_pass_hash','admin_token','admin_token_exp');

CREATE TABLE IF NOT EXISTS game_state (
  id INTEGER PRIMARY KEY,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  bet_cents BIGINT NOT NULL DEFAULT 100,
  fs_remaining INTEGER NOT NULL DEFAULT 0,
  fs_total_win_cents BIGINT NOT NULL DEFAULT 0,
  fs_bet_cents BIGINT NOT NULL DEFAULT 0,
  fs_super INTEGER NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  opened_at BIGINT NOT NULL,
  closed_at BIGINT,
  status TEXT NOT NULL DEFAULT 'open',
  opening_balance_cents BIGINT NOT NULL DEFAULT 0,
  closing_balance_cents BIGINT,
  cashout_code TEXT,
  cashout_amount_cents BIGINT,
  total_recharged_cents BIGINT NOT NULL DEFAULT 0,
  total_bet_cents BIGINT NOT NULL DEFAULT 0,
  total_won_cents BIGINT NOT NULL DEFAULT 0,
  spin_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY,
  session_id INTEGER,
  type TEXT NOT NULL,
  bet_cents BIGINT NOT NULL DEFAULT 0,
  win_cents BIGINT NOT NULL DEFAULT 0,
  combos TEXT,
  multiplier INTEGER NOT NULL DEFAULT 0,
  free_spin INTEGER NOT NULL DEFAULT 0,
  balance_after_cents BIGINT NOT NULL,
  note TEXT,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS transactions_session_idx ON transactions (session_id);
CREATE INDEX IF NOT EXISTS transactions_created_idx ON transactions (created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
