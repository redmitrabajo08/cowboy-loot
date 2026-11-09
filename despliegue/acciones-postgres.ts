// acciones-postgres.ts — copia de server/src/actions.ts del artefacto
// con SOLO dos imports cambiados para el paquete autónomo:
//   "@hatch/space-sdk" -> "./space-sdk-shim"   y   "./schema" -> "./schema-pg"
// El motor del slot, las reglas de saldo/sesiones/COBRAR y las 11
// acciones son byte a byte las mismas que corren en el artefacto.
// Si actions.ts cambia en el artefacto, se regenera esta copia con:
//   sed -e 's|from "@hatch/space-sdk"|from "./space-sdk-shim"|' \
//       -e 's|from "./schema"|from "./schema-pg"|' server/src/actions.ts
//
// Cowboy Loot con Base de Datos — server actions.
//
// The server database is the ONLY source of truth for the balance, the
// free-spins state, the per-player sessions and the transaction history.
// The game view and the admin panel live in this same artifact and both
// talk to these actions, so a recharge from the panel is visible in the
// game on its next poll and every spin the game plays is recorded here
// the moment it is simulated.
//
// Rules enforced here:
// - The game starts at balance 0 in the DB. There is NO automatic
//   recharge of any kind; money enters only via adminRecharge /
//   adminSetBalance from the admin panel.
// - Spins are simulated on the server (weighted RNG + cascades), so the
//   recorded transaction matches the animated result exactly.
// - Every spin is a transaction, win or lose. Winning spins store the
//   bet, the paying combinations, the total win and the updated balance.
// - COBRAR zeroes the balance in the DB, closes the player's session
//   and writes the withdrawal report (code + amount) on that session.
//   The next recharge opens a brand-new session for the next player.

import { defineAction, z, type ActionsModule, type SpaceDb } from "./space-sdk-shim";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema-pg";

type DB = SpaceDb<typeof schema>;

/* ============================ SLOT ENGINE ============================ */

const COLS = 6;
const ROWS = 5;
const CELLS = COLS * ROWS;

interface SymDef {
  id: string;
  name: string;
  weight: number;
  pay: Record<number, number> | null;
  scatter?: boolean;
  superScatter?: boolean;
}

// Same symbol set, weights and paytable as the original Cowboy Loot.
const SYMBOLS: SymDef[] = [
  { id: "cactus", name: "Cactus", weight: 170, pay: { 8: 0.3, 10: 0.8, 12: 1.5 } },
  { id: "herradura", name: "Herradura", weight: 160, pay: { 8: 0.4, 10: 1.0, 12: 2.0 } },
  { id: "bota", name: "Bota vaquera", weight: 150, pay: { 8: 0.5, 10: 1.2, 12: 3.0 } },
  { id: "sombrero", name: "Sombrero", weight: 140, pay: { 8: 0.6, 10: 1.5, 12: 4.0 } },
  { id: "botella", name: "Botella de whisky", weight: 130, pay: { 8: 0.8, 10: 2.0, 12: 5.0 } },
  { id: "revolver", name: "Revólver", weight: 95, pay: { 8: 1.0, 10: 2.5, 12: 8.0 } },
  { id: "caballo", name: "Caballo", weight: 70, pay: { 8: 1.5, 10: 3.0, 12: 10.0 } },
  { id: "forajida", name: "La Forajida", weight: 45, pay: { 8: 2.5, 10: 5.0, 12: 15.0 } },
  { id: "vaquero", name: "El Vaquero", weight: 24, pay: { 8: 4.0, 10: 10.0, 12: 50.0 } },
  { id: "estrella", name: "Estrella Scatter", weight: 16, pay: null, scatter: true },
  { id: "superestrella", name: "Súper Estrella Scatter", weight: 4, pay: null, scatter: true, superScatter: true },
];
const SYM: Record<string, SymDef> = {};
for (const s of SYMBOLS) SYM[s.id] = s;
const TOTAL_WEIGHT = SYMBOLS.reduce((a, s) => a + s.weight, 0);

