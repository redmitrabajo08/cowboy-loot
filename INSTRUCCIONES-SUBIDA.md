# Instrucciones de subida — Cowboy Loot (GitHub → Render + Neon)

Repositorio destino: **redmitrabajo08/cowboy-loot** (ya creado por Gary).
Cuentas ya listas: Render y Neon con Google; proyecto `cowboy-loot` ya creado en Neon.

## 1. Subir este paquete a GitHub (desde Chrome)

1. Descarga y descomprime el ZIP `cowboy-loot-despliegue.zip`. Queda una carpeta `cowboy-loot/` con `client/` y `despliegue/` dentro.
2. En GitHub, entra al repositorio `cowboy-loot`.
3. Pulsa **Add file → Upload files**.
4. Arrastra **el contenido de dentro** de la carpeta `cowboy-loot/` (las carpetas `client` y `despliegue`, más `README.md`, `INSTRUCCIONES-SUBIDA.md` y `.gitignore`), no la carpeta entera, para que queden en la raíz del repositorio.
5. Pulsa **Commit changes**.

Al terminar, la raíz del repositorio debe mostrar: `client`, `despliegue`, `README.md`, `INSTRUCCIONES-SUBIDA.md`, `.gitignore`.

## 2. Crear el servicio en Render

1. En Render: **New + → Blueprint**.
2. Conecta el repositorio `cowboy-loot`.
3. Si Render pide la carpeta del blueprint / Root Directory, usa `despliegue` (ahí está `render.yaml`).
4. Cuando pida `DATABASE_URL`, pega ahí la cadena de conexión de tu proyecto `cowboy-loot` en Neon. Solo ahí: nunca en GitHub ni por chat.
5. Crea el servicio (plan Free). El primer arranque aplica solo `migracion-postgres.sql` y la base nace vacía.

## 3. Primera prueba

1. Abre el enlace que dé Render (será tipo `cowboy-loot.onrender.com`; la primera visita puede tardar ~1 minuto porque el plan gratis se duerme).
2. Entra al PANEL ADMINISTRATIVO y crea tu contraseña (mínimo 4 caracteres).
3. Manda la primera recarga desde el panel, haz un giro en el juego y confirma que el giro aparece en el historial del panel.

Si algo falla en el paso 2, no borres el repositorio: anota el mensaje exacto de Render y avisa a Muse.
