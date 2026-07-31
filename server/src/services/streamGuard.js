import { db } from '../db.js';
import { getRawSetting, setRawSetting, getSettings } from '../settings.js';
import { getActivity, getUsers } from './tautulli.js';
import { terminateSession } from './plex.js';
import { getNotifyTarget, sendMessage } from './telegram.js';

// Un dispositivo por usuario: si Tautulli reporta más streams simultáneos de
// los permitidos para el mismo user_id, se corta el/los más recientes
// directamente en Plex (no basta con que Seerr o el cupo lo sepan, esto es
// puramente de reproducción). Los admins de Plex quedan exentos: puede tener
// varios TVs o estar probando algo.
const ENABLED_KEY = 'stream_limit_enabled';
const MAX_KEY = 'stream_limit_max';
const MESSAGE_KEY = 'stream_limit_message';

export const DEFAULT_STREAM_LIMIT_MESSAGE = 'Ya tienes otro dispositivo reproduciendo. Solo se permite uno a la vez.';

export function getStreamLimitSettings() {
  const maxRaw = Number(getRawSetting(MAX_KEY));
  return {
    enabled: getRawSetting(ENABLED_KEY) === '1',
    max: Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : 1,
    message: getRawSetting(MESSAGE_KEY) || DEFAULT_STREAM_LIMIT_MESSAGE,
  };
}

export function getStreamLimitSettingsForDisplay() {
  return getStreamLimitSettings();
}

export function updateStreamLimitSettings({ enabled, max, message }) {
  if (enabled !== undefined) setRawSetting(ENABLED_KEY, enabled ? '1' : '0');
  if (max !== undefined) {
    const n = Number(max);
    if (Number.isInteger(n) && n > 0) setRawSetting(MAX_KEY, String(n));
  }
  if (typeof message === 'string') setRawSetting(MESSAGE_KEY, message.trim() || DEFAULT_STREAM_LIMIT_MESSAGE);
}

// El módulo entero es opcional: sin Plex configurado no hay forma de cortar
// nada aunque el toggle esté activado.
export function isStreamLimitEnabled() {
  if (!getStreamLimitSettings().enabled) return false;
  const settings = getSettings();
  return Boolean(settings.plex_url && settings.plex_token);
}

const getChatId = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?');

async function notifyStreamCut(userId, killedSession, keptSession) {
  const target = getNotifyTarget();
  if (!target.notifyStreamLimit) return;
  const chatId = getChatId.get(userId)?.chat_id;
  if (!chatId) return;
  const killedPlayer = killedSession.player || 'otro dispositivo';
  const keptPlayer = keptSession?.player || 'tu otro dispositivo';
  const text = `📵 Se ha cortado tu reproducción en ${killedPlayer} porque ya tenías una sesión activa en ${keptPlayer}.`;
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    console.error('[stream-limit] telegram notify failed:', err.message);
  }
}

export async function enforceStreamLimit() {
  if (!isStreamLimitEnabled()) return;
  const { max, message } = getStreamLimitSettings();
  const settings = getSettings();

  const [sessions, tautulliUsers] = await Promise.all([getActivity(), getUsers()]);
  const adminIds = new Set(tautulliUsers.filter((u) => u.isAdmin).map((u) => u.id));

  const byUser = new Map();
  for (const session of sessions) {
    if (!session.userId || adminIds.has(session.userId)) continue;
    if (!byUser.has(session.userId)) byUser.set(session.userId, []);
    byUser.get(session.userId).push(session);
  }

  for (const [userId, userSessions] of byUser) {
    if (userSessions.length <= max) continue;

    // session_key más bajo = stream más antiguo: se mantiene, se corta el resto.
    const sorted = [...userSessions].sort((a, b) => a.sessionKey - b.sessionKey);
    const kept = sorted[0];
    const toKill = sorted.slice(max);

    for (const session of toKill) {
      try {
        await terminateSession(settings.plex_url, settings.plex_token, session.sessionId, message);
        console.log(`[stream-limit] cortada sesión de ${session.username} en ${session.player} (límite: ${max})`);
        await notifyStreamCut(userId, session, kept);
      } catch (err) {
        console.error('[stream-limit] terminate failed:', err.message);
      }
    }
  }
}

// Intervalo propio, más corto que el sondeo principal de solicitudes: cortar
// un stream de más importa que se note al momento, no al cabo de un minuto.
export function startStreamLimitPoller() {
  enforceStreamLimit().catch((err) => console.error('[stream-limit] initial check failed:', err.message));
  setInterval(() => {
    enforceStreamLimit().catch((err) => console.error('[stream-limit] check failed:', err.message));
  }, 15_000);
}
