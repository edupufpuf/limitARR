import { db } from './db.js';

const KEYS = [
  'seerr_url',
  'seerr_api_key',
  'seerr_public_url',
  'tautulli_url',
  'tautulli_api_key',
  'tautulli_public_url',
  'tv_season_watched_percent',
];
const URL_KEYS = new Set(['seerr_url', 'seerr_public_url', 'tautulli_url', 'tautulli_public_url']);
// Claves opcionales: enviar cadena vacía las borra (en el resto, vacío = "no cambiar",
// para poder guardar sin reenviar API keys ya configuradas).
const CLEARABLE_KEYS = new Set(['seerr_public_url', 'tautulli_public_url', 'tv_season_watched_percent']);
// Issue #9: % de episodios vistos para dar una temporada por vista. Solo se
// guarda si es un entero 1-100; vacío la borra (vuelve al default del código).
const PERCENT_KEYS = new Set(['tv_season_watched_percent']);

function normalize(key, value) {
  const trimmed = value.trim();
  return URL_KEYS.has(key) ? trimmed.replace(/\/$/, '') : trimmed;
}

const upsert = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);
const getStmt = db.prepare('SELECT value FROM settings WHERE key = ?');

// One-time seed from env vars, so existing .env-based deployments keep working
// until someone edits values from the panel.
export function seedSettingsFromEnv() {
  const envDefaults = {
    seerr_url: process.env.SEERR_URL,
    seerr_api_key: process.env.SEERR_API_KEY,
    seerr_public_url: process.env.SEERR_PUBLIC_URL,
    tautulli_url: process.env.TAUTULLI_URL,
    tautulli_api_key: process.env.TAUTULLI_API_KEY,
    tautulli_public_url: process.env.TAUTULLI_PUBLIC_URL,
  };
  for (const key of KEYS) {
    if (envDefaults[key] && !getStmt.get(key)) upsert.run(key, normalize(key, envDefaults[key]));
  }
}

export function getSettings() {
  const out = {};
  for (const key of KEYS) out[key] = getStmt.get(key)?.value ?? null;
  return out;
}

// Only overwrites keys present (and non-empty) in `partial`, so callers can
// change just the URL without having to resend an existing API key. Las claves
// CLEARABLE sí aceptan vacío: borrarlas del formulario las elimina.
const deleteStmt = db.prepare('DELETE FROM settings WHERE key = ?');

export function updateSettings(partial) {
  for (const key of KEYS) {
    const value = partial[key];
    if (typeof value !== 'string') continue;
    if (value.trim() === '') {
      if (CLEARABLE_KEYS.has(key)) deleteStmt.run(key);
      continue;
    }
    if (PERCENT_KEYS.has(key)) {
      const n = Number(value.trim());
      if (!Number.isInteger(n) || n < 1 || n > 100) continue;
      upsert.run(key, String(n));
      continue;
    }
    upsert.run(key, normalize(key, value));
  }
}

export function mask(value) {
  if (!value) return null;
  return value.length <= 4 ? '••••' : `••••${value.slice(-4)}`;
}

// Generic key/value access to the same settings table, for callers (e.g. telegram.js)
// whose keys don't fit the seerr/tautulli-specific shape above.
export function getRawSetting(key) {
  return getStmt.get(key)?.value ?? null;
}

export function setRawSetting(key, value) {
  upsert.run(key, value);
}

export function getSettingsForDisplay() {
  const s = getSettings();
  return {
    seerr_url: s.seerr_url,
    seerr_api_key_set: Boolean(s.seerr_api_key),
    seerr_api_key_masked: mask(s.seerr_api_key),
    seerr_public_url: s.seerr_public_url,
    tautulli_url: s.tautulli_url,
    tautulli_api_key_set: Boolean(s.tautulli_api_key),
    tautulli_api_key_masked: mask(s.tautulli_api_key),
    tautulli_public_url: s.tautulli_public_url,
    tv_season_watched_percent: s.tv_season_watched_percent,
  };
}
