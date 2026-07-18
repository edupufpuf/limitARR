import { db } from '../db.js';
import { getRawSetting, setRawSetting, mask } from '../settings.js';
import { getSeasonInfo, getMediaTitle } from './tautulli.js';

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
const SILENT_KEY = 'maintainerr_silent';
const OFFSET_KEY = 'maintainerr_last_update_id';
const SAVED_MESSAGE_KEY = 'maintainerr_saved_message';
const DELETE_MESSAGE_KEY = 'maintainerr_delete_message';
// Texto de borrado propio para series: {titulo} ya sale distinto para cada
// tipo ("la serie «X» (temporada N)" vs "«Película»"), pero el admin puede
// querer un mensaje enteramente distinto (emoji, tono) para series.
const DELETE_MESSAGE_TV_KEY = 'maintainerr_delete_message_tv';

const DEFAULT_SAVED_MESSAGE = '✅ Salvada por {usuario}{dias}.';
const DEFAULT_DELETE_MESSAGE = '🎬 {titulo} se borrará{dias}.\nSi quieres salvarla, pulsa 💾 Salvar y estará {diasSalvado} días más.';
const DEFAULT_DELETE_MESSAGE_TV = '📺 {titulo} se borrará{dias}.\nSi quieres salvarla, pulsa 💾 Salvar y estará {diasSalvado} días más.';

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
    silent: getRawSetting(SILENT_KEY) === '1',
    savedMessage: getRawSetting(SAVED_MESSAGE_KEY) || DEFAULT_SAVED_MESSAGE,
    deleteMessage: getRawSetting(DELETE_MESSAGE_KEY) || DEFAULT_DELETE_MESSAGE,
    deleteMessageTv: getRawSetting(DELETE_MESSAGE_TV_KEY) || DEFAULT_DELETE_MESSAGE_TV,
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
    silent: s.silent,
    savedMessage: s.savedMessage,
    deleteMessage: s.deleteMessage,
    deleteMessageTv: s.deleteMessageTv,
    enabled: isEnabled(),
  };
}

