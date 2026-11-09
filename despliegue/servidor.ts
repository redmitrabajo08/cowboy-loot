// Servidor autónomo de Cowboy Loot para Render (Bun + Postgres/Neon).
//
// Qué hace:
// - Sirve el cliente compilado desde ./public (el build del artefacto).
// - Expone POST /actions con el mismo contrato que usa el cliente del
//   artefacto: el cuerpo es { action: string, args: object } y la
//   respuesta es el JSON que devuelve el handler de esa acción.
// - Conecta a Postgres (Neon) con la variable de entorno DATABASE_URL y
//   construye el `ctx` que actions.ts espera: ctx.db<typeof schema>()
//   devuelve el cliente drizzle y ctx.invalidateQueries() es un no-op
//   (fuera de la plataforma no hay caché de consultas que invalidar; el
//   cliente ya sondea cada 2 s).
// - Al arrancar ejecuta migracion-postgres.sql (idempotente) para crear
//   las tablas si la base de Neon está vacía. El saldo arranca en 0 y
//   solo entra desde el panel, igual que en el artefacto.
//
// Requisitos en el paquete (ver README.md y CAMBIOS-POSTGRES.md):
// - acciones-postgres.ts: copia de server/src/actions.ts con los DOS
//   imports cambiados (SDK -> ./space-sdk-shim, esquema -> ./schema-pg).
// - schema-pg.ts, space-sdk-shim.ts y migracion-postgres.sql (incluidos).
// - public/: el cliente compilado (client/dist del artefacto).
//
// Variables de entorno:
// - DATABASE_URL  cadena de conexión de Neon (obligatoria).
// - PORT          puerto que asigna Render (por defecto 10000 en local 3000).

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema-pg";
import { Actions } from "./acciones-postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Falta la variable de entorno DATABASE_URL (cadena de conexión de Neon).");
  process.exit(1);
}

const client = postgres(DATABASE_URL, { max: 5 });
const db = drizzle(client, { schema });

// Crear las tablas si no existen (la migración es idempotente).
const migrationSql = await Bun.file(new URL("./migracion-postgres.sql", import.meta.url)).text();
await client.unsafe(migrationSql);
console.log("Base de datos lista (migración Postgres aplicada).");

// ctx compatible con el que actions.ts recibe en la plataforma Muse.
const ctx = {
  db: <S,>() => db as unknown as ReturnType<typeof drizzle<S>>,
  invalidateQueries: () => {},
};

type ActionDef = { handler: (c: typeof ctx, args: Record<string, unknown>) => Promise<unknown> };
const actions = Actions as unknown as Record<string, ActionDef>;

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/actions" && req.method === "POST") {
      try {
        const body = (await req.json()) as { action?: string; args?: Record<string, unknown> };
        const def = body.action ? actions[body.action] : undefined;
        if (!def) {
          return Response.json({ error: `Acción desconocida: ${body.action ?? ""}` }, { status: 404 });
        }
        const result = await def.handler(ctx, body.args ?? {});
        return Response.json(result ?? {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Error interno";
        // Los errores de negocio de actions.ts (ADMIN_NO_AUTORIZADO,
        // GIROS_GRATIS_ACTIVOS, ...) llegan como mensaje; el cliente del
        // panel ya sabe reaccionar a un fallo de la petición.
        return Response.json({ error: msg }, { status: 400 });
      }
    }

    if (url.pathname === "/salud") {
      return Response.json({ ok: true });
    }

    // Cliente estático: cualquier otra ruta sirve ./public, con
    // index.html como respaldo (app de una sola página).
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(new URL(`./public${path}`, import.meta.url));
    if (await file.exists()) return new Response(file);
    const index = Bun.file(new URL("./public/index.html", import.meta.url));
    if (await index.exists()) return new Response(index, { headers: { "Content-Type": "text/html" } });
    return new Response("No encontrado", { status: 404 });
  },
});

console.log(`Cowboy Loot escuchando en el puerto ${port}`);
