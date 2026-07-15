import { db } from '../db.js';
import { getRawSetting, setRawSetting, mask } from '../settings.js';

// Módulo Maintainerr: cuando Maintainerr mete una película en una colección de
// borrado, avisa por Telegram con un botón "Salvar" que la mueve a la colección
// de salvados (con su propia caducidad). Usa un bot DEDICADO (no @Limitarr_bot):
// Telegram solo permite un getUpdates por token y este módulo nació como
// servicio aparte con su bot propio — se mantiene para no migrar el grupo.

const URL_KEY = 'maintainerr_url';
const BOT_TOKEN_KEY = 'maintainerr_bot_token';
const CHAT_KEY = 'maintainerr_chat_id';
const TOPIC_KEY = 'maintainerr_topic_id';
// Mapeo explícito: qué colección de salvados le toca a cada colección de
// borrado. El admin lo elige a mano en el panel (nada de adivinar por
// biblioteca/tipo) — guardado como JSON [{source, target}] (títulos exactos).
const PAIRS_KEY = 'maintainerr_salvados_pairs';
const OFFSET_KEY = 'maintainerr_last_update_id';

function parsePairs(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p.source === 'string' && typeof p.target === 'string')
      : [];
  } catch {
    return [];
  }
}

export function getMaintainerrSettings() {
  return {
    url: getRawSetting(URL_KEY),
    botToken: getRawSetting(BOT_TOKEN_KEY),
    chatId: getRawSetting(CHAT_KEY),
    topicId: getRawSetting(TOPIC_KEY),
    pairs: parsePairs(getRawSetting(PAIRS_KEY)),
  };
}

export function getMaintainerrSettingsForDisplay() {
  const s = getMaintainerrSettings();
  return {
    url: s.url,
    bot_token_set: Boolean(s.botToken),
    bot_token_masked: mask(s.botToken),
    chatId: s.chatId,
    topicId: s.topicId,
    pairs: s.pairs,
    enabled: isEnabled(),
  };
}

export function updateMaintainerrSettings({ url, botToken, chatId, topicId, pairs }) {
  if (typeof url === 'string' && url.trim()) setRawSetting(URL_KEY, url.trim().replace(/\/$/, ''));
  if (typeof botToken === 'string' && botToken.trim()) setRawSetting(BOT_TOKEN_KEY, botToken.trim());
  if (chatId !== undefined) setRawSetting(CHAT_KEY, String(chatId).trim());
  if (topicId !== undefined) setRawSetting(TOPIC_KEY, String(topicId).trim());
  if (Array.isArray(pairs)) {
    const clean = pairs
      .filter((p) => p && typeof p.source === 'string' && typeof p.target === 'string' && p.target)
      .map((p) => ({ source: p.source, target: p.target }));
    setRawSetting(PAIRS_KEY, JSON.stringify(clean));
  }
}

// El módulo entero es opcional: sin URL o sin bot, el webhook ignora y el poller duerme.
export function isEnabled() {
  const s = getMaintainerrSettings();
  return Boolean(s.url && s.botToken && s.chatId);
}

// --- API de Maintainerr (sin auth por defecto) ---

