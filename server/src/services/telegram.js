import { db } from '../db.js';
import { getRawSetting, setRawSetting, mask } from '../settings.js';
import { getBalance } from '../quota.js';
import { getMovieDetails } from './seerr.js';

const TOKEN_KEY = 'telegram_bot_token';
const OFFSET_KEY = 'telegram_last_update_id';
const MODE_KEY = 'telegram_notify_mode';         // 'dm' | 'group'
const GROUP_CHAT_KEY = 'telegram_group_chat_id';
const GROUP_TOPIC_KEY = 'telegram_group_topic_id'; // message_thread_id, opcional

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
  };
}

export function setNotifyTarget({ mode, groupChatId, groupTopicId }) {
  if (mode) setRawSetting(MODE_KEY, mode);
  if (groupChatId !== undefined) setRawSetting(GROUP_CHAT_KEY, String(groupChatId ?? ''));
  if (groupTopicId !== undefined) setRawSetting(GROUP_TOPIC_KEY, String(groupTopicId ?? ''));
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

async function handlePendingCallback(callbackQuery) {
  const [, userId, libraryId] = (callbackQuery.data || '').split(':');
  await answerCallbackQuery(callbackQuery.id);

  const chatId = callbackQuery.message.chat.id;
  const messageThreadId = callbackQuery.message.message_thread_id;
  const { pendingItems } = await getBalance(Number(userId), Number(libraryId));

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
    if (posters[i]) withPoster.push({ type: 'photo', media: posters[i], caption: item.title });
    else withoutPoster.push(item.title);
  });

  if (withPoster.length > 0) await sendMediaGroup(chatId, withPoster, { messageThreadId });
  if (withoutPoster.length > 0) {
    await sendMessage(chatId, `Sin carátula:\n${withoutPoster.map((t) => `• ${t}`).join('\n')}`, { messageThreadId });
  }
  if (pendingItems.length > shown.length) {
    await sendMessage(chatId, `… y ${pendingItems.length - shown.length} más.`, { messageThreadId });
  }
}

// Procesa un lote de updates: botones pulsados se responden al momento, mensajes
// normales se guardan en telegram_inbox para que el panel los lea sin llamar a
// Telegram en vivo.
async function processUpdates(updates) {
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

// Long-poll continuo (no bloquea el arranque si no hay token todavía: simplemente
// no hace nada hasta que se configure desde el panel).
export function startTelegramPoller() {
  async function loop() {
    const token = getBotToken();
    if (token) {
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
