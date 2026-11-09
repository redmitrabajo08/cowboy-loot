// Esquema Postgres para el paquete autónomo de despliegue (Render + Neon).
//
// Es el espejo exacto de `server/src/schema.ts` (SQLite) traducido a
// Postgres con drizzle-orm/pg-core:
// - Los ids autoincrementales pasan a `serial`.
// - Los montos en centavos y las marcas de tiempo (epoch ms) pasan a
//   `bigint` con mode: "number" para no desbordar el entero de 32 bits
//   de Postgres en historiales largos.
// - Los booleanos 0/1 (fs_super, free_spin) se conservan como enteros
//   pequeños para que `server/src/actions.ts` funcione sin cambios de
//   lógica: solo cambian el import del esquema y el driver.
import { bigint, integer, pgTable, serial, text } from "drizzle-orm/pg-core";

// Estado del juego en una sola fila: el saldo vive SOLO aquí.
// Arranca en 0 y solo entra dinero desde el panel administrativo
// (recarga o fijar saldo). Sin recarga automática de ningún tipo.
export const gameState = pgTable("game_state", {
  id: integer("id").primaryKey(),
  balanceCents: bigint("balance_cents", { mode: "number" }).notNull().default(0),
  betCents: bigint("bet_cents", { mode: "number" }).notNull().default(100),
  fsRemaining: integer("fs_remaining").notNull().default(0),
  fsTotalWinCents: bigint("fs_total_win_cents", { mode: "number" }).notNull().default(0),
  fsBetCents: bigint("fs_bet_cents", { mode: "number" }).notNull().default(0),
  fsSuper: integer("fs_super").notNull().default(0),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull().default(0),
});

// Una fila por jugador: se abre con la primera recarga sin sesión abierta
// y se cierra con COBRAR, guardando el reporte del retiro (código + monto).
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  openedAt: bigint("opened_at", { mode: "number" }).notNull(),
  closedAt: bigint("closed_at", { mode: "number" }),
  status: text("status", { enum: ["open", "closed"] }).notNull().default("open"),
  openingBalanceCents: bigint("opening_balance_cents", { mode: "number" }).notNull().default(0),
  closingBalanceCents: bigint("closing_balance_cents", { mode: "number" }),
  cashoutCode: text("cashout_code"),
  cashoutAmountCents: bigint("cashout_amount_cents", { mode: "number" }),
  totalRechargedCents: bigint("total_recharged_cents", { mode: "number" }).notNull().default(0),
  totalBetCents: bigint("total_bet_cents", { mode: "number" }).notNull().default(0),
  totalWonCents: bigint("total_won_cents", { mode: "number" }).notNull().default(0),
  spinCount: integer("spin_count").notNull().default(0),
});

// Cada giro es una transacción, gane o pierda (win = 0 si pierde).
// Los giros ganadores guardan las combinaciones que pagaron en JSON:
// [{ symbol, name, count, winCents }] más la suma de multiplicadores.
export const transactions = pgTable("transactions", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id"),
  type: text("type", {
    enum: ["spin", "recharge", "bonus_buy", "cashout", "set_balance"],
  }).notNull(),
  betCents: bigint("bet_cents", { mode: "number" }).notNull().default(0),
  winCents: bigint("win_cents", { mode: "number" }).notNull().default(0),
  combos: text("combos"),
  multiplier: integer("multiplier").notNull().default(0),
  freeSpin: integer("free_spin").notNull().default(0),
  balanceAfterCents: bigint("balance_after_cents", { mode: "number" }).notNull(),
  note: text("note"),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// Clave/valor: hash de la contraseña del panel y token de sesión admin.
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
