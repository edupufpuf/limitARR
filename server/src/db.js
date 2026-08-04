import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS libraries (
    id INTEGER PRIMARY KEY,           -- Tautulli section_id
    name TEXT NOT NULL,
    section_type TEXT NOT NULL,       -- 'movie' | 'show'
    kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', '4k')),
    enabled INTEGER NOT NULL DEFAULT 1,
    default_limit INTEGER NOT NULL DEFAULT 4  -- max solicitudes sin ver simultáneas, por usuario
  );

  CREATE TABLE IF NOT EXISTS overrides (
    user_id INTEGER NOT NULL,         -- Tautulli user_id
    library_id INTEGER NOT NULL,
    limit_override INTEGER NOT NULL,
    note TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, library_id)
  );

  CREATE TABLE IF NOT EXISTS quota_cache (
    user_id INTEGER NOT NULL,
    library_id INTEGER NOT NULL,
    limit_applied INTEGER NOT NULL,
    outstanding INTEGER NOT NULL,     -- aprobadas y aún no vistas
    balance INTEGER NOT NULL,         -- limit_applied - outstanding
    computed_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, library_id)
  );

  CREATE TABLE IF NOT EXISTS decisions_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    library_id INTEGER,
    media_title TEXT,
    media_type TEXT NOT NULL DEFAULT 'movie',
    tmdb_id INTEGER,
    season_number INTEGER,
    balance_before INTEGER,
    limit_applied INTEGER,
    decision TEXT NOT NULL,           -- 'approved' | 'no_quota' | 'no_library_config' | 'unmatched_user'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    voided_at TEXT                    -- rellenado si la solicitud se canceló en Seerr tras aprobarse, o se quitó a mano del cupo
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS telegram_links (
    user_id INTEGER PRIMARY KEY,      -- Tautulli user_id
    chat_id TEXT NOT NULL,
    label TEXT,
    linked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Marca de "reset manual" por usuario+biblioteca: solo cuentan como pendientes
  -- las aprobaciones posteriores a esta fecha (botón "Resetear" en la pestaña Cupo).
  CREATE TABLE IF NOT EXISTS quota_resets (
    user_id INTEGER NOT NULL,
    library_id INTEGER NOT NULL,
    reset_at TEXT NOT NULL,
    PRIMARY KEY (user_id, library_id)
  );

  -- Grupos de usuarios para poner límites por grupo en vez de uno a uno.
  -- Un usuario pertenece como mucho a UN grupo (PK de group_members): así el
  -- límite efectivo es determinista sin reglas de desempate entre grupos.
  -- Precedencia: override individual > override de grupo > límite de biblioteca.
  -- aggregated=1 (issue #4): el grupo entero cuenta como UN solo usuario — cupo
  -- compartido entre los miembros, y en quota_cache/quota_resets se representa
  -- con user_id = -id (los ids de Tautulli son siempre positivos).
  CREATE TABLE IF NOT EXISTS groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aggregated INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS group_members (
    user_id INTEGER PRIMARY KEY,      -- Tautulli user_id
    group_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_overrides (
    group_id INTEGER NOT NULL,
    library_id INTEGER NOT NULL,
    limit_override INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, library_id)
  );

  -- Módulo Maintainerr: registro de "salvadas" (quién pulsó 💾 Salvar en Telegram
  -- para sacar una película de la colección de borrado). user_id se resuelve via
  -- telegram_links si el que pulsa está vinculado en "Mis avisos"; si no, NULL.
  CREATE TABLE IF NOT EXISTS salvados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_server_id TEXT NOT NULL,
    tmdb_id INTEGER,
    title TEXT,
    poster_url TEXT,
    telegram_user_id TEXT NOT NULL,
    telegram_name TEXT,
    user_id INTEGER,                  -- Tautulli user_id, NULL si no hay vínculo
    library_id INTEGER,
    saved_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Mensajes normales (no callbacks) recibidos por el bot, para que el panel
  -- pueda "descubrir" chats/topics sin tener que llamar a Telegram en vivo.
  CREATE TABLE IF NOT EXISTS telegram_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    chat_type TEXT NOT NULL,
    chat_title TEXT,
    message_thread_id INTEGER,
    username TEXT,
    first_name TEXT,
    text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Maintainerr solo dispara su webhook "Media Added" cuando es su propio
  -- motor de reglas el que mete el media en la colección de borrado — una
  -- alta manual (arrastrar un ítem a la colección a mano) no lo dispara y se
  -- quedaba sin aviso de Telegram. Este registro es la marca de "ya avisado"
  -- para el sondeo de respaldo (pollMaintainerrCollections en maintainerr.js),
  -- que revisa las colecciones origen periódicamente y avisa de lo que el
  -- webhook se haya saltado, sin duplicar avisos ya mandados.
  CREATE TABLE IF NOT EXISTS maintainerr_notified (
    media_server_id TEXT NOT NULL,
    collection_id INTEGER NOT NULL,
    notified_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (media_server_id, collection_id)
  );
`);

// Migraciones para bases de datos ya desplegadas antes de que existiera la columna.
function addColumnIfMissing(sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }
}

addColumnIfMissing('ALTER TABLE decisions_log ADD COLUMN voided_at TEXT');
// Póster TMDB de la película, para mostrarla en el panel (Cupo y Registro).
addColumnIfMissing('ALTER TABLE decisions_log ADD COLUMN poster_url TEXT');
// JSON [{title, mediaType, tmdbId, seasonNumber, posterUrl}] con el contenido que
// está consumiendo el cupo, para que la pestaña Cupo enseñe QUÉ tiene pendiente.
addColumnIfMissing('ALTER TABLE quota_cache ADD COLUMN pending_items TEXT');
addColumnIfMissing("ALTER TABLE decisions_log ADD COLUMN media_type TEXT NOT NULL DEFAULT 'movie'");
addColumnIfMissing('ALTER TABLE decisions_log ADD COLUMN season_number INTEGER');
// Issue #4: cupo grupal agregado (el grupo cuenta como un solo usuario).
addColumnIfMissing('ALTER TABLE groups ADD COLUMN aggregated INTEGER NOT NULL DEFAULT 0');
// Issue #10: caducidad — pasados N días sin ver, el pendiente deja de contar.
// NULL = usar el default del código (30); 0 = sin caducidad. Misma precedencia
// que el límite: override individual > override de grupo > biblioteca.
addColumnIfMissing('ALTER TABLE libraries ADD COLUMN expiry_days INTEGER');
// Issue #13: solicitudes de series de temporada en temporada. Con el toggle
// activo, una solicitud con más de una temporada se rechaza en Seerr con aviso.
addColumnIfMissing('ALTER TABLE libraries ADD COLUMN one_season_per_request INTEGER NOT NULL DEFAULT 0');
// Issue #13 (fase 2): cola secuencial — un usuario solo puede tener UNA
// temporada sin ver de cada serie; las siguientes esperan en Seerr y se
// aprueban al terminar la anterior. Implica rechazar multi-temporada.
addColumnIfMissing('ALTER TABLE libraries ADD COLUMN sequential_seasons INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE overrides ADD COLUMN expiry_override INTEGER');
addColumnIfMissing('ALTER TABLE group_overrides ADD COLUMN expiry_override INTEGER');
// Motivo del cargo manual (por qué se resta cupo por algo sin tmdb_id): texto
// libre puesto por el admin al crearlo, para saber luego por qué está ahí.
addColumnIfMissing('ALTER TABLE decisions_log ADD COLUMN note TEXT');

// Issue de jesusgarrigues (20 jul 2026): quitar del cupo y resetear deben
// quedar en el Registro y poder deshacerse. Se loguean como filas nuevas
// ('dismissed'/'reset', ver dismissPendingItem/resetQuota en quota.js) en vez
// de tocar las filas 'approved' ya existentes — así el registro histórico no
// se reescribe, solo se añade el evento. undo_data guarda lo necesario para
// deshacer exactamente (ids de las filas anuladas, o el reset_at anterior);
// undone_at se rellena al deshacer, para no poder deshacer dos veces.
addColumnIfMissing('ALTER TABLE decisions_log ADD COLUMN undo_data TEXT');
addColumnIfMissing('ALTER TABLE decisions_log ADD COLUMN undone_at TEXT');

// v2: cupo mensual — tope de cosas aprobadas en el mes en curso, independiente
// de si se han visto o no. Desactivado por defecto; se activa por biblioteca
// desde la pestaña Cupo. monthly_limit_override sigue la misma precedencia que
// limit_override (individual > grupo > rol > biblioteca), 0 = bloquear el mes entero.
addColumnIfMissing('ALTER TABLE libraries ADD COLUMN monthly_quota_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE libraries ADD COLUMN monthly_limit INTEGER NOT NULL DEFAULT 10');
addColumnIfMissing('ALTER TABLE overrides ADD COLUMN monthly_limit_override INTEGER');
addColumnIfMissing('ALTER TABLE group_overrides ADD COLUMN monthly_limit_override INTEGER');
addColumnIfMissing('ALTER TABLE quota_cache ADD COLUMN monthly_enabled INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('ALTER TABLE quota_cache ADD COLUMN monthly_limit INTEGER');
addColumnIfMissing('ALTER TABLE quota_cache ADD COLUMN monthly_used INTEGER');

// v2: roles — igual que los grupos, un usuario tiene como mucho un rol
// (user_roles.user_id es PK), y el rol da valores por defecto de límite,
// caducidad y cupo mensual por biblioteca. Precedencia: override individual >
// override de grupo > ROL > límite de biblioteca (el rol es un escalón nuevo
// justo antes del valor de biblioteca, no sustituye a los overrides puntuales).
db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS user_roles (
    user_id INTEGER PRIMARY KEY,      -- Tautulli user_id
    role_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS role_overrides (
    role_id INTEGER NOT NULL,
    library_id INTEGER NOT NULL,
    limit_override INTEGER,
    expiry_override INTEGER,
    monthly_limit_override INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (role_id, library_id)
  );

  -- v2: temporizador de aprobación — aplaza UNA solicitud concreta (no una
  -- norma general del usuario) hasta hold_until, aunque haya cupo de sobra.
  -- Se limpia sola cuando el ciclo de sondeo la encuentra ya cumplida.
  CREATE TABLE IF NOT EXISTS request_holds (
    request_id INTEGER PRIMARY KEY,
    hold_until TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- v3: cupo mensual TOTAL — a diferencia del mensual por biblioteca (arriba),
  -- este suma TODAS las bibliotecas combinadas contra un único tope. Se activa
  -- y edita en Ajustes (settings: monthly_total_quota_enabled/monthly_total_limit,
  -- ver settings.js); estas tablas solo guardan los overrides, con la misma
  -- precedencia que el resto (individual > grupo > rol > global). Sin
  -- library_id: un único cupo por usuario/grupo/rol, no uno por biblioteca.
  -- 0 = bloquear el mes entero.
  CREATE TABLE IF NOT EXISTS monthly_total_overrides (
    user_id INTEGER PRIMARY KEY,
    limit_override INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_monthly_total_overrides (
    group_id INTEGER PRIMARY KEY,
    limit_override INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS role_monthly_total_overrides (
    role_id INTEGER PRIMARY KEY,
    limit_override INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Pedido de Edu (2 ago 2026): al quitar un pendiente del cupo (no lo vio),
  -- opción de penalizar reduciendo temporalmente su capacidad. kind='normal'
  -- resta del límite de pendientes de esa biblioteca; kind='monthly' resta del
  -- cupo mensual — de esa biblioteca si el modo es 'per_library', o del total
  -- (library_id NULL) si el modo es 'total'. Varias penalizaciones activas a la
  -- vez se SUMAN (pedido explícito de Edu). Caduca sola en ends_at, sin pantalla
  -- de gestión en v1 (Edu no la pidió) — el user_id es el cacheId de
  -- quotaIdentity, igual que en overrides (real o -group_id).
  CREATE TABLE IF NOT EXISTS penalties (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    library_id INTEGER,
    kind TEXT NOT NULL,
    holes INTEGER NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ends_at TEXT NOT NULL
  );

  -- Pedido de Edu (2 ago 2026): cortar la sesión de Plex más nueva si el mismo
  -- usuario tiene dos (o más) a la vez, avisando. Activado por defecto (sin
  -- fila = activado, ver sessionGuard.js) — cada usuario lo desactiva él mismo
  -- desde su panel si de verdad comparte cuenta entre dos pantallas a propósito.
  -- Los admins (is_admin de Tautulli) nunca se cortan, tengan esto o no.
  CREATE TABLE IF NOT EXISTS session_guard_settings (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Pedido de Edu (4 ago 2026): con sequential_seasons, una solicitud de varias
  -- temporadas de golpe (ej. Ted Lasso 2+3+4) ya no se rechaza entera — se
  -- aprueba solo la más baja en Seerr y el resto se guarda aquí. processSeasonQueue
  -- (scheduler.js) crea la solicitud de la siguiente temporada en Seerr en cuanto
  -- la actual sale de pendientes (vista). Una fila por temporada en espera.
  CREATE TABLE IF NOT EXISTS season_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL,
    user_id INTEGER NOT NULL,         -- Tautulli user_id, para comprobar pendingItems
    seerr_user_id INTEGER,            -- para crear la solicitud siguiente como este usuario en Seerr
    library_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Roles por defecto pedidos por Edu: se siembran una sola vez si la tabla está
// vacía (una instalación nueva, o la primera vez que esta versión arranca).
// Nacen sin overrides — el admin los rellena por biblioteca en Overrides.
if (db.prepare('SELECT COUNT(*) AS n FROM roles').get().n === 0) {
  const insertRole = db.prepare('INSERT INTO roles (name) VALUES (?)');
  for (const name of ['Usuario', 'Amigo', 'Invitado', 'Admin']) insertRole.run(name);
}

// decisions_log se consulta en cada ciclo y crece sin límite; sin índices,
// todo son full scans. El parcial cubre la consulta caliente (aprobadas
// vivas de un usuario+biblioteca); los otros dos, el registro paginado/KPIs
// (created_at) y la deduplicación por solicitud (request_id).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_decisions_pending
    ON decisions_log (user_id, library_id, created_at)
    WHERE decision = 'approved' AND voided_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions_log (created_at);
  CREATE INDEX IF NOT EXISTS idx_decisions_request ON decisions_log (request_id);
`);