function pickSymbol(): string {
  let r = Math.random() * TOTAL_WEIGHT;
  for (const s of SYMBOLS) {
    r -= s.weight;
    if (r <= 0) return s.id;
  }
  return "cactus";
}

function newGrid(): string[] {
  const g: string[] = [];
  for (let i = 0; i < CELLS; i++) g.push(pickSymbol());
  return g;
}

const MULT_VALUES = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 50, 100, 250, 500];
const MULT_WEIGHTS = [22, 20, 17, 14, 11, 9, 7, 5, 4, 3, 2, 1.2, 0.6, 0.3, 0.15];

function pickMult(minVal: number): number {
  const pool = MULT_VALUES.map((v, i) => ({ v, w: MULT_WEIGHTS[i] ?? 1 })).filter((p) => p.v >= minVal);
  const total = pool.reduce((a, p) => a + p.w, 0);
  let r = Math.random() * total;
  for (const p of pool) {
    r -= p.w;
    if (r <= 0) return p.v;
  }
  return pool[0]?.v ?? 2;
}

// Top multiplier reel: one cell per column. Empty cells are 0.
function genTopMults(inFreeSpins: boolean, superMode: boolean): number[] {
  const emptyChance = inFreeSpins ? 0.72 : 0.9;
  const out: number[] = [];
  for (let c = 0; c < COLS; c++) {
    out.push(Math.random() < emptyChance ? 0 : pickMult(2));
  }
  if (superMode && !out.some((m) => m >= 10)) {
    out[Math.floor(Math.random() * COLS)] = pickMult(10);
  }
  return out;
}

interface ComboAgg {
  symbol: string;
  name: string;
  count: number;
  winCents: number;
}

interface SpinStep {
  grid: string[];
  winPositions: number[];
  stepWinCents: number;
}

interface SpinOutcome {
  steps: SpinStep[];
  topMults: number[];
  multSum: number;
  totalWinCents: number;
  scatterCount: number;
  hasSuperScatter: boolean;
  combos: ComboAgg[];
}

function simulateSpin(betCents: number, inFreeSpins: boolean, superMode: boolean): SpinOutcome {
  const topMults = genTopMults(inFreeSpins, superMode);
  const multSum = topMults.reduce((a, m) => a + m, 0);
  let grid = newGrid();
  const scatterCount = grid.filter((id) => SYM[id]?.scatter).length;
  const hasSuperScatter = grid.some((id) => SYM[id]?.superScatter);
  const steps: SpinStep[] = [];
  const agg = new Map<string, ComboAgg>();
  let totalWin = 0;

  for (let guard = 0; guard < 60; guard++) {
    const counts = new Map<string, number>();
    for (const id of grid) counts.set(id, (counts.get(id) ?? 0) + 1);
    const winners: { def: SymDef; count: number; winCents: number }[] = [];
    const winPos: number[] = [];
    for (const [id, count] of counts) {
      const def = SYM[id];
      if (!def || !def.pay || count < 8) continue;
      const tier = count >= 12 ? 12 : count >= 10 ? 10 : 8;
      const mult = def.pay[tier] ?? 0;
      winners.push({ def, count, winCents: Math.round(betCents * mult) });
    }
    if (winners.length === 0) break;
    const winSet = new Set(winners.map((w) => w.def.id));
    grid.forEach((id, i) => {
      if (winSet.has(id)) winPos.push(i);
    });
    let stepBase = 0;
    for (const w of winners) {
      stepBase += w.winCents;
      const prev = agg.get(w.def.id);
      if (prev) {
        prev.winCents += w.winCents;
        prev.count = Math.max(prev.count, w.count);
      } else {
        agg.set(w.def.id, { symbol: w.def.id, name: w.def.name, count: w.count, winCents: w.winCents });
      }
    }
    const stepWin = multSum > 0 ? stepBase * multSum : stepBase;
    totalWin += stepWin;
    steps.push({ grid: [...grid], winPositions: winPos, stepWinCents: stepWin });
    // Cascade: per column, survivors drop to the bottom, new symbols fill the top.
    const next: string[] = new Array(CELLS).fill("cactus");
    for (let c = 0; c < COLS; c++) {
      const survivors: string[] = [];
      for (let r = 0; r < ROWS; r++) {
        const id = grid[r * COLS + c];
        if (id && !winSet.has(id)) survivors.push(id);
      }
      const missing = ROWS - survivors.length;
      for (let r = 0; r < ROWS; r++) {
        next[r * COLS + c] = r < missing ? pickSymbol() : (survivors[r - missing] ?? "cactus");
      }
    }
    grid = next;
  }
  if (steps.length === 0) {
    steps.push({ grid: [...grid], winPositions: [], stepWinCents: 0 });
  }
  // If multipliers applied, scale the per-symbol combo wins to match the total.
  const combos = [...agg.values()];
  if (multSum > 0 && combos.length > 0) {
    for (const c of combos) c.winCents = c.winCents * multSum;
  }
  combos.sort((a, b) => b.winCents - a.winCents);
  return { steps, topMults, multSum, totalWinCents: totalWin, scatterCount, hasSuperScatter, combos };
}

