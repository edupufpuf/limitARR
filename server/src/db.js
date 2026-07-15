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