async function maintainerrRequest(path, options) {
  const base = getRawSetting(URL_KEY);
  if (!base) throw new Error('Maintainerr no configurado (falta la URL)');
  const res = await fetch(`${base}/api/collections${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`Maintainerr ${options?.method ?? 'GET'} ${path} falló: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export function listCollections() {
  return maintainerrRequest('');
}

function removeFromCollection(collectionId, mediaServerId) {
  return maintainerrRequest('/remove', {
    method: 'POST',
    body: JSON.stringify({ collectionId, media: [{ mediaServerId }] }),
  });
}

function addToCollection(collectionId, mediaServerId) {
  return maintainerrRequest('/add', {
    method: 'POST',
    body: JSON.stringify({ collectionId, media: [{ mediaServerId }], manual: true }),
  });
}

// --- Bot Telegram dedicado ---

async function botApi(method, params = {}) {
  const token = getRawSetting(BOT_TOKEN_KEY);
  if (!token) throw new Error('Bot de Maintainerr no configurado (falta el token)');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} failed: ${json.description}`);
  return json.result;
}

function targetParams() {
  const { chatId, topicId } = getMaintainerrSettings();
  const params = { chat_id: chatId };
  if (topicId) params.message_thread_id = Number(topicId);
  return params;
}

function sendToGroup(text, replyMarkup) {
  return botApi('sendMessage', { ...targetParams(), text, reply_markup: replyMarkup });
}

function sendPhotoToGroup(photo, caption, replyMarkup) {
  return botApi('sendPhoto', { ...targetParams(), photo, caption, reply_markup: replyMarkup });
}

// --- Webhook: media añadida a una colección de borrado ---

function parseMediaItems(body) {
  // Maintainerr manda mediaItems como STRING JSON dentro del payload fusionado.
  if (Array.isArray(body.mediaItems)) return body.mediaItems;
  try {
    return JSON.parse(body.mediaItems);
  } catch {
    return [];
  }
}

export async function handleMaintainerrWebhook(body) {
  if (!isEnabled()) return;
  const mediaItems = parseMediaItems(body);
  if (mediaItems.length === 0) {
    console.warn('[maintainerr] webhook sin mediaItems, ignorado:', body);
    return;
  }

  const { pairs } = getMaintainerrSettings();
  // Ignorar altas en las propias colecciones de salvados (evita bucle:
  // salvar → add → webhook → otro aviso).
  if (pairs.some((p) => p.target === body.collectionName)) return;

  const collections = await listCollections();
  const source = collections.find((c) => c.title === body.collectionName);
  if (!source) {
    console.error(`[maintainerr] colección "${body.collectionName}" no encontrada`);
    return;
  }
  // Destino elegido a mano por el admin para ESTA colección concreta (panel
  // Notificaciones → Maintainerr), no adivinado por biblioteca/tipo.
  const targetTitle = pairs.find((p) => p.source === body.collectionName)?.target;
  const target = targetTitle ? collections.find((c) => c.title === targetTitle) : null;

  // Maintainerr no manda el título suelto, solo embebido en su mensaje:
  // "'Título' has been added to 'Colección'. ..." — el ancla tras la última
  // comilla aguanta títulos con apóstrofes.
  const title = /'(.+)' has been added to '/.exec(body.message ?? '')?.[1];
  const deleteDays = body.dayAmount ?? source.deleteAfterDays;
  const header =
    `🎬 ${title ? `«${title}»` : 'Esta película'} se borrará` +
    `${deleteDays ? ` en ${deleteDays} días` : ''}.`;

  for (const item of mediaItems) {
    const sourceMedia = source.media?.find((m) => m.mediaServerId === item.mediaServerId);
    const text = target
      ? `${header}\nSi quieres salvarla, pulsa 💾 Salvar y estará ${target.deleteAfterDays} días más.`
      : `${header}\n\n⚠️ Sin colección de salvados configurada para "${body.collectionName}" — no se puede salvar.`;
    const replyMarkup = target
      ? {
          inline_keyboard: [
            [{ text: '💾 Salvar', callback_data: `save:${item.mediaServerId}:${source.id}:${target.id}` }],
          ],
        }
      : undefined;

    try {
      // El título viaja también en el registro de salvados al pulsar el botón,
      // así que se guarda aparte del mensaje (el caption es editable por Telegram).
      pendingTitles.set(String(item.mediaServerId), {
        title: title ?? null,
        tmdbId: sourceMedia?.tmdbId ?? null,
        posterUrl: sourceMedia?.image_path ?? null,
        libraryId: source.libraryId != null ? Number(source.libraryId) : null,
      });
      if (sourceMedia?.image_path) {
        await sendPhotoToGroup(sourceMedia.image_path, text, replyMarkup);
      } else {
        await sendToGroup(text, replyMarkup);
      }
    } catch (err) {
      console.error('[maintainerr] error mandando mensaje Telegram:', err.message);
    }
  }
}

// título/póster/tmdb de los avisos en vuelo, para no re-consultar Maintainerr al
// pulsar el botón. Si el proceso reinició entre aviso y pulsación se pierde el
// dato y la fila de salvados queda sin título — asumible, el botón sigue funcionando.
const pendingTitles = new Map();

// --- Registro de salvados + resolución de quién pulsó ---

const insertSalvado = db.prepare(`
  INSERT INTO salvados (media_server_id, tmdb_id, title, poster_url, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+' || ? || ' days'))
`);

function displayName(from) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return name || (from.username ? `@${from.username}` : 'alguien');
}

// En chats privados el chat_id de telegram_links ES el id de usuario de Telegram,
// así que quien esté vinculado en "Mis avisos" se resuelve solo.
function resolveTautulliUser(telegramUserId) {
  return db
    .prepare('SELECT user_id FROM telegram_links WHERE chat_id = ?')
    .get(String(telegramUserId))?.user_id ?? null;
}

async function handleSaveCallback(query) {
  const [, mediaServerId, sourceId, targetId] = query.data.split(':');
  try {
    // Consulta la API en vivo ANTES de mover nada: si el proceso reinició
    // entre el aviso y el clic, pendingTitles está vacío (era memoria) pero
    // póster/tmdbId/biblioteca siguen ahí, en la propia colección origen.
    // El título no viaja en esta API (solo llega embebido en el mensaje del
    // webhook), así que ese sí depende de la caché y puede faltar.
    const collectionsBefore = await listCollections().catch(() => []);
    const sourceCollection = collectionsBefore.find((c) => c.id === Number(sourceId));
    const liveMedia = sourceCollection?.media?.find((m) => String(m.mediaServerId) === String(mediaServerId));

    await removeFromCollection(Number(sourceId), mediaServerId);
    await addToCollection(Number(targetId), mediaServerId);

    // Días reales de la colección de salvados en el momento de pulsar (no se
    // fija en el callback_data para que un cambio de config no deje mensajes mintiendo).
    const target = (await listCollections().catch(() => [])).find((c) => c.id === Number(targetId));
    const days = target?.deleteAfterDays;

    const cached = pendingTitles.get(String(mediaServerId)) ?? {};
    pendingTitles.delete(String(mediaServerId));
    const meta = {
      title: cached.title ?? null,
      tmdbId: cached.tmdbId ?? liveMedia?.tmdbId ?? null,
      posterUrl: cached.posterUrl ?? liveMedia?.image_path ?? null,
      libraryId: cached.libraryId ?? (sourceCollection?.libraryId != null ? Number(sourceCollection.libraryId) : null),
    };
    insertSalvado.run(
      String(mediaServerId),
      meta.tmdbId,
      meta.title,
      meta.posterUrl,
      String(query.from.id),
      displayName(query.from),
      resolveTautulliUser(query.from.id),
      meta.libraryId,
      days ?? 15
    );

    const note = `✅ Salvada por ${displayName(query.from)}${days ? ` — hay ${days} días más para verla` : ''}.`;
    await botApi('answerCallbackQuery', {
      callback_query_id: query.id,
      text: days ? `Salvada: ${days} días más` : 'Salvada',
    });
    // Editar el mensaje quita el teclado inline: sin botón no hay doble salvado.
    if (query.message.photo) {
      await botApi('editMessageCaption', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        caption: `${query.message.caption}\n\n${note}`,
      });
    } else {
      await botApi('editMessageText', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: `${query.message.text}\n\n${note}`,
      });
    }
  } catch (err) {
    console.error('[maintainerr] error salvando media:', err.message);
    await botApi('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Error al salvar, mira los logs',
    }).catch(() => {});
  }
}

// --- Consultas para el panel ---

export function getSalvadosByUser(userId) {
  return db
    .prepare(
      `SELECT * FROM salvados WHERE user_id = ? AND expires_at > datetime('now') ORDER BY saved_at DESC`
    )
    .all(userId);
}

export function getAllSalvados() {
  return db
    .prepare(`SELECT * FROM salvados WHERE expires_at > datetime('now') ORDER BY saved_at DESC`)
    .all();
}

// --- Poller del bot dedicado (long-poll, igual que telegram.js) ---

export function startMaintainerrPoller() {
  async function loop() {
    const token = getRawSetting(BOT_TOKEN_KEY);
    if (token) {
      try {
        const offset = Number(getRawSetting(OFFSET_KEY) || 0);
        const updates = await botApi('getUpdates', { offset: offset + 1, timeout: 20 });
        if (updates.length > 0) {
          setRawSetting(OFFSET_KEY, String(updates[updates.length - 1].update_id));
          for (const u of updates) {
            if (u.callback_query?.data?.startsWith('save:')) {
              await handleSaveCallback(u.callback_query);
            }
          }
        }
      } catch (err) {
        console.error('[maintainerr] poll failed:', err.message);
      }
    }
    setTimeout(loop, token ? 500 : 5000);
  }
  loop();
}