/* ============================ DB HELPERS ============================ */

async function ensureState(db: DB) {
  const rows = await db.select().from(schema.gameState).limit(1);
  let row = rows[0];
  if (!row) {
    await db.insert(schema.gameState).values({ id: 1, balanceCents: 0, betCents: 100, updatedAt: Date.now() });
    const again = await db.select().from(schema.gameState).limit(1);
    row = again[0];
  }
  if (!row) throw new Error("game_state unavailable");
  return row;
}

async function openSession(db: DB) {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.status, "open"))
    .orderBy(desc(schema.sessions.id))
    .limit(1);
  return rows[0] ?? null;
}

async function ensureSession(db: DB, openingBalanceCents: number) {
  const existing = await openSession(db);
  if (existing) return existing;
  const now = Date.now();
  const inserted = await db
    .insert(schema.sessions)
    .values({ openedAt: now, status: "open", openingBalanceCents })
    .returning();
  const row = inserted[0];
  if (!row) throw new Error("session insert failed");
  return row;
}

async function saveState(
  db: DB,
  patch: Partial<{
    balanceCents: number;
    betCents: number;
    fsRemaining: number;
    fsTotalWinCents: number;
    fsBetCents: number;
    fsSuper: number;
  }>,
) {
  await db
    .update(schema.gameState)
    .set({ ...patch, updatedAt: Date.now() })
    .where(eq(schema.gameState.id, 1));
}

async function bumpSession(
  db: DB,
  sessionId: number,
  patch: { recharged?: number; bet?: number; won?: number; spins?: number },
) {
  const rows = await db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).limit(1);
  const s = rows[0];
  if (!s) return;
  await db
    .update(schema.sessions)
    .set({
      totalRechargedCents: s.totalRechargedCents + (patch.recharged ?? 0),
      totalBetCents: s.totalBetCents + (patch.bet ?? 0),
      totalWonCents: s.totalWonCents + (patch.won ?? 0),
      spinCount: s.spinCount + (patch.spins ?? 0),
    })
    .where(eq(schema.sessions.id, sessionId));
}

async function writeTx(
  db: DB,
  tx: {
    sessionId: number | null;
    type: "spin" | "recharge" | "bonus_buy" | "cashout" | "set_balance";
    betCents?: number;
    winCents?: number;
    combos?: ComboAgg[] | null;
    multiplier?: number;
    freeSpin?: boolean;
    balanceAfterCents: number;
    note?: string | null;
  },
) {
  const inserted = await db
    .insert(schema.transactions)
    .values({
      sessionId: tx.sessionId,
      type: tx.type,
      betCents: tx.betCents ?? 0,
      winCents: tx.winCents ?? 0,
      combos: tx.combos ? JSON.stringify(tx.combos) : null,
      multiplier: tx.multiplier ?? 0,
      freeSpin: tx.freeSpin ? 1 : 0,
      balanceAfterCents: tx.balanceAfterCents,
      note: tx.note ?? null,
      createdAt: Date.now(),
    })
    .returning({ id: schema.transactions.id });
  return inserted[0]?.id ?? 0;
}

