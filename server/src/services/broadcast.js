import { db } from '../db.js';
import { getRawSetting, setRawSetting } from '../settings.js';

// Aviso general en pantalla: el admin escribe un mensaje y, mientras esté
// activo, se corta con ese texto la primera reproducción que arranque cada
// usuario (ver enforceBroadcast en scheduler.js — terminate_session es la
// única forma de pop-up real que expone Plex/Tautulli). No vuelve a cortarle
// aunque siga viendo cosas, salvo que el admin cambie el mensaje.

const ENABLED_KEY = 'broadcast_enabled';
const MESSAGE_KEY = 'broadcast_message';

// Editable desde el panel (URL propia de Edu) — este es solo el valor inicial
// sugerido la primera vez, antes de que el admin guarde nada.
export const DEFAULT_BROADCAST_MESSAGE =
  '📲 Vincula tu Telegram para recibir avisos de tu cupo y de borrados automáticos: ' +
  'entra en http://cupo.eduflix.win y accede con tu cuenta de Plex. Al final verás "Vincular con Telegram".';

export function getBroadcastSettings() {
  return {
    enabled: getRawSetting(ENABLED_KEY) === '1',
    message: getRawSetting(MESSAGE_KEY) ?? DEFAULT_BROADCAST_MESSAGE,
  };
}

export function setBroadcastSettings({ enabled, message }) {
  if (enabled !== undefined) setRawSetting(ENABLED_KEY, enabled ? '1' : '0');
  if (message !== undefined) setRawSetting(MESSAGE_KEY, String(message).trim());
}

const getSeen = db.prepare('SELECT message FROM broadcast_seen WHERE user_id = ?');
const upsertSeen = db.prepare(`
  INSERT INTO broadcast_seen (user_id, message, seen_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT (user_id) DO UPDATE SET message = excluded.message, seen_at = excluded.seen_at
`);

// true si a ESTE usuario ya se le mostró ESTE mensaje exacto (un mensaje
// distinto — el admin lo editó — cuenta como no visto).
export function hasSeenBroadcast(userId, message) {
  return getSeen.get(userId)?.message === message;
}

export function markBroadcastSeen(userId, message) {
  upsertSeen.run(userId, message);
}

export function seenCountFor(message) {
  if (!message) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM broadcast_seen WHERE message = ?').get(message).n;
}
