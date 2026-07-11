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
    section_type TEXT NOT NULL,       -- 'movie' (only type currently acted on)
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
    tmdb_id INTEGER,
    balance_before INTEGER,
    limit_applied INTEGER,
    decision TEXT NOT NULL,           -- 'approved' | 'no_quota' | 'no_library_config' | 'unmatched_user'
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    voided_at TEXT                    -- rellenado si la solicitud se canceló en Seerr tras aprobarse
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
// JSON [{title, tmdbId, posterUrl}] con las películas que están consumiendo el
// cupo, para que la pestaña Cupo enseñe QUÉ tiene pendiente cada usuario.
addColumnIfMissing('ALTER TABLE quota_cache ADD COLUMN pending_items TEXT');