/* ============================ SERIALIZERS ============================ */

const comboSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  count: z.number(),
  winCents: z.number(),
});

const txSchema = z.object({
  id: z.number(),
  type: z.string(),
  betCents: z.number(),
  winCents: z.number(),
  combos: z.array(comboSchema),
  multiplier: z.number(),
  freeSpin: z.boolean(),
  balanceAfterCents: z.number(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

const sessionSchema = z.object({
  id: z.number(),
  openedAt: z.string(),
  closedAt: z.string().nullable(),
  status: z.string(),
  openingBalanceCents: z.number(),
  closingBalanceCents: z.number().nullable(),
  cashoutCode: z.string().nullable(),
  cashoutAmountCents: z.number().nullable(),
  totalRechargedCents: z.number(),
  totalBetCents: z.number(),
  totalWonCents: z.number(),
  spinCount: z.number(),
  transactions: z.array(txSchema),
});

type TxRow = typeof schema.transactions.$inferSelect;
type SessionRow = typeof schema.sessions.$inferSelect;

function parseCombos(raw: string | null): ComboAgg[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as ComboAgg[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function txOut(row: TxRow) {
  return {
    id: row.id,
    type: row.type,
    betCents: row.betCents,
    winCents: row.winCents,
    combos: parseCombos(row.combos),
    multiplier: row.multiplier,
    freeSpin: row.freeSpin === 1,
    balanceAfterCents: row.balanceAfterCents,
    note: row.note,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}

function sessionOut(row: SessionRow, txs: TxRow[]) {
  return {
    id: row.id,
    openedAt: new Date(row.openedAt).toISOString(),
    closedAt: row.closedAt ? new Date(row.closedAt).toISOString() : null,
    status: row.status,
    openingBalanceCents: row.openingBalanceCents,
    closingBalanceCents: row.closingBalanceCents,
    cashoutCode: row.cashoutCode,
    cashoutAmountCents: row.cashoutAmountCents,
    totalRechargedCents: row.totalRechargedCents,
    totalBetCents: row.totalBetCents,
    totalWonCents: row.totalWonCents,
    spinCount: row.spinCount,
    transactions: txs.map(txOut),
  };
}

async function loadSessions(db: DB, limit: number, txPerSession: number) {
  const rows = await db.select().from(schema.sessions).orderBy(desc(schema.sessions.id)).limit(limit);
  const out = [];
  for (const s of rows) {
    const txs = await db
      .select()
      .from(schema.transactions)
      .where(eq(schema.transactions.sessionId, s.id))
      .orderBy(desc(schema.transactions.id))
      .limit(txPerSession);
    out.push(sessionOut(s, txs.reverse()));
  }
  return out;
}

/* ============================ ADMIN AUTH ============================ */

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getSetting(db: DB, key: string): Promise<string | null> {
  const rows = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1);
  return rows[0]?.value ?? null;
}

async function setSetting(db: DB, key: string, value: string) {
  await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}

async function issueToken(db: DB): Promise<string> {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await setSetting(db, "admin_token", token);
  await setSetting(db, "admin_token_exp", String(Date.now() + 12 * 3600 * 1000));
  return token;
}

async function requireAdmin(db: DB, token: string) {
  const saved = await getSetting(db, "admin_token");
  const exp = Number((await getSetting(db, "admin_token_exp")) ?? 0);
  if (!saved || saved !== token || Date.now() > exp) {
    throw new Error("ADMIN_NO_AUTORIZADO");
  }
}

/* ============================ SHARED SHAPES ============================ */

const stateShape = z.object({
  balanceCents: z.number(),
  betCents: z.number(),
  fsRemaining: z.number(),
  fsSuper: z.boolean(),
  canSpin: z.boolean(),
  openSessionId: z.number().nullable(),
});

function stateOut(s: typeof schema.gameState.$inferSelect) {
  return {
    balanceCents: s.balanceCents,
    betCents: s.betCents,
    fsRemaining: s.fsRemaining,
    fsSuper: s.fsSuper === 1,
    canSpin: s.balanceCents > 0 || s.fsRemaining > 0,
    openSessionId: null as number | null,
  };
}

const spinResponse = z.object({
  ok: z.boolean(),
  error: z.string().nullable(),
  steps: z.array(
    z.object({
      grid: z.array(z.string()),
      winPositions: z.array(z.number()),
      stepWinCents: z.number(),
    }),
  ),
  topMults: z.array(z.number()),
  multSum: z.number(),
  totalWinCents: z.number(),
  betCents: z.number(),
  freeSpin: z.boolean(),
  scatterCount: z.number(),
  freeSpinsAwarded: z.number(),
  retriggerAdded: z.number(),
  fsSuper: z.boolean(),
  fsRemaining: z.number(),
  fsFinishedTotalWinCents: z.number().nullable(),
  balanceCents: z.number(),
  transactionId: z.number(),
});
type SpinResponse = z.infer<typeof spinResponse>;

function emptySpin(error: string, balanceCents: number): SpinResponse {
  return {
    ok: false,
    error,
    steps: [],
    topMults: [],
    multSum: 0,
    totalWinCents: 0,
    betCents: 0,
    freeSpin: false,
    scatterCount: 0,
    freeSpinsAwarded: 0,
    retriggerAdded: 0,
    fsSuper: false,
    fsRemaining: 0,
    fsFinishedTotalWinCents: null,
    balanceCents,
    transactionId: 0,
  };
}

function cashoutCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  for (const b of bytes) code += chars[b % chars.length];
  return `CL-${code.slice(0, 4)}-${code.slice(4)}`;
}

/* ============================ ACTIONS ============================ */

export const Actions = {
  getPublicState: defineAction({
    description: "Estado del juego desde la base de datos: saldo, apuesta, giros gratis, sesión abierta e historial de sesiones para la vista HISTORIAL del juego.",
    request: z.object({}),
    response: z.object({
      state: stateShape,
      sessions: z.array(sessionSchema),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const s = await ensureState(db);
      const open = await openSession(db);
      const out = stateOut(s);
      out.openSessionId = open?.id ?? null;
      const sessions = await loadSessions(db, 20, 300);
      return { state: out, sessions };
    },
  }),

  setBet: defineAction({
    description: "Guarda en la base de datos la apuesta elegida en el juego (+ / −).",
    request: z.object({ betCents: z.number().int().min(10).max(100000) }),
    response: z.object({ betCents: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureState(db);
      await saveState(db, { betCents: args.betCents });
      return { betCents: args.betCents };
    },
  }),

  spin: defineAction({
    description: "Ejecuta un giro con simulación en el servidor: descuenta la apuesta del saldo en BD (salvo giro gratis), registra la transacción con apuesta, combinaciones, ganancia y saldo actualizado, y devuelve los pasos de cascada para animar.",
    request: z.object({
      betCents: z.number().int().min(10).max(100000),
      freeSpin: z.boolean().default(false),
    }),
    response: spinResponse,
    handler: async (ctx, args): Promise<SpinResponse> => {
      const db = ctx.db<typeof schema>();
      const s = await ensureState(db);

      if (args.freeSpin) {
        if (s.fsRemaining <= 0) return emptySpin("SIN_GIROS_GRATIS", s.balanceCents);
        const bet = s.fsBetCents > 0 ? s.fsBetCents : args.betCents;
        const outcome = simulateSpin(bet, true, s.fsSuper === 1);
        let fsRemaining = s.fsRemaining - 1;
        let retriggerAdded = 0;
        if (outcome.scatterCount >= 3) {
          retriggerAdded = 5 + Math.floor(Math.random() * 6); // +5 a +10
          fsRemaining += retriggerAdded;
        }
        const fsTotal = s.fsTotalWinCents + outcome.totalWinCents;
        const finished = fsRemaining <= 0;
        const newBalance = s.balanceCents + outcome.totalWinCents;
        const session = await ensureSession(db, s.balanceCents);
        const txId = await writeTx(db, {
          sessionId: session.id,
          type: "spin",
          betCents: bet,
          winCents: outcome.totalWinCents,
          combos: outcome.combos,
          multiplier: outcome.multSum,
          freeSpin: true,
          balanceAfterCents: newBalance,
          note: retriggerAdded > 0 ? `Retrigger: +${retriggerAdded} giros gratis` : "Giro gratis",
        });
        await bumpSession(db, session.id, { won: outcome.totalWinCents, spins: 1 });
        await saveState(db, {
          balanceCents: newBalance,
          fsRemaining,
          fsTotalWinCents: finished ? 0 : fsTotal,
          fsSuper: finished ? 0 : s.fsSuper,
          fsBetCents: finished ? 0 : s.fsBetCents,
        });
        ctx.invalidateQueries();
        return {
          ok: true,
          error: null,
          steps: outcome.steps,
          topMults: outcome.topMults,
          multSum: outcome.multSum,
          totalWinCents: outcome.totalWinCents,
          betCents: bet,
          freeSpin: true,
          scatterCount: outcome.scatterCount,
          freeSpinsAwarded: 0,
          retriggerAdded,
          fsSuper: s.fsSuper === 1,
          fsRemaining,
          fsFinishedTotalWinCents: finished ? fsTotal : null,
          balanceCents: newBalance,
          transactionId: txId,
        };
      }

      // Paid spin: the balance in the DB is the only source of truth.
      if (s.fsRemaining > 0) return emptySpin("GIROS_GRATIS_ACTIVOS", s.balanceCents);
      if (s.balanceCents < args.betCents) return emptySpin("SALDO_INSUFICIENTE", s.balanceCents);
      const bet = args.betCents;
      const outcome = simulateSpin(bet, false, false);
      let awarded = 0;
      let superAward = false;
      if (outcome.scatterCount >= 4) {
        awarded = outcome.scatterCount === 4 ? 10 : outcome.scatterCount === 5 ? 15 : 20;
        if (outcome.hasSuperScatter) {
          awarded += 10;
          superAward = true;
        }
      }
      const newBalance = s.balanceCents - bet + outcome.totalWinCents;
      const session = await ensureSession(db, s.balanceCents);
      const txId = await writeTx(db, {
        sessionId: session.id,
        type: "spin",
        betCents: bet,
        winCents: outcome.totalWinCents,
        combos: outcome.combos,
        multiplier: outcome.multSum,
        freeSpin: false,
        balanceAfterCents: newBalance,
        note: awarded > 0 ? `${awarded} giros gratis${superAward ? " SÚPER" : ""}` : null,
      });
      await bumpSession(db, session.id, { bet, won: outcome.totalWinCents, spins: 1 });
      await saveState(db, {
        balanceCents: newBalance,
        betCents: bet,
        fsRemaining: awarded,
        fsTotalWinCents: 0,
        fsBetCents: awarded > 0 ? bet : 0,
        fsSuper: superAward ? 1 : 0,
      });
      ctx.invalidateQueries();
      return {
        ok: true,
        error: null,
        steps: outcome.steps,
        topMults: outcome.topMults,
        multSum: outcome.multSum,
        totalWinCents: outcome.totalWinCents,
        betCents: bet,
        freeSpin: false,
        scatterCount: outcome.scatterCount,
        freeSpinsAwarded: awarded,
        retriggerAdded: 0,
        fsSuper: superAward,
        fsRemaining: awarded,
        fsFinishedTotalWinCents: null,
        balanceCents: newBalance,
        transactionId: txId,
      };
    },
  }),

  buyBonus: defineAction({
    description: "Compra de bonus por 100x la apuesta: descuenta del saldo en BD, registra la transacción y otorga 10 giros base más la ruleta de +5 a +10 (entra con 15 a 20 giros gratis).",
    request: z.object({ betCents: z.number().int().min(10).max(100000) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      costCents: z.number(),
      baseSpins: z.number(),
      rouletteAdd: z.number(),
      totalSpins: z.number(),
      balanceCents: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const s = await ensureState(db);
      const cost = args.betCents * 100;
      if (s.fsRemaining > 0) {
        return { ok: false, error: "GIROS_GRATIS_ACTIVOS", costCents: cost, baseSpins: 0, rouletteAdd: 0, totalSpins: 0, balanceCents: s.balanceCents };
      }
      if (s.balanceCents < cost) {
        return { ok: false, error: "SALDO_INSUFICIENTE", costCents: cost, baseSpins: 0, rouletteAdd: 0, totalSpins: 0, balanceCents: s.balanceCents };
      }
      const baseSpins = 10;
      const rouletteAdd = 5 + Math.floor(Math.random() * 6);
      const totalSpins = baseSpins + rouletteAdd;
      const newBalance = s.balanceCents - cost;
      const session = await ensureSession(db, s.balanceCents);
      await writeTx(db, {
        sessionId: session.id,
        type: "bonus_buy",
        betCents: cost,
        winCents: 0,
        balanceAfterCents: newBalance,
        note: `Compra de bonus: ${totalSpins} giros gratis (10 + ruleta ${rouletteAdd})`,
      });
      await bumpSession(db, session.id, { bet: cost });
      await saveState(db, {
        balanceCents: newBalance,
        fsRemaining: totalSpins,
        fsTotalWinCents: 0,
        fsBetCents: args.betCents,
        fsSuper: 0,
      });
      ctx.invalidateQueries();
      return { ok: true, error: null, costCents: cost, baseSpins, rouletteAdd, totalSpins, balanceCents: newBalance };
    },
  }),

  cashout: defineAction({
    description: "COBRAR: lleva el saldo a cero en la base de datos, cierra la sesión del jugador y crea el reporte del retiro con su código, quedando el historial guardado.",
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      error: z.string().nullable(),
      code: z.string().nullable(),
      amountCents: z.number(),
      sessionId: z.number().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const s = await ensureState(db);
      if (s.fsRemaining > 0) {
        return { ok: false, error: "GIROS_GRATIS_ACTIVOS", code: null, amountCents: 0, sessionId: null };
      }
      if (s.balanceCents <= 0) {
        return { ok: false, error: "SIN_SALDO", code: null, amountCents: 0, sessionId: null };
      }
      const amount = s.balanceCents;
      const code = cashoutCode();
      const session = await ensureSession(db, 0);
      await writeTx(db, {
        sessionId: session.id,
        type: "cashout",
        winCents: amount,
        balanceAfterCents: 0,
        note: `Retiro · COBRAR · Código ${code}`,
      });
      await db
        .update(schema.sessions)
        .set({ status: "closed", closedAt: Date.now(), closingBalanceCents: 0, cashoutCode: code, cashoutAmountCents: amount })
        .where(eq(schema.sessions.id, session.id));
      await saveState(db, { balanceCents: 0, fsRemaining: 0, fsTotalWinCents: 0, fsBetCents: 0, fsSuper: 0 });
      ctx.invalidateQueries();
      return { ok: true, error: null, code, amountCents: amount, sessionId: session.id };
    },
  }),

  adminStatus: defineAction({
    description: "Indica si el panel administrativo ya tiene contraseña creada en la base de datos.",
    request: z.object({}),
    response: z.object({ passwordSet: z.boolean() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const hash = await getSetting(db, "admin_pass_hash");
      return { passwordSet: !!hash };
    },
  }),

  adminSetup: defineAction({
    description: "Crea la contraseña del panel administrativo (solo la primera vez) y devuelve el token de sesión del panel.",
    request: z.object({ password: z.string().min(4).max(64) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), token: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await getSetting(db, "admin_pass_hash");
      if (existing) return { ok: false, error: "YA_EXISTE", token: null };
      await setSetting(db, "admin_pass_hash", await sha256Hex(`cowboyloot:${args.password}`));
      const token = await issueToken(db);
      return { ok: true, error: null, token };
    },
  }),

  adminLogin: defineAction({
    description: "Inicia sesión en el panel administrativo verificando la contraseña contra la base de datos.",
    request: z.object({ password: z.string().min(1).max(64) }),
    response: z.object({ ok: z.boolean(), error: z.string().nullable(), token: z.string().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const hash = await getSetting(db, "admin_pass_hash");
      if (!hash) return { ok: false, error: "SIN_CONTRASENA", token: null };
      const attempt = await sha256Hex(`cowboyloot:${args.password}`);
      if (attempt !== hash) return { ok: false, error: "CONTRASENA_INCORRECTA", token: null };
      const token = await issueToken(db);
      return { ok: true, error: null, token };
    },
  }),

  adminGetPanel: defineAction({
    description: "Datos del panel administrativo desde la BD: saldo restante del juego en vivo, sesión abierta, historial de transacciones por jugador y reportes de retiro.",
    request: z.object({ token: z.string().min(1) }),
    response: z.object({
      state: stateShape,
      sessions: z.array(sessionSchema),
      totals: z.object({
        totalRechargedCents: z.number(),
        totalBetCents: z.number(),
        totalWonCents: z.number(),
        totalCashedOutCents: z.number(),
        withdrawalCount: z.number(),
      }),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireAdmin(db, args.token);
      const s = await ensureState(db);
      const open = await openSession(db);
      const out = stateOut(s);
      out.openSessionId = open?.id ?? null;
      const sessions = await loadSessions(db, 50, 500);
      const all = await db.select().from(schema.sessions);
      const totals = {
        totalRechargedCents: all.reduce((a, x) => a + x.totalRechargedCents, 0),
        totalBetCents: all.reduce((a, x) => a + x.totalBetCents, 0),
        totalWonCents: all.reduce((a, x) => a + x.totalWonCents, 0),
        totalCashedOutCents: all.reduce((a, x) => a + (x.cashoutAmountCents ?? 0), 0),
        withdrawalCount: all.filter((x) => x.cashoutCode).length,
      };
      return { state: out, sessions, totals };
    },
  }),

  adminRecharge: defineAction({
    description: "Recarga de saldo desde el panel: suma el monto al saldo del juego en la base de datos y lo registra como transacción en la sesión del jugador (abre una nueva si la anterior se cerró con COBRAR).",
    request: z.object({ token: z.string().min(1), amountCents: z.number().int().min(1).max(100000000) }),
    response: z.object({ ok: z.boolean(), balanceCents: z.number(), sessionId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireAdmin(db, args.token);
      const s = await ensureState(db);
      const session = await ensureSession(db, s.balanceCents);
      const newBalance = s.balanceCents + args.amountCents;
      await writeTx(db, {
        sessionId: session.id,
        type: "recharge",
        winCents: args.amountCents,
        balanceAfterCents: newBalance,
        note: "Recarga desde el panel administrativo",
      });
      await bumpSession(db, session.id, { recharged: args.amountCents });
      await saveState(db, { balanceCents: newBalance });
      ctx.invalidateQueries();
      return { ok: true, balanceCents: newBalance, sessionId: session.id };
    },
  }),

  adminSetBalance: defineAction({
    description: "Fija el saldo exacto del juego desde el panel (incluido 0): escribe el saldo en la base de datos y registra el ajuste como transacción.",
    request: z.object({ token: z.string().min(1), amountCents: z.number().int().min(0).max(100000000) }),
    response: z.object({ ok: z.boolean(), balanceCents: z.number(), sessionId: z.number().nullable() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await requireAdmin(db, args.token);
      const s = await ensureState(db);
      if (s.fsRemaining > 0) throw new Error("GIROS_GRATIS_ACTIVOS");
      const session = args.amountCents > 0 || s.balanceCents > 0 ? await ensureSession(db, s.balanceCents) : await openSession(db);
      if (session) {
        const delta = args.amountCents - s.balanceCents;
        await writeTx(db, {
          sessionId: session.id,
          type: "set_balance",
          winCents: delta > 0 ? delta : 0,
          betCents: delta < 0 ? -delta : 0,
          balanceAfterCents: args.amountCents,
          note: "Saldo fijado desde el panel administrativo",
        });
        if (delta > 0) await bumpSession(db, session.id, { recharged: delta });
      }
      await saveState(db, { balanceCents: args.amountCents });
      ctx.invalidateQueries();
      return { ok: true, balanceCents: args.amountCents, sessionId: session?.id ?? null };
    },
  }),
} satisfies ActionsModule;
