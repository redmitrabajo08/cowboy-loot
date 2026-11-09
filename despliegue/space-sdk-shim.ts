// Shim mínimo de `@hatch/space-sdk` para el paquete autónomo.
//
// En el artefacto, `server/src/actions.ts` importa `defineAction`, `z` y
// los tipos `ActionsModule` / `SpaceDb` desde `@hatch/space-sdk`, que es
// un paquete local de la plataforma Muse y NO existe en Render. Este
// archivo lo sustituye para que el MISMO actions.ts funcione fuera:
//
// - `defineAction` deja de registrar la acción en la plataforma y pasa a
//   ser la identidad: devuelve la definición tal cual, y el servidor
//   (servidor.ts) llama a `handler(ctx, args)` directamente.
// - `z` se reexporta desde `zod`, igual que hace el SDK.
// - `SpaceDb` es el tipo de la base de datos drizzle sobre Postgres
//   (postgres.js), con el esquema de `schema-pg.ts`.
// - `ActionsModule` es solo un tipo de forma; en tiempo de ejecución no
//   se usa.
//
// En el paquete autónomo, el import de actions.ts cambia una sola línea:
//   import { defineAction, z, type ActionsModule, type SpaceDb } from "./space-sdk-shim";
// y el import del esquema:
//   import * as schema from "./schema-pg";

import { drizzle } from "drizzle-orm/postgres-js";
import type * as schema from "./schema-pg";

export { z } from "zod";

export type SpaceDb<S = typeof schema> = ReturnType<typeof drizzle<S>>;

// Forma laxa a propósito: el paquete autónomo corre con Bun, que ejecuta
// el TypeScript sin compuerta de tipos, igual que el servidor de la
// plataforma valida las respuestas con los esquemas zod en tiempo de
// ejecución (esos esquemas SÍ viajan en actions.ts y se conservan).
export type ActionsModule = Record<string, { handler: (...args: never[]) => unknown }>;

export function defineAction<D>(def: D): D {
  return def;
}
