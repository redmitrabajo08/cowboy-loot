# Cowboy Loot — despliegue gratis en Render + Neon

Paquete autónomo para sacar el juego de la plataforma Muse y montarlo
en un servicio web, con la arquitectura aprobada:

- **Render (plan gratis)** sirve la app: 750 horas/mes sin tarjeta.
  Se duerme tras ~15 minutos sin visitas y tarda ~1 minuto en despertar.
- **Neon (Postgres gratis externo)** guarda los datos: saldo, giros
  gratis, sesiones por jugador, historial de transacciones y reportes
  de COBRAR. Como la base vive fuera de Render, dormir o reiniciar el
  servicio **no borra nada**. (El Postgres gratis de Render expira a los
  30 días y su disco es efímero: por eso NO se usa.)

> Estado: el paquete está **preparado y revisado**, pero todavía **no
> está subido**. La subida necesita las cuentas de Gary (Render y Neon)
> y su confirmación final; las contraseñas nunca se comparten por chat:
> cada quien entra a su cuenta y la cadena de conexión de Neon se pega
> directamente en el panel de Render.

## Contenido de esta carpeta

| Archivo | Qué es |
|---|---|
| `servidor.ts` | Servidor Bun: sirve el cliente y expone `POST /actions`; al arrancar aplica la migración. |
| `acciones-postgres.ts` | Las 11 acciones del juego (copia de `server/src/actions.ts` con 2 imports cambiados). |
| `schema-pg.ts` | Las 4 tablas en Postgres (`game_state`, `sessions`, `transactions`, `settings`). |
| `migracion-postgres.sql` | Crea las tablas en Neon. Idempotente; también se puede correr a mano con `bun run migrar`. |
| `space-sdk-shim.ts` | Sustituto mínimo del SDK de la plataforma para que actions.ts corra fuera de Muse. |
| `render.yaml` | Blueprint de Render (plan free, health check en `/salud`). |
| `package.json` | Dependencias del servidor autónomo (drizzle-orm, postgres, zod). |
| `.env.ejemplo` | Plantilla de variables: `DATABASE_URL` y `PORT`. |
| `CAMBIOS-POSTGRES.md` | Qué cambió de SQLite a Postgres y qué quedó intacto. |

## Pasos para subirlo (cuando Gary lo confirme)

1. **Crear la base en Neon** (neon.tech, cuenta gratis):
   crear un proyecto (ej. `cowboy-loot`) y copiar su cadena de conexión
   (`postgres://...neon.tech/...?sslmode=require`). No pegarla en chats:
   se usa solo en el paso 3.
2. **Subir el proyecto a un repositorio Git** (GitHub) tal como está:
   la raíz del artefacto, con esta carpeta `despliegue/` dentro y el
   cliente ya compilado en `client/dist` (es el build que produce la
   plataforma; si hace falta recompilar, se hace desde el artefacto).
3. **Crear el servicio en Render**: "New +" → "Blueprint" → elegir el
   repositorio. Render lee `despliegue/render.yaml`... ojo: el blueprint
   debe apuntar a la carpeta `despliegue` como raíz del servicio
   (Root Directory: `despliegue`). Al crear el servicio, Render pide el
   valor de `DATABASE_URL`: ahí se pega la cadena de Neon.
4. **Primer arranque**: el servidor aplica `migracion-postgres.sql`
   solo. La base nace vacía y el juego arranca en **saldo 0**, sin
   contraseña de panel: el primer ingreso al PANEL ADMINISTRATIVO pide
   crearla (mínimo 4 caracteres), igual que en el artefacto.
5. **Probar**: recargar saldo desde el panel, hacer un giro en el juego
   y confirmar que aparece en el historial del panel.
6. **(Opcional) Historial actual**: este paquete arranca con historial
   vacío. Copiar las sesiones/transacciones que ya existen en el
   artefacto es un paso aparte de exportación; no se hace sin pedirlo.

## Desarrollo local (la otra ruta: servidor en la PC de Gary)

El mismo paquete corre en local, sin Render ni Neon:

```sh
cd despliegue
cp .env.ejemplo .env   # y poner un DATABASE_URL de un Postgres local o de Neon
bun install
bun run start          # http://localhost:3000
```

## Límites honestos del plan gratis

- Render gratis **se duerme**: la primera visita tras 15 min sin uso
  tarda ~1 minuto. Jugando seguido no se nota.
- Neon gratis pausa la base tras un rato sin uso y despierta en
  segundos con la primera consulta; los datos persisten.
- Sin dominio propio: la dirección será del tipo
  `cowboy-loot.onrender.com`.