export function updateMaintainerrSettings({ url, botToken, chatId, topicId, pairs, silent, savedMessage, deleteMessage, deleteMessageTv }) {
  if (typeof url === 'string' && url.trim()) setRawSetting(URL_KEY, url.trim().replace(/\/$/, ''));
  if (typeof botToken === 'string' && botToken.trim()) setRawSetting(BOT_TOKEN_KEY, botToken.trim());
  if (chatId !== undefined) setRawSetting(CHAT_KEY, String(chatId).trim());
  if (topicId !== undefined) setRawSetting(TOPIC_KEY, String(topicId).trim());
  if (silent !== undefined) setRawSetting(SILENT_KEY, silent ? '1' : '');
  if (typeof savedMessage === 'string') setRawSetting(SAVED_MESSAGE_KEY, savedMessage.trim() || DEFAULT_SAVED_MESSAGE);
  if (typeof deleteMessage === 'string') setRawSetting(DELETE_MESSAGE_KEY, deleteMessage.trim() || DEFAULT_DELETE_MESSAGE);
  if (typeof deleteMessageTv === 'string') setRawSetting(DELETE_MESSAGE_TV_KEY, deleteMessageTv.trim() || DEFAULT_DELETE_MESSAGE_TV);
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
  const { chatId, topicId, silent } = getMaintainerrSettings();
  const params = { chat_id: chatId };
  if (topicId) params.message_thread_id = Number(topicId);
  if (silent) params.disable_notification = true;
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

const getNotifiedIds = db.prepare('SELECT media_server_id FROM maintainerr_notified WHERE collection_id = ?');
const insertNotified = db.prepare(`
  INSERT OR IGNORE INTO maintainerr_notified (media_server_id, collection_id) VALUES (?, ?)
`);
const deleteNotified = db.prepare(
  'DELETE FROM maintainerr_notified WHERE media_server_id = ? AND collection_id = ?'
);

// Título/póster + envío del aviso de Telegram para UN ítem candidato a
// borrarse. La usan tanto el webhook (altas por regla) como el sondeo de
// respaldo pollMaintainerrCollections más abajo (altas manuales, que
// Maintainerr no notifica solo — ver esa función). fallbackTitle es el
// título suelto del mensaje del webhook si lo hay; el sondeo no tiene
// mensaje, así que siempre resuelve por Plex o se queda sin título.
async function notifyDeletionCandidate(source, target, item, { fallbackTitle = null, deleteDaysOverride } = {}) {
  const { deleteMessage, deleteMessageTv } = getMaintainerrSettings();
  const sourceMedia = source.media?.find((m) => m.mediaServerId === item.mediaServerId);
  const deleteDays = deleteDaysOverride ?? source.deleteAfterDays;
  const diasTexto = deleteDays ? ` en ${deleteDays} días` : '';
  // {fecha}: día concreto del borrado, no solo "en N días" — deleteAfterDays
  // cuenta desde que Maintainerr mete el ítem en la colección, así que la
  // fecha es aproximada a partir de ahora (el aviso llega poco después de esa alta).
  const fechaTexto = deleteDays
    ? new Date(Date.now() + deleteDays * 86_400_000).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })
    : '';
  const isSeason = source.type !== 'movie';
  // Texto propio para series: aparte de {titulo} ya nombrar serie+temporada
  // explícitas, el admin puede querer un mensaje del todo distinto (emoji, tono).
  const template = isSeason ? deleteMessageTv : deleteMessage;

  // Issue: Salvadas para series, siempre por temporada. Maintainerr no da
  // seasonNumber ni el título de la serie sueltos en su "media" (solo
  // tmdbId a nivel de serie), así que "Serie - Temporada N" sale de
  // consultar Tautulli por el rating_key (mediaServerId) del ítem — ya
  // configurado, sin depender de una conexión Plex aparte. Si falla, se cae
  // al título compartido del mensaje (sin temporada).
  let itemTitle = fallbackTitle ?? null;
  let showName = null;
  let seasonNumber = null;
  if (isSeason) {
    const info = await getSeasonInfo(item.mediaServerId);
    if (info) {
      showName = info.showTitle;
      seasonNumber = info.seasonNumber;
      itemTitle = `${showName} - Temporada ${seasonNumber}`;
    }
  } else if (!itemTitle) {
    // El regex sobre el mensaje de Maintainerr puede no matchear (formato
    // distinto, sin comillas...) — mismo fallback por Tautulli que series.
    itemTitle = await getMediaTitle(item.mediaServerId);
  }
  // Serie: nombrar explícitamente "la serie X (temporada N)" en vez de dejar
  // que el guion de itemTitle ("X - Temporada N") se lea ambiguo en el aviso.
  const tituloTexto = showName
    ? `la serie «${showName}» (temporada ${seasonNumber})`
    : itemTitle
      ? `«${itemTitle}»`
      : isSeason ? 'esta temporada' : 'esta película';

  const text = target
    ? template
        .replace(/{titulo}/g, tituloTexto)
        .replace(/{dias}/g, diasTexto)
        .replace(/{fecha}/g, fechaTexto)
        .replace(/{diasSalvado}/g, String(target.deleteAfterDays ?? ''))
    : `🎬 ${tituloTexto} se borrará${diasTexto}.\n\n⚠️ Sin colección de salvados configurada para "${source.title}" — no se puede salvar.`;
  // "Salvar" pide confirmación antes de mover nada (asksave: cambia el
  // teclado a Sí/Cancelar; el save: real solo llega tras confirmar — ver
  // handleAskSaveCallback/handleCancelSaveCallback).
  const replyMarkup = target
    ? {
        inline_keyboard: [
          [{ text: '💾 Salvar', callback_data: `asksave:${item.mediaServerId}:${source.id}:${target.id}` }],
        ],
      }
    : undefined;

  try {
    // El título viaja también en el registro de salvados al pulsar el botón,
    // así que se guarda aparte del mensaje (el caption es editable por Telegram).
    pendingTitles.set(String(item.mediaServerId), {
      title: itemTitle,
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
  const fallbackTitle = /'(.+)' has been added to '/.exec(body.message ?? '')?.[1];

  for (const item of mediaItems) {
    await notifyDeletionCandidate(source, target, item, { fallbackTitle, deleteDaysOverride: body.dayAmount });
    // Marca "ya avisado" para que el sondeo de respaldo no lo repita.
    insertNotified.run(String(item.mediaServerId), source.id);
  }
}

// Maintainerr solo dispara su webhook "Media Added To Collection" cuando es
// su propio motor de reglas el que mete el ítem en la colección de borrado —
// una alta MANUAL (arrastrar/añadir un ítem a mano en su panel) no lo
// dispara, y se quedaba sin aviso de Telegram (confirmado en logs: la alta
// por regla loguea "WebhookAgent: Sending webhook notification" justo
// después de añadir el media; una alta manual no). Este sondeo de respaldo
// (cada 5 min, ver startMaintainerrPoller) revisa las colecciones origen
// configuradas y avisa de lo que encuentre sin avisar todavía, marcándolo en
// maintainerr_notified para no duplicar avisos ni con el webhook ni entre
// sondeos. Si un ítem sale de la colección (salvado o quitado a mano) se
// limpia su marca, así que si vuelve a entrar se avisa de nuevo.
export async function pollMaintainerrCollections() {
  if (!isEnabled()) return;
  const { pairs } = getMaintainerrSettings();
  if (pairs.length === 0) return;

  let collections;
  try {
    collections = await listCollections();
  } catch (err) {
    console.error('[maintainerr] sondeo de colecciones falló:', err.message);
    return;
  }

  for (const pair of pairs) {
    const source = collections.find((c) => c.title === pair.source);
    if (!source) continue;
    const target = collections.find((c) => c.title === pair.target) ?? null;
    const media = source.media ?? [];
    const currentIds = new Set(media.map((m) => String(m.mediaServerId)));
    const notifiedIds = getNotifiedIds.all(source.id).map((r) => r.media_server_id);

    for (const id of notifiedIds) {
      if (!currentIds.has(id)) deleteNotified.run(id, source.id);
    }

    for (const item of media) {
      const id = String(item.mediaServerId);
      if (notifiedIds.includes(id)) continue;
      await notifyDeletionCandidate(source, target, item);
      insertNotified.run(id, source.id);
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

// Primer clic en "💾 Salvar": no mueve nada todavía, solo cambia el teclado
// a Sí/Cancelar. El save: real (handleSaveCallback) solo llega si confirman.
async function handleAskSaveCallback(query) {
  const [, mediaServerId, sourceId, targetId] = query.data.split(':');
  const confirmMarkup = {
    inline_keyboard: [
      [
        { text: '✅ Sí, salvar', callback_data: `save:${mediaServerId}:${sourceId}:${targetId}` },
        { text: '✖️ Cancelar', callback_data: `cancelsave:${mediaServerId}:${sourceId}:${targetId}` },
      ],
    ],
  };
  try {
    await botApi('editMessageReplyMarkup', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: confirmMarkup,
    });
    await botApi('answerCallbackQuery', { callback_query_id: query.id, text: '¿Seguro?' });
  } catch (err) {
    console.error('[maintainerr] error preguntando confirmación:', err.message);
  }
}

// Cancelar: vuelve al botón "💾 Salvar" de partida, sin tocar la colección.
async function handleCancelSaveCallback(query) {
  const [, mediaServerId, sourceId, targetId] = query.data.split(':');
  const originalMarkup = {
    inline_keyboard: [
      [{ text: '💾 Salvar', callback_data: `asksave:${mediaServerId}:${sourceId}:${targetId}` }],
    ],
  };
  try {
    await botApi('editMessageReplyMarkup', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: originalMarkup,
    });
    await botApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Cancelado' });
  } catch (err) {
    console.error('[maintainerr] error cancelando confirmación:', err.message);
  }
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
    // Mismo motivo que el título por caché: si el proceso reinició entre el
    // aviso y el clic no hay título guardado (ni "Serie - Temporada N" ni el
    // de la película). Se recalcula en vivo contra Tautulli (igual que el
    // webhook) en vez de guardar el salvado sin título.
    let liveTitle = null;
    if (!cached.title) {
      if (sourceCollection?.type !== 'movie') {
        const info = await getSeasonInfo(mediaServerId);
        if (info) liveTitle = `${info.showTitle} - Temporada ${info.seasonNumber}`;
      } else {
        liveTitle = await getMediaTitle(mediaServerId);
      }
    }
    const meta = {
      title: cached.title ?? liveTitle,
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

    const { savedMessage } = getMaintainerrSettings();
    const diasPhrase = days ? ` — hay ${days} días más para verla` : '';
    // {fecha}: nueva fecha de borrado tras salvar (hoy + días de la colección
    // de salvados), igual que {fecha} en el aviso original pero contando
    // desde el momento del salvado, no de la alta en Maintainerr.
    const fechaTexto = days
      ? new Date(Date.now() + days * 86_400_000).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' })
      : '';
    const note = savedMessage
      .replace(/{usuario}/g, displayName(query.from))
      .replace(/{dias}/g, diasPhrase)
      .replace(/{fecha}/g, fechaTexto);
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

// TTL corto para no golpear Maintainerr en cada carga del panel (mismo patrón
// que AVAILABILITY_TTL_MS en seerr.js).
const COLLECTIONS_LIVE_TTL_MS = 60_000;
let collectionsCache = { data: null, at: 0 };

async function getCollectionsCached() {
  if (collectionsCache.data && Date.now() - collectionsCache.at < COLLECTIONS_LIVE_TTL_MS) {
    return collectionsCache.data;
  }
  const data = await listCollections();
  collectionsCache = { data, at: Date.now() };
  return data;
}

// Una salvada puede salir de su colección en Maintainerr a mano (o por otra
// regla) antes de que expires_at se cumpla — expires_at solo es una cuenta
// atrás calculada al guardar, no se entera de eso sola. Confirmamos en vivo
// que el media_server_id siga en ALGUNA colección destino configurada (los
// pairs no guardan a qué target fue cada fila, y en la práctica no se
// solapan) y descartamos las que ya no estén. Si Maintainerr no responde,
// fail-open: se confía solo en expires_at, como hasta ahora — un corte de
// red no debe vaciar el panel de salvados.
async function filterStillInCollection(rows) {
  if (rows.length === 0) return rows;
  const { pairs } = getMaintainerrSettings();
  if (pairs.length === 0) return rows;
  let collections;
  try {
    collections = await getCollectionsCached();
  } catch (err) {
    console.error('[maintainerr] no se pudo comprobar colección de salvados en vivo, se confía en expires_at:', err.message);
    return rows;
  }
  const targetTitles = new Set(pairs.map((p) => p.target));
  const targetCollections = collections.filter((c) => targetTitles.has(c.title));
  return rows.filter((row) =>
    targetCollections.some((c) => c.media?.some((m) => String(m.mediaServerId) === String(row.media_server_id)))
  );
}

export async function getSalvadosByUser(userId) {
  const rows = db
    .prepare(
      `SELECT * FROM salvados WHERE user_id = ? AND expires_at > datetime('now') ORDER BY saved_at DESC`
    )
    .all(userId);
  return filterStillInCollection(rows);
}

export async function getAllSalvados() {
  const rows = db
    .prepare(`SELECT * FROM salvados WHERE expires_at > datetime('now') ORDER BY saved_at DESC`)
    .all();
  return filterStillInCollection(rows);
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
            const data = u.callback_query?.data;
            if (data?.startsWith('asksave:')) {
              await handleAskSaveCallback(u.callback_query);
            } else if (data?.startsWith('cancelsave:')) {
              await handleCancelSaveCallback(u.callback_query);
            } else if (data?.startsWith('save:')) {
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

  // Sondeo de respaldo cada minuto para altas manuales (ver
  // pollMaintainerrCollections) — igual de frecuente que el ciclo de cupo, y
  // se lanza también al arrancar (setInterval no lo hace solo: sin esto, tras
  // cada despliegue/reinicio había que esperar el intervalo entero para el
  // primer aviso). No compite con el long-poll de arriba, que es solo para
  // los clics del botón Salvar.
  const pollCollections = () =>
    pollMaintainerrCollections().catch((err) => console.error('[maintainerr] sondeo de colecciones falló:', err.message));
  pollCollections();
  setInterval(pollCollections, 60 * 1000);
}
