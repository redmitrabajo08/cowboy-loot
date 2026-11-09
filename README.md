# Cowboy Loot — repositorio para Render + Neon

Este es el paquete listo para el repositorio **redmitrabajo08/cowboy-loot**.

## Qué contiene

- `client/dist/` — el juego ya compilado (visual, animaciones y sonido originales, con panel e historial).
- `despliegue/` — el servidor autónomo para Render: `servidor.ts`, `acciones-postgres.ts`, `schema-pg.ts`, `migracion-postgres.sql`, `space-sdk-shim.ts`, `render.yaml`, `package.json`, `.env.ejemplo`, `README.md` y `CAMBIOS-POSTGRES.md`.

## Decisiones ya confirmadas

- Base de datos **desde cero**: saldo 0, sin sesiones ni historial copiado. La contraseña del panel se crea al entrar por primera vez y la primera recarga se manda desde el panel.
- Acceso al juego: **solo Gary y un amigo** con el enlace. El panel administrativo es solo de Gary, con su contraseña.
- La `DATABASE_URL` de Neon **nunca va en este repositorio ni por chat**: se pega solo dentro de Render, en Environment.

## Siguiente paso

Seguir `INSTRUCCIONES-SUBIDA.md` paso a paso.
