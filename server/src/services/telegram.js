import crypto from 'node:crypto';
import { db } from '../db.js';
import { getRawSetting, setRawSetting, mask } from '../settings.js';
import { getBalance } from '../quota.js';
import { getMovieDetails } from './seerr.js';

const TOKEN_KEY = 'telegram_bot_token';
const OFFSET_KEY = 'telegram_last_update_id';
const MODE_KEY = 'telegram_notify_mode';         // 'dm' | 'group'
const GROUP_CHAT_KEY = 'telegram_group_chat_id';
const GROUP_TOPIC_KEY = 'telegram_group_topic_id'; // message_thread_id, opcional
const NO_QUOTA_MESSAGE_KEY = 'telegram_no_quota_message';
// Avisos opcionales (default ON): sin cupo, aprobación de solicitud y cupo liberado.
// Guardados como '1'/'0'; "no configurado" cuenta como activado.
const NOTIFY_NO_QUOTA_KEY = 'telegram_notify_no_quota';
const NOTIFY_APPROVED_KEY = 'telegram_notify_approved';
const NOTIFY_FREED_KEY = 'telegram_notify_freed';

export const DEFAULT_NO_QUOTA_MESSAGE =
  '🔴 {usuario} se ha pasado del cupo en {biblioteca} pidiendo "{titulo}".\n' +
  'Ve algo de lo que tienes pendiente antes de solicitar más.';

export function getBotToken() {
  return getRawSetting(TOKEN_KEY);
}

export function setBotToken(token) {
  setRawSetting(TOKEN_KEY, token.trim());
}

export function getBotTokenForDisplay() {
  const token = getBotToken();
  return { bot_token_set: Boolean(token), bot_token_masked: mask(token) };
}

export function getNotifyTarget() {
  return {
    mode: getRawSetting(MODE_KEY) || 'dm',
    groupChatId: getRawSetting(GROUP_CHAT_KEY),
    groupTopicId: getRawSetting(GROUP_TOPIC_KEY),
    noQuotaMessage: getNoQuotaMessage(),
    notifyNoQuota: getRawSetting(NOTIFY_NO_QUOTA_KEY) !== '0',
    notifyApproved: getRawSetting(NOTIFY_APPROVED_KEY) !== '0',
    notifyFreed: getRawSetting(NOTIFY_FREED_KEY) !== '0',
  };
}

// Tautulli admite "chatid/topicid" en un solo campo y es fácil pegar ese
// formato aquí: si el chat trae barra, se separa en chat + topic. Un topic
// explícito gana sobre el que venga pegado al chat.
export function normalizeGroupTarget(groupChatId, groupTopicId) {
  const [chat, topicFromChat] = String(groupChatId ?? '').trim().split('/');
  return {
    groupChatId: chat,
    groupTopicId: String(groupTopicId ?? '').trim() || topicFromChat || '',
  };
}

export function setNotifyTarget({ mode, groupChatId, groupTopicId, noQuotaMessage, notifyNoQuota, notifyApproved, notifyFreed }) {
  if (mode) setRawSetting(MODE_KEY, mode);
  if (groupChatId !== undefined || groupTopicId !== undefined) {
    const saved = getNotifyTarget();
    const normalized = normalizeGroupTarget(
      groupChatId !== undefined ? groupChatId : saved.groupChatId,
      groupTopicId !== undefined ? groupTopicId : saved.groupTopicId
    );
    setRawSetting(GROUP_CHAT_KEY, normalized.groupChatId);
    setRawSetting(GROUP_TOPIC_KEY, normalized.groupTopicId);
  }
  if (noQuotaMessage !== undefined) setNoQuotaMessage(noQuotaMessage);
  if (notifyNoQuota !== undefined) setRawSetting(NOTIFY_NO_QUOTA_KEY, notifyNoQuota ? '1' : '0');
  if (notifyApproved !== undefined) setRawSetting(NOTIFY_APPROVED_KEY, notifyApproved ? '1' : '0');
  if (notifyFreed !== undefined) setRawSetting(NOTIFY_FREED_KEY, notifyFreed ? '1' : '0');
}

export function getNoQuotaMessage() {
  return getRawSetting(NO_QUOTA_MESSAGE_KEY) || DEFAULT_NO_QUOTA_MESSAGE;
}

export function setNoQuotaMessage(message) {
  const value = String(message ?? '').trim();
  setRawSetting(NO_QUOTA_MESSAGE_KEY, value || DEFAULT_NO_QUOTA_MESSAGE);
}

export function renderNoQuotaMessage(template, values) {
  const replacements = {
    usuario: values.username ?? '',
    biblioteca: values.libraryName ?? '',
    titulo: values.mediaTitle ?? values.unit ?? 'un contenido',
    tipo: values.unit ?? 'un contenido',
  };
  return String(template || DEFAULT_NO_QUOTA_MESSAGE).replace(
    /\{(usuario|biblioteca|titulo|tipo)\}/g,
    (_, key) => replacements[key]
  );
}

