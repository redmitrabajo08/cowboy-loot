# Cambios SQLite → Postgres (qué se tocó y qué NO)

El artefacto Muse guarda los datos en SQLite a través de la plataforma
(`ctx.db`). El despliegue en Render no puede usar ese SQLite: el disco de
Render gratis es efímero y los datos se perderían en cada reinicio. Por
eso el paquete autónomo usa **Postgres externo (Neon)**, que no expira a
los 30 días como el Postgres gratis de Render.

## Lo que cambia

| Pieza | Artefacto (SQLite) | Paquete autónomo (Postgres) |
|---|---|---|
| Esquema | `server/src/schema.ts` (`sqliteTable`) | `despliegue/schema-pg.ts` (`pgTable`) |
| Migraciones | `drizzle/0001`–`0003` (SQL de SQLite) | `despliegue/migracion-postgres.sql` (idempotente, se aplica sola al arrancar el servidor) |
| Ids autoincrementales | `INTEGER PRIMARY KEY AUTOINCREMENT` | `SERIAL PRIMARY KEY` |
| Montos y tiempos | `INTEGER` (SQLite no desborda en la práctica) | `BIGINT` con `mode: "number"` |
| Driver | `ctx.db` de la plataforma | `drizzle-orm/postgres-js` + `postgres`, con `DATABASE_URL` |
| SDK de la plataforma | `@hatch/space-sdk` (ruta local, no publicable) | `despliegue/space-sdk-shim.ts` (sustituto mínimo) |
| Servidor HTTP | Lo pone la plataforma Muse | `despliegue/servidor.ts` (Bun: estáticos + `POST /actions`) |
| Reseteo de contraseña (0003) | Migración aplicada una vez | No hace falta: la base nueva nace sin contraseña y se crea al primer ingreso. Equivalente manual en Neon: `DELETE FROM settings WHERE key IN ('admin_pass_hash','admin_token','admin_token_exp');` |

## Lo que NO cambia

- `acciones-postgres.ts` es `server/src/actions.ts` con **solo dos líneas
  de import distintas** (SDK → shim, esquema → schema-pg). El motor del
  slot (símbolos, pesos, tabla de pagos, cascadas, multiplicadores),
  las 11 acciones y todas las reglas son idénticas:
  - El saldo nace en **0** y solo entra desde el panel (recarga o fijar saldo).
  - Cada giro es una transacción; los ganadores guardan apuesta,
    combinación, ganancia total y saldo actualizado.
  - COBRAR lleva el saldo a cero, cierra la sesión del jugador y guarda
    el reporte del retiro (código + monto); la siguiente recarga abre
    una sesión nueva.
- El cliente es el mismo build del artefacto (`client/dist`): juego,
  panel e historial sin cambios, con su visual, animaciones y sonido.
- Los booleanos `fs_super` y `free_spin` se quedan como enteros 0/1 en
  Postgres a propósito, para no tocar ni una línea de la lógica.

## Por qué Neon y no el Postgres de Render

El Postgres gratis de Render expira a los 30 días. Neon tiene nivel
gratis persistente, así que aunque Render se duerma o reinicie, el saldo,
los giros gratis en curso y todo el historial quedan guardados fuera.
