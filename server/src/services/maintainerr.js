import { db } from '../db.js';
import { getRawSetting, setRawSetting, mask } from '../settings.js';
import { getSeasonInfo, getMediaTitle, getItemWatchHistory } from './tautulli.js';

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
    const err = new Error(`Maintainerr ${options?.method ?? 'GET'} ${path} falló: ${res.status} ${await res.text()}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

export function listCollections() {
  return maintainerrRequest('');
}

// Ejecuta AHORA MISMO la acción de borrado configurada en la colección
// (Radarr/Sonarr, o borrado directo en el servidor de medios si no hay *arr
// vinculado — la MISMA que usaría al cumplirse deleteAfterDays) sobre un ítem
// concreto, sin esperar al contador de días. Puede devolver 409 si hay una
// ejecución de colección/regla en curso en Maintainerr — el llamante debe
// tratarlo como "reintentar en el siguiente ciclo" (ver err.status arriba).
function handleCollectionMedia(collectionId, mediaId) {
  return maintainerrRequest('/media/handle', {
    method: 'POST',
    body: JSON.stringify({ collectionId, mediaId }),
  });
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

// Ventana de "días para salvar" (ver tabla maintainerr_candidates en db.js):
// se guarda aparte de maintainerr_notified porque esa se borra en cuanto el
// ítem sale de la colección origen — justo lo que pasa al salvarlo — y aquí
// hace falta conservar el dato mientras dure el salvado. ON CONFLICT DO
// NOTHING: si ya había una fila (reaviso del mismo ítem sin haberse resuelto
// la anterior) se conserva la ventana original, no se reinicia el plazo.
const insertCandidate = db.prepare(`
  INSERT INTO maintainerr_candidates (media_server_id, delete_after_days)
  VALUES (?, ?)
  ON CONFLICT(media_server_id) DO NOTHING
`);
const getCandidate = db.prepare('SELECT * FROM maintainerr_candidates WHERE media_server_id = ?');
const deleteCandidate = db.prepare('DELETE FROM maintainerr_candidates WHERE media_server_id = ?');
const markWindowClosedNotified = db.prepare(
  'UPDATE maintainerr_candidates SET window_closed_notified = 1 WHERE media_server_id = ?'
);

// Ver tabla maintainerr_messages en db.js.
const upsertMessageRow = db.prepare(`
  INSERT INTO maintainerr_messages (media_server_id, collection_id, chat_id, message_id, has_photo, text)
  VALUES (@mediaServerId, @collectionId, @chatId, @messageId, @hasPhoto, @text)
  ON CONFLICT(media_server_id, collection_id) DO UPDATE SET
    chat_id = excluded.chat_id, message_id = excluded.message_id,
    has_photo = excluded.has_photo, text = excluded.text, created_at = datetime('now')
`);
const getMessageRow = db.prepare(
  'SELECT * FROM maintainerr_messages WHERE media_server_id = ? AND collection_id = ?'
);
const deleteMessageRow = db.prepare(
  'DELETE FROM maintainerr_messages WHERE media_server_id = ? AND collection_id = ?'
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
    const hasPhoto = Boolean(sourceMedia?.image_path);
    const sent = hasPhoto
      ? await sendPhotoToGroup(sourceMedia.image_path, text, replyMarkup)
      : await sendToGroup(text, replyMarkup);
    // Sin botón (sin colección de salvados configurada) no hace falta guardar
    // el mensaje: nunca habrá que tocarlo al pulsar Salvar, y "ya borrada" se
    // marca igual la próxima vez que se avise de este mismo ítem si reaparece.
    if (target && sent?.message_id != null && sent?.chat?.id != null) {
      upsertMessageRow.run({
        mediaServerId: String(item.mediaServerId),
        collectionId: source.id,
        chatId: String(sent.chat.id),
        messageId: sent.message_id,
        hasPhoto: hasPhoto ? 1 : 0,
        text,
      });
    }
  } catch (err) {
    console.error('[maintainerr] error mandando mensaje Telegram:', err.message);
  }
  // Se devuelve para que el llamante guarde la "ventana de salvar" en
  // maintainerr_candidates (ver processSalvados) — hace falta aunque el envío
  // a Telegram falle.
  return deleteDays;
}

// Pedido de Edu (4 ago 2026): si un ítem sale de su colección de borrado SIN
// pasar por el botón Salvar (esa vía borra su propia fila de
// maintainerr_messages, ver handleSaveCallback), es que Maintainerr lo borró
// de verdad — quita el botón del aviso original y añade "YA BORRADA".
async function markMessageDeleted(mediaServerId, collectionId) {
  const row = getMessageRow.get(mediaServerId, collectionId);
  if (!row) return;
  deleteMessageRow.run(mediaServerId, collectionId);
  try {
    const method = row.has_photo ? 'editMessageCaption' : 'editMessageText';
    const textField = row.has_photo ? 'caption' : 'text';
    await botApi(method, {
      chat_id: row.chat_id,
      message_id: row.message_id,
      [textField]: `${row.text}\n\n🗑️ YA BORRADA`,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (err) {
    console.error('[maintainerr] error marcando mensaje como borrado:', err.message);
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
    const deleteDays = await notifyDeletionCandidate(source, target, item, { fallbackTitle, deleteDaysOverride: body.dayAmount });
    // Marca "ya avisado" para que el sondeo de respaldo no lo repita.
    insertNotified.run(String(item.mediaServerId), source.id);
    if (deleteDays) insertCandidate.run(String(item.mediaServerId), deleteDays);
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
      if (!currentIds.has(id)) {
        deleteNotified.run(id, source.id);
        await markMessageDeleted(id, source.id);
        // Si salió de la colección origen SIN haberse salvado (no hay filas
        // en salvados para este id), es un borrado/quitado genuino — limpia
        // la ventana huérfana. Si SÍ está salvado, se deja intacta: la
        // necesita processSalvados hasta que se resuelva de verdad.
        if (getSalvadosForItem.all(id).length === 0) deleteCandidate.run(id);
      }
    }

    for (const item of media) {
      const id = String(item.mediaServerId);
      if (notifiedIds.includes(id)) continue;
      const deleteDays = await notifyDeletionCandidate(source, target, item);
      insertNotified.run(id, source.id);
      if (deleteDays) insertCandidate.run(id, deleteDays);
    }
  }
}

// título/póster/tmdb de los avisos en vuelo, para no re-consultar Maintainerr al
// pulsar el botón. Si el proceso reinició entre aviso y pulsación se pierde el
// dato y la fila de salvados queda sin título — asumible, el botón sigue funcionando.
const pendingTitles = new Map();

// --- Registro de salvados + resolución de quién pulsó ---

// expires_at ya no es "días fijos de la colección salvados": es la fecha
// PROYECTADA de borrado (recalculada cada ciclo por processSalvados, ver más
// abajo), un texto literal en vez del viejo "+N days" — el que se pasa al
// insertar es el peor caso conocido en ese momento (ver getFallbackDeadlineMs).
const insertSalvado = db.prepare(`
  INSERT INTO salvados (media_server_id, tmdb_id, title, poster_url, telegram_user_id, telegram_name, user_id, library_id, saved_at, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
`);
const getSalvadosForItem = db.prepare('SELECT * FROM salvados WHERE media_server_id = ? ORDER BY saved_at ASC');
const getSalvadoForItemAndUser = db.prepare(
  'SELECT 1 FROM salvados WHERE media_server_id = ? AND telegram_user_id = ?'
);
const updateSalvadoWatchedAt = db.prepare('UPDATE salvados SET watched_at = ? WHERE id = ?');
const updateSalvadosExpiresAt = db.prepare('UPDATE salvados SET expires_at = ? WHERE media_server_id = ?');
// No se borra la fila (el Registro y el historial de la pestaña Salvadas la
// necesitan viva) — se marca resuelta, mismo espíritu que decisions_log
// (nunca se reescribe una fila 'approved' vieja, solo se añaden eventos).
const resolveSalvadosForItem = db.prepare(
  "UPDATE salvados SET resolved_at = datetime('now') WHERE media_server_id = ? AND resolved_at IS NULL"
);
const distinctSalvadoMediaIds = db.prepare('SELECT DISTINCT media_server_id FROM salvados WHERE resolved_at IS NULL');
const getLibrarySectionType = db.prepare('SELECT section_type FROM libraries WHERE id = ?');

// Mensaje de Telegram de un salvado (ver tabla salvado_messages en db.js):
// text guarda SIEMPRE el contenido completo tal cual está en Telegram ahora
// mismo (se reescribe en cada edición, ver appendSavedNote) — la API de bots
// no deja leer el texto/caption actual de un mensaje ajeno, así que sin esto
// no habría forma de anexarle una línea más al sumarse un segundo salvador.
const upsertSalvadoMessage = db.prepare(`
  INSERT INTO salvado_messages (media_server_id, chat_id, message_id, has_photo, text)
  VALUES (@mediaServerId, @chatId, @messageId, @hasPhoto, @text)
  ON CONFLICT(media_server_id) DO UPDATE SET
    chat_id = excluded.chat_id, message_id = excluded.message_id, has_photo = excluded.has_photo, text = excluded.text
`);
const getSalvadoMessage = db.prepare('SELECT * FROM salvado_messages WHERE media_server_id = ?');
const deleteSalvadoMessage = db.prepare('DELETE FROM salvado_messages WHERE media_server_id = ?');

function toSqliteText(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function sqliteTextToMs(text) {
  return new Date(`${text.replace(' ', 'T')}Z`).getTime();
}

function isTvLibrary(libraryId) {
  if (libraryId == null) return false;
  return getLibrarySectionType.get(libraryId)?.section_type === 'show';
}

// Peor caso conocido de fecha de borrado para un ítem salvado: el cierre de
// la ventana de salvar (los días que tardaría en borrarse sola, guardados en
// maintainerr_candidates al avisar) + 7 días de margen para que se vea. Sin
// dato de ventana (deleteAfterDays no configurado en su momento en la
// colección origen), cae a 7 días desde el PRIMER salvado — ancla estable,
// no "7 días desde ahora" en cada ciclo, que nunca llegaría.
const FALLBACK_WATCH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function getFallbackDeadlineMs(mediaServerId) {
  const candidate = getCandidate.get(mediaServerId);
  if (candidate) {
    const closesAtMs = sqliteTextToMs(candidate.notified_at) + candidate.delete_after_days * 86_400_000;
    return closesAtMs + FALLBACK_WATCH_WINDOW_MS;
  }
  const rows = getSalvadosForItem.all(mediaServerId);
  const firstSavedMs = rows.length > 0 ? Math.min(...rows.map((r) => sqliteTextToMs(r.saved_at))) : Date.now();
  return firstSavedMs + FALLBACK_WATCH_WINDOW_MS;
}

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

const ADD_SAVE_CALLBACK_PREFIX = 'addsave:';
function addSaveMarkup(mediaServerId) {
  return { inline_keyboard: [[{ text: '➕ Salvar también', callback_data: `${ADD_SAVE_CALLBACK_PREFIX}${mediaServerId}` }]] };
}

// Texto de "salvada" para UN salvador — reutilizado tanto al primer salvado
// como al sumarse más gente (handleAddSaveCallback), cada vez con su propia
// línea. {dias}/{fecha} ya no son los días fijos de la colección salvados:
// son el peor caso real (getFallbackDeadlineMs) — si se ve antes, se borra
// antes; esto es solo el límite que NUNCA se pasa.
function buildSavedNote(mediaServerId, from) {
  const { savedMessage } = getMaintainerrSettings();
  const fallbackMs = getFallbackDeadlineMs(mediaServerId);
  const daysLeft = Math.max(1, Math.round((fallbackMs - Date.now()) / 86_400_000));
  const diasPhrase = ` — como muy tarde tienes hasta ${daysLeft} día${daysLeft === 1 ? '' : 's'} para verla`;
  const fechaTexto = new Date(fallbackMs).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
  return savedMessage
    .replace(/{usuario}/g, displayName(from))
    .replace(/{dias}/g, diasPhrase)
    .replace(/{fecha}/g, fechaTexto);
}

// Anexa una línea de "salvada por X" al mensaje y guarda el texto resultante
// en salvado_messages, para poder seguir anexando al sumarse más gente sin
// depender de poder leer el mensaje actual desde la API de Telegram.
async function appendSavedNote(mediaServerId, target, from, keepButton) {
  const note = buildSavedNote(mediaServerId, from);
  const newText = `${target.baseText}\n\n${note}`;
  const replyMarkup = keepButton ? addSaveMarkup(mediaServerId) : { inline_keyboard: [] };
  const method = target.hasPhoto ? 'editMessageCaption' : 'editMessageText';
  await botApi(method, {
    chat_id: target.chatId,
    message_id: target.messageId,
    [target.hasPhoto ? 'caption' : 'text']: newText,
    reply_markup: replyMarkup,
  });
  upsertSalvadoMessage.run({
    mediaServerId,
    chatId: String(target.chatId),
    messageId: target.messageId,
    hasPhoto: target.hasPhoto ? 1 : 0,
    text: newText,
  });
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

// Primer salvado de un ítem: mueve de la colección de borrado a la de
// salvados en Maintainerr y abre el registro. Salvadores siguientes
// (handleAddSaveCallback) NO vuelven a tocar Maintainerr — el ítem ya está a
// salvo aquí, solo se suma su fila.
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
    // Se editará el mensaje aquí mismo abajo (con la nota de "Salvada por...");
    // sin borrar esta fila, el sondeo de respaldo lo vería salir de la colección
    // origen en el próximo ciclo y lo marcaría (mal) como "YA BORRADA" encima.
    deleteMessageRow.run(String(mediaServerId), Number(sourceId));

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
      toSqliteText(getFallbackDeadlineMs(String(mediaServerId)))
    );

    await botApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Salvada' });
    const baseText = query.message.photo ? query.message.caption : query.message.text;
    await appendSavedNote(
      String(mediaServerId),
      { chatId: query.message.chat.id, messageId: query.message.message_id, hasPhoto: Boolean(query.message.photo), baseText },
      query.from,
      true
    );
  } catch (err) {
    console.error('[maintainerr] error salvando media:', err.message);
    await botApi('answerCallbackQuery', {
      callback_query_id: query.id,
      text: 'Error al salvar, mira los logs',
    }).catch(() => {});
  }
}

// Segundo salvador (y siguientes) del MISMO ítem: no toca Maintainerr (ya
// está a salvo desde el primer clic), solo suma su fila si no la había ya y
// sigue dentro de la ventana de salvar (los días que tardaría en borrarse
// sola, ver maintainerr_candidates).
async function handleAddSaveCallback(query) {
  const mediaServerId = query.data.slice(ADD_SAVE_CALLBACK_PREFIX.length);
  try {
    const candidate = getCandidate.get(mediaServerId);
    if (candidate) {
      const closesAtMs = sqliteTextToMs(candidate.notified_at) + candidate.delete_after_days * 86_400_000;
      if (Date.now() >= closesAtMs) {
        await botApi('answerCallbackQuery', { callback_query_id: query.id, text: 'El plazo para salvarla ya pasó' });
        return;
      }
    }
    if (getSalvadoForItemAndUser.get(mediaServerId, String(query.from.id))) {
      await botApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Ya la salvaste' });
      return;
    }
    const existing = getSalvadosForItem.all(mediaServerId);
    const msgRow = getSalvadoMessage.get(mediaServerId);
    if (existing.length === 0 || !msgRow) {
      // No hay de dónde sacar título/tmdb/mensaje (se resolvió ya, o el bot
      // perdió el rastro) — no debería pasar con el botón vivo, pero por si acaso.
      await botApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Ya no se puede salvar' });
      return;
    }
    const ref = existing[0];
    insertSalvado.run(
      mediaServerId,
      ref.tmdb_id,
      ref.title,
      ref.poster_url,
      String(query.from.id),
      displayName(query.from),
      resolveTautulliUser(query.from.id),
      ref.library_id,
      toSqliteText(getFallbackDeadlineMs(mediaServerId))
    );

    await botApi('answerCallbackQuery', { callback_query_id: query.id, text: 'Salvada también' });
    await appendSavedNote(
      mediaServerId,
      { chatId: msgRow.chat_id, messageId: msgRow.message_id, hasPhoto: Boolean(msgRow.has_photo), baseText: msgRow.text },
      query.from,
      true
    );
  } catch (err) {
    console.error('[maintainerr] error sumando salvador:', err.message);
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
      `SELECT * FROM salvados WHERE user_id = ? AND resolved_at IS NULL AND expires_at > datetime('now') ORDER BY saved_at DESC`
    )
    .all(userId);
  return filterStillInCollection(rows);
}

export async function getAllSalvados() {
  const rows = db
    .prepare(`SELECT * FROM salvados WHERE resolved_at IS NULL AND expires_at > datetime('now') ORDER BY saved_at DESC`)
    .all();
  return filterStillInCollection(rows);
}

// Pedido de Edu (8 ago 2026): historial de salvadas de los últimos N días,
// activas o ya resueltas (borradas), con si cada salvador la ha visto o no —
// para la pestaña Salvadas del panel. A diferencia de getAllSalvados, no
// filtra por resolved_at/expires_at ni comprueba en vivo contra Maintainerr:
// es una foto del registro local, no del estado actual de "sigue salvada".
export function getSalvadosHistory(days = 30) {
  return db
    .prepare(
      `SELECT * FROM salvados WHERE saved_at >= datetime('now', '-' || ? || ' days') ORDER BY saved_at DESC`
    )
    .all(days);
}

// --- Borrado ligado a visionado (pedido de Edu, 8 ago 2026) ---
//
// Reglas: (1) sin salvar, sigue el deleteAfterDays normal de la colección
// origen — Maintainerr lo hace solo, nada que tocar aquí. (2) salvada y vista
// por TODOS los que la salvaron → se borra 24h después de la última en
// verla. (3) si a los 7 días de CERRARSE la ventana de salvar (o desde el
// primer salvado, si no hay dato de ventana) sigue sin verla todo el mundo,
// se borra igual. Todo esto vive en processSalvados, en el mismo ciclo de
// sondeo que pollMaintainerrCollections.

const WATCH_THRESHOLD_PERCENT = 85; // mismo criterio que el resto del proyecto (ver DEFAULT_SEASON_WATCHED_PERCENT en quota.js)
const POST_WATCH_GRACE_MS = 24 * 60 * 60 * 1000;

// Marca watched_at en las filas de un ítem cuyo salvador (vinculado a un
// usuario de Tautulli) lo haya visto DESPUÉS de salvarlo. Solo películas en
// v1: para series salvadas por temporada haría falta saber el total de
// episodios de la temporada para confirmarla "vista entera" (no solo un
// episodio suelto) — sin implementar todavía, esas filas se quedan sin
// watched_at para siempre y resuelven solo por el fallback de 7 días.
async function markWatchedRows(mediaServerId, rows) {
  const unresolved = rows.filter((r) => r.user_id != null && r.watched_at == null);
  if (unresolved.length === 0) return;
  if (isTvLibrary(rows[0].library_id)) return;

  let history;
  try {
    history = await getItemWatchHistory(mediaServerId, false);
  } catch (err) {
    console.error('[maintainerr] error consultando historial de visionado:', err.message);
    return;
  }
  for (const row of unresolved) {
    const savedAtMs = sqliteTextToMs(row.saved_at);
    const qualifying = history
      .filter((h) => h.userId === row.user_id && h.percent >= WATCH_THRESHOLD_PERCENT && h.watchedAt != null && h.watchedAt >= savedAtMs)
      .sort((a, b) => a.watchedAt - b.watchedAt);
    if (qualifying.length > 0) {
      updateSalvadoWatchedAt.run(toSqliteText(qualifying[0].watchedAt), row.id);
      row.watched_at = toSqliteText(qualifying[0].watchedAt);
    }
  }
}

// Qué colección de salvados tiene AHORA MISMO este ítem (para pedirle a
// Maintainerr que lo borre ya, ver media/handle) — se resuelve en vivo en vez
// de guardarla al salvar porque los pairs pueden cambiar entretanto.
async function findCurrentTargetCollection(mediaServerId) {
  const { pairs } = getMaintainerrSettings();
  if (pairs.length === 0) return null;
  const collections = await listCollections().catch(() => []);
  const targetTitles = new Set(pairs.map((p) => p.target));
  return (
    collections.find(
      (c) => targetTitles.has(c.title) && c.media?.some((m) => String(m.mediaServerId) === String(mediaServerId))
    ) ?? null
  );
}

// Anexa una línea al mensaje de salvado y, a diferencia de appendSavedNote,
// no vuelve a guardar la fila (se usa justo antes de borrarla).
async function closeSalvadoMessage(mediaServerId, suffix) {
  const row = getSalvadoMessage.get(mediaServerId);
  deleteSalvadoMessage.run(mediaServerId);
  if (!row) return;
  try {
    const method = row.has_photo ? 'editMessageCaption' : 'editMessageText';
    await botApi(method, {
      chat_id: row.chat_id,
      message_id: row.message_id,
      [row.has_photo ? 'caption' : 'text']: `${row.text}\n\n${suffix}`,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (err) {
    console.error('[maintainerr] error cerrando mensaje de salvado:', err.message);
  }
}

// Cierra la ventana de salvar: quita el botón "➕ Salvar también" y deja
// constancia en el propio mensaje, sin tocar las filas (el ítem sigue
// salvado, solo que ya no admite más gente).
async function noteWindowClosed(mediaServerId) {
  markWindowClosedNotified.run(mediaServerId);
  const row = getSalvadoMessage.get(mediaServerId);
  if (!row) return;
  const newText = `${row.text}\n\n⏰ Plazo para salvarla cerrado.`;
  try {
    const method = row.has_photo ? 'editMessageCaption' : 'editMessageText';
    await botApi(method, {
      chat_id: row.chat_id,
      message_id: row.message_id,
      [row.has_photo ? 'caption' : 'text']: newText,
      reply_markup: { inline_keyboard: [] },
    });
    upsertSalvadoMessage.run({ mediaServerId, chatId: row.chat_id, messageId: row.message_id, hasPhoto: row.has_photo, text: newText });
  } catch (err) {
    console.error('[maintainerr] error cerrando ventana de salvar:', err.message);
  }
}

async function finalizeSalvadoDeletion(mediaServerId) {
  const target = await findCurrentTargetCollection(mediaServerId);
  if (!target) {
    // Ya no está en ninguna colección de salvados vigilada (lo quitaron a
    // mano en Maintainerr, o se borró de otra forma) — se limpia el rastro
    // sin llamar a media/handle, que fallaría (el ítem ya no está ahí).
    resolveSalvadosForItem.run(mediaServerId);
    deleteCandidate.run(mediaServerId);
    await closeSalvadoMessage(mediaServerId, '🗑️ Ya no está salvada.');
    return;
  }
  try {
    await handleCollectionMedia(target.id, mediaServerId);
  } catch (err) {
    if (err.status === 409) return; // colección/regla en ejecución — se reintenta en el siguiente ciclo
    console.error('[maintainerr] error borrando salvado:', err.message);
    return;
  }
  resolveSalvadosForItem.run(mediaServerId);
  deleteCandidate.run(mediaServerId);
  await closeSalvadoMessage(mediaServerId, '🗑️ Borrada.');
}

export async function processSalvados() {
  if (!isEnabled()) return;
  const ids = distinctSalvadoMediaIds.all().map((r) => r.media_server_id);
  for (const mediaServerId of ids) {
    const rows = getSalvadosForItem.all(mediaServerId);
    if (rows.length === 0) continue;

    await markWatchedRows(mediaServerId, rows);

    const allWatched = rows.every((r) => r.watched_at != null);
    const dueMs = allWatched
      ? Math.max(...rows.map((r) => sqliteTextToMs(r.watched_at))) + POST_WATCH_GRACE_MS
      : getFallbackDeadlineMs(mediaServerId);
    updateSalvadosExpiresAt.run(toSqliteText(dueMs), mediaServerId);

    const candidate = getCandidate.get(mediaServerId);
    if (candidate && !candidate.window_closed_notified) {
      const closesAtMs = sqliteTextToMs(candidate.notified_at) + candidate.delete_after_days * 86_400_000;
      if (Date.now() >= closesAtMs) await noteWindowClosed(mediaServerId);
    }

    if (Date.now() >= dueMs) await finalizeSalvadoDeletion(mediaServerId);
  }
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
            } else if (data?.startsWith(ADD_SAVE_CALLBACK_PREFIX)) {
              await handleAddSaveCallback(u.callback_query);
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
  const pollCollections = () => {
    pollMaintainerrCollections().catch((err) => console.error('[maintainerr] sondeo de colecciones falló:', err.message));
    processSalvados().catch((err) => console.error('[maintainerr] sondeo de salvados falló:', err.message));
  };
  pollCollections();
  setInterval(pollCollections, 60 * 1000);
}