async function api(method, params = {}) {
  const token = getBotToken();
  if (!token) throw new Error('Telegram no configurado (falta el token del bot)');

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

export async function sendMessage(chatId, text, { messageThreadId, replyMarkup } = {}) {
  const params = { chat_id: chatId, text };
  if (messageThreadId) params.message_thread_id = Number(messageThreadId);
  if (replyMarkup) params.reply_markup = replyMarkup;
  return api('sendMessage', params);
}

// Álbum de fotos (máx. 10, límite de Telegram); cada una con su propio caption.
export async function sendMediaGroup(chatId, media, { messageThreadId } = {}) {
  const params = { chat_id: chatId, media };
  if (messageThreadId) params.message_thread_id = Number(messageThreadId);
  return api('sendMediaGroup', params);
}

async function answerCallbackQuery(id, text = '') {
  return api('answerCallbackQuery', { callback_query_id: id, text });
}

export function pendingButton(userId, libraryId) {
  return { inline_keyboard: [[{ text: '📋 Ver pendientes', callback_data: `pending:${userId}:${libraryId}` }]] };
}

// --- Vinculación con un click (deep link t.me/bot?start=token) ---
// El usuario pulsa un botón en su panel, Telegram abre el bot con /start
// precargado y, al enviarlo, el poller de abajo asocia su chat_id sin que
// tenga que copiar ningún ID a mano ni pasar por el admin.

let botUsernameCache = null;
const linkTokens = new Map(); // token -> { userId, expiresAt }
const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

export async function getBotUsername() {
  if (botUsernameCache) return botUsernameCache;
  const me = await api('getMe');
  botUsernameCache = me.username;
  return botUsernameCache;
}

export function createLinkToken(userId) {
  const token = crypto.randomBytes(12).toString('hex');
  linkTokens.set(token, { userId, expiresAt: Date.now() + LINK_TOKEN_TTL_MS });
  return token;
}

const upsertLink = db.prepare(`
  INSERT INTO telegram_links (user_id, chat_id, label, linked_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT (user_id) DO UPDATE SET chat_id=excluded.chat_id, label=excluded.label, linked_at=excluded.linked_at
`);

function consumeLinkToken(token, chatId, label) {
  const entry = linkTokens.get(token);
  linkTokens.delete(token);
  if (!entry || entry.expiresAt < Date.now()) return false;
  upsertLink.run(entry.userId, String(chatId), label || null);
  return true;
}

// --- Inbox (mensajes normales, para "descubrir" chats desde el panel) ---

const insertInbox = db.prepare(`
  INSERT INTO telegram_inbox (chat_id, chat_type, chat_title, message_thread_id, username, first_name, text)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const pruneInbox = db.prepare(`
  DELETE FROM telegram_inbox WHERE id NOT IN (SELECT id FROM telegram_inbox ORDER BY id DESC LIMIT 100)
`);

export function getInboxMessages() {
  return db.prepare('SELECT * FROM telegram_inbox ORDER BY id DESC LIMIT 50').all();
}

// Común a handlePendingCallback (botón "sin cupo") y handlePendingCommand
// (/pendientes escrito a mano) — mismo formato de respuesta para las dos vías.
async function sendPendingItemsMessage(chatId, messageThreadId, pendingItems) {
  if (pendingItems.length === 0) {
    await sendMessage(chatId, 'No tienes nada pendiente de ver ahora mismo.', { messageThreadId });
    return;
  }

  const shown = pendingItems.slice(0, 10);
  // El póster viene ya en pendingItems; solo se pregunta a Seerr para
  // aprobaciones antiguas registradas antes de que se guardara poster_url.
  const posters = await Promise.all(
    shown.map((item) => item.posterUrl ?? getMovieDetails(item.tmdbId).then((d) => d.posterUrl))
  );

  const withPoster = [];
  const withoutPoster = [];
  shown.forEach((item, i) => {
    const caption = item.libraryName ? `${item.title} (${item.libraryName})` : item.title;
    if (posters[i]) withPoster.push({ type: 'photo', media: posters[i], caption });
    else withoutPoster.push(caption);
  });

  if (withPoster.length > 0) await sendMediaGroup(chatId, withPoster, { messageThreadId });
  if (withoutPoster.length > 0) {
    await sendMessage(chatId, `Sin carátula:\n${withoutPoster.map((t) => `• ${t}`).join('\n')}`, { messageThreadId });
  }
  if (pendingItems.length > shown.length) {
    await sendMessage(chatId, `… y ${pendingItems.length - shown.length} más.`, { messageThreadId });
  }
}

async function handlePendingCallback(callbackQuery) {
  const [, userId, libraryId] = (callbackQuery.data || '').split(':');
  await answerCallbackQuery(callbackQuery.id);

  const chatId = callbackQuery.message.chat.id;
  const messageThreadId = callbackQuery.message.message_thread_id;
  const { pendingItems } = await getBalance(Number(userId), Number(libraryId));
  await sendPendingItemsMessage(chatId, messageThreadId, pendingItems);
}

const getUserIdByChatId = db.prepare('SELECT user_id FROM telegram_links WHERE chat_id = ?');
const getEnabledLibraries = db.prepare('SELECT id, name FROM libraries WHERE enabled = 1');

// Pedido de Edu (3 ago 2026): comando /pendientes — el usuario lo escribe al
// bot y le lista lo pendiente de TODAS sus bibliotecas, sin depender de que
// antes llegue un botón de "sin cupo" (que solo cubre una biblioteca).
// Requiere tener el chat ya vinculado (Mi cupo → Vincular con Telegram).
async function handlePendingCommand(chatId, messageThreadId) {
  const link = getUserIdByChatId.get(String(chatId));
  if (!link) {
    await sendMessage(
      chatId,
      'No tengo tu cuenta vinculada todavía — entra a "Mi cupo" en el panel y pulsa "Vincular con Telegram".',
      { messageThreadId }
    );
    return;
  }
  const allPending = [];
  for (const lib of getEnabledLibraries.all()) {
    const { pendingItems } = await getBalance(link.user_id, lib.id);
    for (const item of pendingItems) allPending.push({ ...item, libraryName: lib.name });
  }
  await sendPendingItemsMessage(chatId, messageThreadId, allPending);
}

// Procesa un lote de updates: botones pulsados se responden al momento, mensajes
// normales se guardan en telegram_inbox para que el panel los lea sin llamar a
// Telegram en vivo.
export async function processUpdates(updates) {
  for (const u of updates) {
    if (u.callback_query?.data?.startsWith('pending:')) {
      try {
        await handlePendingCallback(u.callback_query);
      } catch (err) {
        console.error('[telegram] callback failed:', err.message);
      }
      continue;
    }
    if (u.message?.chat) {
      const m = u.message;
      const startMatch = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(m.text || '');
      if (startMatch?.[1]) {
        try {
          const linked = consumeLinkToken(startMatch[1], m.chat.id, m.chat.username || m.chat.first_name);
          await sendMessage(m.chat.id, linked
            ? '✅ Avisos activados. Ya te avisaremos por aquí de tu cupo.'
            : 'Ese enlace ha caducado. Vuelve al panel y pulsa "Vincular con Telegram" de nuevo.');
        } catch (err) {
          console.error('[telegram] link token failed:', err.message);
        }
        continue;
      }
      if (/^\/pendientes(?:@\w+)?/.test(m.text || '')) {
        try {
          await handlePendingCommand(m.chat.id, m.message_thread_id);
        } catch (err) {
          console.error('[telegram] /pendientes failed:', err.message);
        }
        continue;
      }
      insertInbox.run(
        String(m.chat.id),
        m.chat.type,
        m.chat.title || null,
        m.message_thread_id ?? null,
        m.chat.username || null,
        m.chat.first_name || null,
        m.text || null
      );
    }
  }
  pruneInbox.run();
}

// Pedido de Edu (3 ago 2026): que al escribir "/" en el chat salga la lista
// de comandos disponibles — eso lo pinta Telegram solo si el bot registra su
// menú vía setMyCommands. Se reintenta cada vuelta hasta que salga bien (por
// si el primer intento coincide con Telegram caído), y solo una vez por
// token (no tiene sentido repetirlo en cada ciclo de sondeo).
async function setMyCommands() {
  await api('setMyCommands', {
    commands: [{ command: 'pendientes', description: 'Ver tus pendientes de ver' }],
  });
}

// Long-poll continuo (no bloquea el arranque si no hay token todavía: simplemente
// no hace nada hasta que se configure desde el panel).
export function startTelegramPoller() {
  let commandsRegisteredForToken = null;
  async function loop() {
    const token = getBotToken();
    if (token) {
      if (commandsRegisteredForToken !== token) {
        try {
          await setMyCommands();
          commandsRegisteredForToken = token;
        } catch (err) {
          console.error('[telegram] setMyCommands failed:', err.message);
        }
      }
      try {
        const offset = Number(getRawSetting(OFFSET_KEY) || 0);
        const updates = await api('getUpdates', { offset: offset + 1, timeout: 20 });
        if (updates.length > 0) {
          setRawSetting(OFFSET_KEY, String(updates[updates.length - 1].update_id));
          await processUpdates(updates);
        }
      } catch (err) {
        console.error('[telegram] poll failed:', err.message);
      }
    }
    setTimeout(loop, token ? 500 : 5000);
  }
  loop();
}
