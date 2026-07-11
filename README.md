# limitARR

Servicio que se sienta junto a Seerr y Tautulli en tu stack *arr y sustituye
el modo "auto-approve todo / manual todo" de Seerr por aprobación automática
basada en **cupo**: cada usuario tiene un número máximo de películas
pendientes de ver por biblioteca; pedir consume cupo, verlas lo devuelve.

Alcance actual: solo **películas** (estándar y 4K como bibliotecas
separadas, según el flag `is4k` de Seerr). El límite se calcula por
usuario + biblioteca. Un override manual por usuario+biblioteca puede
fijar un límite distinto del de la biblioteca (incluido 0, para bloquear
del todo), a mano o de golpe para todos los usuarios.

## Estructura

- `server/` — API Node.js/Express, SQLite (better-sqlite3), scheduler que
  sondea solicitudes pendientes en Seerr cada minuto.
- `web/` — panel admin React + Vite + Tailwind, estética tipo Seerr en
  rojo. Se sirve como estático desde el backend en producción.
- `Dockerfile` — build multi-stage, imagen final expone `:5150`.
- `compose.snippet.yml` — bloque de ejemplo para añadir al
  `docker-compose.yml` del host que ya corre seerr/tautulli.

## Desarrollo local

```bash
cp .env.example server/.env   # opcional, ver más abajo
cd server && npm install && npm run dev   # :5150

cd ../web && npm install && npm run dev   # :5173, proxy a /api -> :5150
```

> Nota: `better-sqlite3` compila nativo. Si tu Node local es muy reciente
> (25.x) puede fallar el build por falta de binario precompilado — no
> afecta al build de Docker, que fija Node 20. En macOS con Homebrew:
> `brew install node@22` y `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.

## Despliegue

En el host donde corre el resto del stack (`docker-compose.yml` con
seerr/tautulli):

1. Copia esta carpeta como `limitarr/` junto al `docker-compose.yml`
   existente (o publica la imagen y referencia `image:` en vez de `build:`).
2. Añade el bloque de `compose.snippet.yml` al `docker-compose.yml`.
3. `docker compose up -d limitarr`.
4. Abre el panel en `http://<host>:5150` — como no hay contraseña
   definida, pedirá crearla en el primer acceso.
5. Pestaña **Configuración**: URL + API key de Seerr y Tautulli (si no
   se rellenaron por env, ver abajo).
6. Pestaña **Bibliotecas**: pulsa "Sincronizar desde Tautulli" para
   descubrirlas, márcalas `standard`/`4k` y ponles el límite por defecto.
7. Si ya había solicitudes aprobadas antes de instalarlo (o admins
   aprobando a mano en Seerr), pestaña **Cupo** → "Importar historial de
   Seerr" para que cuenten desde ya.
8. En Seerr, cambia el modo de aprobación de películas a **manual** — es
   limitARR quien aprobará vía API según el cupo disponible.

Todo lo de conexión (Seerr/Tautulli, contraseña de admin, secreto de
sesión) se puede fijar por variables de entorno la primera vez
(`.env.example`), pero después vive en la base de datos y se edita desde
el panel — no hace falta tocar env vars ni reiniciar el contenedor para
cambiarlo.

## Cupo

```
saldo = límite − (películas aprobadas para ese usuario en esa biblioteca que aún no ha visto)
```

- `límite` es el que tenga la biblioteca (pestaña "Bibliotecas"), salvo
  que exista un override para ese usuario+biblioteca (pestaña
  "Overrides", individual o aplicado a todos de golpe), que manda directo.
- Cada solicitud aprobada resta 1 del saldo. Cada película de esa
  solicitud que el usuario termina de ver (≥85% en Tautulli) libera 1 de
  vuelta — no hay que hacer nada manual, se recalcula solo en cada ciclo.
  El saldo nunca baja de 0.
- Si el saldo llega a 0, las nuevas solicitudes se quedan pendientes de
  revisión manual en Seerr hasta que el usuario vea algo (o hasta que
  subas su cupo/override).
- El saldo se recalcula en vivo a partir del historial de Tautulli y el
  registro de decisiones — no es un contador que se pueda desincronizar.
- Botón "resetear" por usuario+biblioteca en la pestaña Cupo: da por
  vistas las pendientes actuales sin esperar a que el usuario las vea de
  verdad (sin borrar el historial del registro).

## Panel

- **Cupo**: tarjetas por usuario ordenadas por peor saldo, con buscador,
  barra de saldo por biblioteca y las carátulas (TMDB) de lo que cada uno
  tiene pendiente de ver. Cabecera con KPIs (usuarios, películas sin ver,
  usuarios sin saldo, aprobadas/bloqueadas en 7 días). Se refresca solo
  cada minuto.
- **Registro**: filtrable por decisión y por texto (usuario o título),
  con paginación ("cargar más") y carátula junto al título.

### Auto-limpieza de cupo atascado

Si una solicitud aprobada nunca llega a buen puerto, no se queda
ocupando cupo para siempre:

- **Cancelada por el usuario en Seerr**: se detecta y se libera el hueco
  en el siguiente ciclo.
- **Radarr nunca la encuentra**: pasado `STUCK_REQUEST_GRACE_DAYS` (7
  días por defecto) sin llegar a "disponible", se libera sola. Una que sí
  llegó a estar disponible nunca se libera por antigüedad — sigue
  contando hasta que el usuario la vea de verdad.

## Notificaciones (Telegram)

Pestaña **Notificaciones**: token de bot (créalo con `@BotFather`), y
elige si el aviso de "sin cupo" va por **DM** al usuario o a un **grupo
con topics**. El botón "Buscar chats nuevos" descubre chat_id/topic_id
sin tener que copiarlos a mano — basta con que el usuario le escriba algo
al bot, o con escribir en el topic que quieras usar.

El aviso no lista el contenido pendiente directamente: lleva un botón
"Ver pendientes" que, al pulsarlo, responde al momento con las carátulas
(vía TMDB) de lo que le falta por ver.

## Pendiente / no incluido en esta primera versión

- Series (Sonarr/Radarr solo cubre películas por ahora).
- Rechazo automático (solo se auto-aprueba o se deja pendiente para
  revisión manual; nunca se declina en nombre del usuario).
- No hay forma de bloquear una aprobación hecha directamente en el panel
  de Seerr (p.ej. un admin aprobando a mano, o pidiendo "como otro
  usuario" con permisos de aprobación) — eso es nativo de Seerr y queda
  fuera del alcance de limitARR. Sí se recoge después vía "Importar
  historial de Seerr".
