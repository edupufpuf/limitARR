import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { getRawSetting, setRawSetting } from './settings.js';
import { listPendingRequests, approveRequest, declineRequest, getMediaDetails, getMovieAvailability, listRecentlyApprovedRequests, createSeasonRequest } from './services/seerr.js';
import { getUsers, getActiveSessions, terminateSession } from './services/tautulli.js';
import { getBalance, getMonthlyTotalQuota, reconcileVoidedRequests, refreshQuotaCache, listStaleOutstandingPairs, normalize, getRequestHold, clearRequestHold, pruneStaleQuotaCache } from './quota.js';
import { sendMessage, getNotifyTarget, pendingButton, isNotificationEnabled, renderNotificationMessage } from './services/telegram.js';
import { matchByEmailOrUsername } from './userMatch.js';
import { isSessionGuardEnabled } from './sessionGuard.js';
import { getBroadcastSettings, hasSeenBroadcast, markBroadcastSeen } from './services/broadcast.js';

const insertLog = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, poster_url, balance_before, limit_applied, decision)
  VALUES
    (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, @posterUrl, @balanceBefore, @limitApplied, @decision)
`);
const getLibraryForRequest = db.prepare(`
  SELECT * FROM libraries WHERE section_type = ? AND kind = ? AND enabled = 1 LIMIT 1
`);
const getLastDecision = db.prepare(`
  SELECT decision FROM decisions_log
  WHERE request_id = ?
    AND media_type = ?
    AND COALESCE(season_number, -1) = COALESCE(?, -1)
  ORDER BY id DESC LIMIT 1
`);
const getLibraryName = db.prepare('SELECT name FROM libraries WHERE id = ?');
const getChatId = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?');
// Pedido de Edu (3 ago 2026): si un request_id no tiene NINGUNA fila en
// decisions_log, limitARR nunca lo vio pasar por la cola de pendientes —
// alguien lo aprobó directo en Seerr (admin autoaprobado, o aprobado a mano
// en la web de Seerr). Aviso informativo aparte, sin cupo de por medio.
const hasAnyDecisionForRequest = db.prepare('SELECT 1 FROM decisions_log WHERE request_id = ? LIMIT 1');
const insertBypassedApprovalLog = db.prepare(`
  INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, decision)
  VALUES (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, 'approved_outside_limitarr')
`);
const getCacheRow = db.prepare('SELECT outstanding, pending_items FROM quota_cache WHERE user_id = ? AND library_id = ?');
// Para etiquetar en el Registro quién liberó cupo: los pending_items de la
// caché no llevan username, así que se toma el último conocido para ese
// usuario+biblioteca (viene de sus propias filas 'approved').
const getLastUsernameForUser = db.prepare(`
  SELECT username FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND username IS NOT NULL
  ORDER BY id DESC LIMIT 1
`);
// Pedido de Edu (2 ago 2026): si a las 12h de aprobarse sigue sin estar en
// Plex, avisar una vez de que aún no está disponible — antes solo se avisaba
// al aprobar/rechazar, y el usuario se quedaba sin saber por qué no llegaba.
const STILL_UNAVAILABLE_HOURS = 12;
const getUnnotifiedOldApprovals = db.prepare(`
  SELECT dl.id, dl.request_id, dl.user_id, dl.username, dl.library_id, dl.media_title, dl.media_type,
         dl.tmdb_id, dl.season_number, dl.created_at, l.kind AS library_kind
  FROM decisions_log dl
  JOIN libraries l ON l.id = dl.library_id
  WHERE dl.decision = 'approved' AND dl.voided_at IS NULL AND l.enabled = 1
    AND dl.tmdb_id IS NOT NULL AND dl.user_id IS NOT NULL
    AND dl.created_at <= datetime('now', '-' || ? || ' hours')
    AND NOT EXISTS (
      SELECT 1 FROM decisions_log r
      WHERE r.request_id = dl.request_id AND r.media_type = dl.media_type
        AND COALESCE(r.season_number, -1) = COALESCE(dl.season_number, -1)
        AND r.decision = 'unavailable_reminder'
    )
`);
const insertUnavailableReminder = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, decision, created_at)
  VALUES
    (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, 'unavailable_reminder', datetime('now'))
`);

// Issue #13 (fase 3): cola secuencial de temporadas en espera (ver season_queue en db.js).
const insertSeasonQueue = db.prepare(`
  INSERT INTO season_queue (tmdb_id, season_number, user_id, seerr_user_id, library_id)
  VALUES (@tmdbId, @seasonNumber, @userId, @seerrUserId, @libraryId)
`);
const getSeasonQueueRows = db.prepare(`
  SELECT * FROM season_queue ORDER BY tmdb_id, user_id, season_number ASC
`);
const deleteSeasonQueueRow = db.prepare('DELETE FROM season_queue WHERE id = ?');

// Avoids re-logging (and re-notifying) the same still-pending request every poll
// cycle when nothing about its situation has changed since the last time.
function logIfChanged(base, decision) {
  const last = getLastDecision.get(base.requestId, base.mediaType, base.seasonNumber ?? null)?.decision;
  if (last === decision) return false;
  insertLog.run({ ...base, decision });
  return true;
}

async function notifyNoQuota(base) {
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const replyMarkup = pendingButton(base.userId, base.libraryId);
  const unit = base.mediaType === 'tv' ? 'una temporada' : 'una película';

  if (!isNotificationEnabled('no_quota')) return;

  // Aviso personal, solo DM al que pidió — nunca al grupo, aunque el modo
  // esté en 'group' (ese modo es solo para el resumen manual de pendientes).
  const chatId = getChatId.get(base.userId)?.chat_id;
  if (!chatId) return;
  const text = renderNotificationMessage('no_quota', {
    usuario: base.username ?? '',
    biblioteca: libraryName,
    titulo: base.mediaTitle ?? unit ?? 'un contenido',
    tipo: unit ?? 'un contenido',
  });
  try {
    await sendMessage(chatId, text, { replyMarkup });
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// v2: cupo mensual agotado.
async function notifyNoMonthlyQuota(base, monthly) {
  if (!isNotificationEnabled('monthly_quota')) return;

  const chatId = getChatId.get(base.userId)?.chat_id;
  if (!chatId) return;
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const text = renderNotificationMessage('monthly_quota', {
    usuario: base.username ?? '',
    biblioteca: libraryName,
    titulo: base.mediaTitle ?? 'tu solicitud',
    usado: monthly.used,
    limite: monthly.limit,
    dias: monthly.daysUntilReset,
    plural: monthly.daysUntilReset === 1 ? '' : 's',
  });
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// v3: cupo mensual TOTAL agotado — igual que notifyNoMonthlyQuota pero deja
// claro que el tope es el global (todas las bibliotecas combinadas), no el de
// esta biblioteca en concreto.
async function notifyNoMonthlyTotalQuota(base, monthlyTotal) {
  if (!isNotificationEnabled('monthly_total_quota')) return;

  const chatId = getChatId.get(base.userId)?.chat_id;
  if (!chatId) return;
  const text = renderNotificationMessage('monthly_total_quota', {
    usuario: base.username ?? '',
    titulo: base.mediaTitle ?? 'tu solicitud',
    usado: monthlyTotal.used,
    limite: monthlyTotal.limit,
    dias: monthlyTotal.daysUntilReset,
    plural: monthlyTotal.daysUntilReset === 1 ? '' : 's',
  });
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// v2: temporizador de aprobación — aviso de que una solicitud concreta queda
// aplazada hasta una fecha (acción puntual del admin, no una norma del usuario).
async function notifyHeld(base, holdUntilMs) {
  if (!isNotificationEnabled('held')) return;

  const chatId = getChatId.get(base.userId)?.chat_id;
  if (!chatId) return;
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const dateStr = new Date(holdUntilMs).toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
  const text = renderNotificationMessage('held', {
    usuario: base.username ?? '',
    biblioteca: libraryName,
    titulo: base.mediaTitle ?? 'tu solicitud',
    fecha: dateStr,
  });
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// Issue #13: aviso de rechazo por pedir varias temporadas de golpe, para que el
// usuario sepa qué hacer (pedir de una en una) en vez de ver la solicitud
// desaparecer en silencio.
async function notifyMultiSeasonDeclined(base, seasonsCount) {
  if (!isNotificationEnabled('multi_season_declined')) return;

  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const text = renderNotificationMessage('multi_season_declined', {
    usuario: base.username ?? '',
    biblioteca: libraryName,
    titulo: base.mediaTitle ?? 'una serie',
    temporadas: seasonsCount,
  });

  const target = getNotifyTarget();
  try {
    if (target.mode === 'group') {
      if (!target.groupChatId) return;
      await sendMessage(target.groupChatId, text, { messageThreadId: target.groupTopicId });
    } else {
      const chatId = getChatId.get(base.userId)?.chat_id;
      if (!chatId) return;
      await sendMessage(chatId, text);
    }
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// Issue #13 (fase 3): aviso al dividir una solicitud multi-temporada — la más
// baja se manda a Seerr y sigue el flujo normal (cupo), el resto queda en cola.
async function notifySequentialSplit(base, firstSeason, restSeasons) {
  if (!isNotificationEnabled('sequential_split')) return;

  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const restText = restSeasons.length === 1
    ? `la temporada ${restSeasons[0]}`
    : `las temporadas ${restSeasons.join(', ')}`;
  const text = renderNotificationMessage('sequential_split', {
    usuario: base.username ?? '',
    biblioteca: libraryName,
    titulo: base.mediaTitle ?? 'Tu solicitud',
    primera: firstSeason,
    resto: restText,
  });

  const target = getNotifyTarget();
  try {
    if (target.mode === 'group') {
      if (!target.groupChatId) return;
      await sendMessage(target.groupChatId, text, { messageThreadId: target.groupTopicId });
    } else {
      const chatId = getChatId.get(base.userId)?.chat_id;
      if (!chatId) return;
      await sendMessage(chatId, text);
    }
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// Issue #13 (fase 2): aviso de "en cola" — la solicitud no se pierde, espera a
// que el usuario termine la temporada que tiene pendiente de esa serie.
async function notifySeasonHold(base) {
  if (!isNotificationEnabled('season_hold')) return;

  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const text = renderNotificationMessage('season_hold', {
    usuario: base.username ?? '',
    biblioteca: libraryName,
    titulo: base.mediaTitle ?? 'una temporada',
  });

  const target = getNotifyTarget();
  try {
    if (target.mode === 'group') {
      if (!target.groupChatId) return;
      await sendMessage(target.groupChatId, text, { messageThreadId: target.groupTopicId });
    } else {
      const chatId = getChatId.get(base.userId)?.chat_id;
      if (!chatId) return;
      await sendMessage(chatId, text);
    }
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// "Te quedan N huecos" (saldo/cupo) resultaba lioso para Edu — un usuario no
// entiende bien qué es un "hueco". Lista en su lugar los títulos que tiene
// pendientes de ver en esta biblioteca (aprobados, estén ya en Plex o no),
// que es la pregunta real del usuario.
// Aviso de aprobación: cierra el ciclo con el usuario (antes solo se le avisaba
// de lo malo, el "sin cupo"). `pendingItems` = pendientes de esta biblioteca
// tras la aprobación (incluye la recién aprobada).
async function notifyApproved(base, pendingItems) {
  if (!isNotificationEnabled('approved')) return;

  // Aviso personal, solo DM al que pidió — nunca al grupo.
  const chatId = getChatId.get(base.userId)?.chat_id;
  if (!chatId) return;
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const titles = pendingItems.map((item) => item.title).filter(Boolean);
  const list = titles.length > 0
    ? titles.map((t) => `• ${t}`).join('\n')
    : 'nada más por ahora';
  const text = renderNotificationMessage('approved', {
    titulo: base.mediaTitle,
    biblioteca: libraryName,
    lista: list,
  });
  try {
    await sendMessage(chatId, text);
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// Clave estable de un pendiente para comparar caché vieja vs nueva.
function pendingItemKey(item) {
  if (item.tmdbId != null) return `${item.tmdbId}:${item.seasonNumber ?? ''}`;
  return `t:${normalize(item.title)}`;
}

// Registra en decisions_log un pendiente que ha salido de la lista (visto, o
// caducado) al comparar la caché de antes con la de después. Independiente
// del aviso de Telegram: queda en el Registro se avise o no.
function logFreedItem(userId, libraryId, item, decision, limitApplied) {
  const username = getLastUsernameForUser.get(userId, libraryId)?.username ?? null;
  insertLog.run({
    requestId: item.requestId ?? -Date.now(),
    userId,
    username,
    libraryId,
    mediaTitle: item.title ?? null,
    mediaType: item.mediaType ?? 'movie',
    tmdbId: item.tmdbId ?? null,
    seasonNumber: item.seasonNumber ?? null,
    posterUrl: item.posterUrl ?? null,
    balanceBefore: null,
    limitApplied: limitApplied ?? null,
    decision,
  });
}

// Aviso de cupo liberado: al refrescar los pares con pendientes (issue #5) se
// compara la caché de antes con la de después — lo que desaparece de la lista
// con el contador bajando es cupo liberado (visto, o caducado por fecha). Cada
// ítem liberado queda logueado en el Registro ('watched' o 'expired' según si
// ya había pasado su expiresAt), y además se avisa por Telegram si está
// activado. Los avisos van tras el refresco para no retrasar la caché si
// Telegram cojea.
async function refreshStaleAndNotify() {
  const pairs = listStaleOutstandingPairs();

  for (const { user_id, library_id } of pairs) {
    const before = getCacheRow.get(user_id, library_id);
    const result = await refreshQuotaCache(user_id, library_id);

    if (!before || result.outstanding >= before.outstanding) continue;

    let oldItems = [];
    try {
      oldItems = JSON.parse(before.pending_items || '[]');
    } catch { /* caché de una versión anterior */ }
    const newKeys = new Set(result.pendingItems.map(pendingItemKey));
    const freedItems = oldItems.filter((item) => !newKeys.has(pendingItemKey(item)));
    if (freedItems.length === 0) continue;

    const nowMs = Date.now();
    for (const item of freedItems) {
      const decision = item.expiresAt != null && item.expiresAt <= nowMs ? 'expired' : 'watched';
      logFreedItem(user_id, library_id, item, decision, result.limit);
    }

    if (!isNotificationEnabled('freed')) continue;

    const freedTitles = freedItems.map((item) => item.title).filter(Boolean);
    if (freedTitles.length === 0) continue;

    // Aviso personal, solo DM al usuario — nunca al grupo. Un grupo agregado
    // (user_id < 0, issue #4) no tiene DM propio, así que no recibe aviso.
    const chatId = getChatId.get(user_id)?.chat_id;
    if (!chatId) continue;

    const libraryName = getLibraryName.get(library_id)?.name ?? `biblioteca #${library_id}`;
    const list = freedTitles.map((t) => `• ${t}`).join('\n');
    const saldo = `Saldo en ${libraryName}: ${result.balance} de ${result.limit}.`;
    const text = renderNotificationMessage('freed', { lista: list, saldo });
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      console.error('[scheduler] telegram notify failed:', err.message);
    }
  }
  return pairs.length;
}

// Pedido de Edu (2 ago 2026): aviso único a las 12h si la aprobación sigue sin
// llegar a Plex. Idempotente vía el propio 'unavailable_reminder' en
// decisions_log (mismo patrón que hasWatchedOrExpired en quota.js) — no se
// repite aunque tarde más. Se agrupan las películas por kind (HD/4K) para
// consultar Seerr una vez por biblioteca en vez de una por título.
export async function notifyStillUnavailable() {
  if (!isNotificationEnabled('still_unavailable')) return;
  const rows = getUnnotifiedOldApprovals.all(STILL_UNAVAILABLE_HOURS);
  if (rows.length === 0) return;

  const movieTmdbIdsByKind = new Map();
  for (const row of rows) {
    if (row.media_type === 'tv') continue;
    const kind = row.library_kind || 'standard';
    if (!movieTmdbIdsByKind.has(kind)) movieTmdbIdsByKind.set(kind, new Set());
    movieTmdbIdsByKind.get(kind).add(row.tmdb_id);
  }
  const movieAvailabilityByKind = new Map();
  for (const [kind, ids] of movieTmdbIdsByKind) {
    movieAvailabilityByKind.set(kind, await getMovieAvailability([...ids], kind === '4k'));
  }
  const tvDetailsCache = new Map();

  for (const row of rows) {
    let unavailable;
    if (row.media_type === 'tv') {
      const cacheKey = `${row.tmdb_id}:${row.season_number}`;
      if (!tvDetailsCache.has(cacheKey)) {
        tvDetailsCache.set(cacheKey, await getMediaDetails('tv', row.tmdb_id, row.season_number));
      }
      const details = tvDetailsCache.get(cacheKey);
      // seasonStatuses null = error de red: no se sabe, no se avisa de nada.
      unavailable = details?.seasonStatuses != null && (details.seasonStatuses[row.season_number] ?? 0) < 4;
    } else {
      const kind = row.library_kind || 'standard';
      unavailable = movieAvailabilityByKind.get(kind)?.get(row.tmdb_id)?.unavailable ?? false;
    }
    if (!unavailable) continue; // ya llegó entretanto, no hace falta avisar de esto

    insertUnavailableReminder.run({
      requestId: row.request_id,
      userId: row.user_id,
      username: row.username,
      libraryId: row.library_id,
      mediaTitle: row.media_title,
      mediaType: row.media_type,
      tmdbId: row.tmdb_id,
      seasonNumber: row.season_number,
    });

    const chatId = getChatId.get(row.user_id)?.chat_id;
    if (!chatId) continue;
    const text = renderNotificationMessage('still_unavailable', { titulo: row.media_title ?? 'Tu solicitud' });
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      console.error('[scheduler] telegram notify failed:', err.message);
    }
  }
}

// Pedido de Edu (2 ago 2026): mismo usuario con 2+ sesiones de Plex a la vez
// — se corta(n) la(s) más nueva(s), se deja la que ya estaba viendo desde
// antes. Los admins (is_admin de Tautulli) nunca se cortan; el resto puede
// desactivarlo desde su panel (isSessionGuardEnabled, activado por defecto).
// Sin catch general: si Tautulli no está configurado o está caído, que no
// tumbe el resto del ciclo de sondeo por esto.
const DUPLICATE_SESSION_MESSAGE = 'Ya tienes otra sesión activa en este usuario — ciérrala primero.';

export async function enforceSingleSession() {
  let sessions;
  try {
    sessions = await getActiveSessions();
  } catch (err) {
    console.error('[scheduler] get_activity failed:', err.message);
    return;
  }
  if (sessions.length === 0) return;

  const users = await getUsers();
  const adminIds = new Set(users.filter((u) => u.isAdmin).map((u) => u.id));

  const byUser = new Map();
  for (const s of sessions) {
    if (!byUser.has(s.userId)) byUser.set(s.userId, []);
    byUser.get(s.userId).push(s);
  }

  for (const [userId, userSessions] of byUser) {
    if (userSessions.length < 2) continue;
    if (adminIds.has(userId)) continue;
    if (!isSessionGuardEnabled(userId)) continue;

    // La más vieja (started más bajo) se queda; el resto se corta.
    const sorted = [...userSessions].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const session of sorted.slice(1)) {
      try {
        await terminateSession(session.sessionKey, DUPLICATE_SESSION_MESSAGE);
      } catch (err) {
        console.error('[scheduler] terminate_session failed:', err.message);
      }
    }
  }
}

// Pedido de Edu (10 ago 2026): empujar a vincular Telegram (para avisos de
// cupo y borrados automáticos de Maintainerr) a quien todavía no lo ha hecho.
// terminate_session con mensaje es la única forma de pop-up real que expone
// la API de Plex/Tautulli — corta la reproducción a la vez que lo enseña, así
// que solo se dispara UNA vez por usuario (broadcast_seen) mientras el aviso
// siga activo con el mismo texto, y NUNCA a quien ya tiene Telegram vinculado
// (getChatId, misma tabla que usa el resto de avisos).
export async function enforceBroadcast() {
  const { enabled, message } = getBroadcastSettings();
  if (!enabled || !message) return;

  let sessions;
  try {
    sessions = await getActiveSessions();
  } catch (err) {
    console.error('[scheduler] get_activity failed (broadcast):', err.message);
    return;
  }
  if (sessions.length === 0) return;

  const users = await getUsers();
  const adminIds = new Set(users.filter((u) => u.isAdmin).map((u) => u.id));

  for (const session of sessions) {
    if (adminIds.has(session.userId)) continue; // el propietario ya conoce el panel
    if (getChatId.get(session.userId)) continue; // ya vinculado, no hace falta insistir
    if (hasSeenBroadcast(session.userId, message)) continue;
    try {
      await terminateSession(session.sessionKey, message);
    } catch (err) {
      console.error('[scheduler] terminate_session failed (broadcast):', err.message);
      continue;
    }
    markBroadcastSeen(session.userId, message);
  }
}

// Pedido de Edu (3 ago 2026): caso admin (o cualquiera con autoaprobar) —
// Seerr aprueba al instante, sin pasar por la cola de pendientes. Aviso
// informativo aparte (sin cupo, no hay saldo que dar), una vez por
// request_id — se marca en el Registro para no repetir.
export async function notifyBypassedApprovals() {
  if (!isNotificationEnabled('bypassed_approved')) return;

  let requests;
  try {
    requests = await listRecentlyApprovedRequests();
  } catch (err) {
    console.error('[scheduler] listRecentlyApprovedRequests failed:', err.message);
    return;
  }
  const pending = requests.filter((r) => !hasAnyDecisionForRequest.get(r.id));
  if (pending.length === 0) return;

  const tautulliUsers = await getUsers();

  for (const request of pending) {
    const tautulliUser = matchByEmailOrUsername(tautulliUsers, request.requestedBy);
    const seasons = request.mediaType === 'tv' ? request.seasons : [];
    const details = await getMediaDetails(request.mediaType, request.tmdbId, seasons[0] ?? null);
    const mediaTitle = seasons.length > 1
      ? `${details.title ?? 'Serie'} - Temporadas ${seasons.join(', ')}`
      : formatMediaTitle(request.mediaType, details.title, seasons[0] ?? null);
    // Sin library_id no hay dónde colgar el pendiente (getBalance filtra por
    // biblioteca) — mismo criterio que en el flujo normal: sectionType+kind.
    const sectionType = request.mediaType === 'tv' ? 'show' : 'movie';
    const library = getLibraryForRequest.get(sectionType, request.is4k ? '4k' : 'standard');

    const base = {
      requestId: request.id,
      userId: tautulliUser?.id ?? null,
      username: tautulliUser?.username ?? request.requestedBy.username ?? null,
      libraryId: library?.id ?? null,
      mediaTitle,
      mediaType: request.mediaType,
      tmdbId: request.tmdbId ?? null,
      seasonNumber: seasons[0] ?? null,
    };

    // Pedido de Edu (6 ago 2026): un bypass en nombre de OTRO usuario (no
    // admin) -Edu pide algo para otra persona en Seerr y se autoaprueba al
    // instante por ser él admin- sí tiene que restar cupo de esa persona,
    // como una aprobación normal; antes solo quedaba como informativo (por
    // eso Edu tenía que meterlo a mano con cargo manual). Solo se queda
    // informativo cuando el bypass es del propio admin pidiendo para sí
    // mismo, o de alguien sin match en Tautulli.
    if (tautulliUser && !tautulliUser.isAdmin) {
      insertLog.run({ ...base, posterUrl: null, balanceBefore: null, limitApplied: null, decision: 'approved' });
    } else {
      insertBypassedApprovalLog.run(base);
    }

    if (!tautulliUser) continue;
    const chatId = getChatId.get(tautulliUser.id)?.chat_id;
    if (!chatId) continue;
    const text = renderNotificationMessage('bypassed_approved', { titulo: mediaTitle ?? 'tu solicitud' });
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      console.error('[scheduler] telegram notify failed:', err.message);
    }
  }
}

// Mantenimiento diario, colgado del propio ciclo de sondeo (no hace falta otro
// timer): retención del registro y backup de la DB. Se apunta el día en
// settings para ejecutarse una sola vez aunque haya muchos ciclos.
const MAINTENANCE_KEY = 'last_maintenance_day';
const purgeOldDecisions = db.prepare(`
  DELETE FROM decisions_log
  WHERE created_at < datetime('now', '-' || ? || ' days')
    AND (decision != 'approved' OR voided_at IS NOT NULL)
`);

async function runDailyMaintenance() {
  const today = new Date().toISOString().slice(0, 10);
  if (getRawSetting(MAINTENANCE_KEY) === today) return;
  setRawSetting(MAINTENANCE_KEY, today);

  // Retención: solo filas que ya no afectan al cupo (anuladas, o bloqueos y
  // errores viejos). Una aprobada viva no se toca nunca, por vieja que sea:
  // sigue contando hasta que se vea.
  try {
    const { changes } = purgeOldDecisions.run(config.decisionsRetentionDays);
    if (changes > 0) console.log(`[maintenance] registro: ${changes} fila(s) antiguas purgadas`);
  } catch (err) {
    console.error('[maintenance] purge failed:', err.message);
  }

  // Sincroniza la caché de cupo con la lista de usuarios activos de Tautulli:
  // a quien se le quita el compartido en Plex se le queda la tarjeta fantasma
  // en la pestaña Cupo si no se limpia (decisions_log no se toca, es historial).
  try {
    const removed = await pruneStaleQuotaCache();
    if (removed > 0) console.log(`[maintenance] cupo: ${removed} usuario(s) ya no activos en Tautulli, caché limpiada`);
  } catch (err) {
    console.error('[maintenance] prune quota_cache failed:', err.message);
  }

  // Backup diario con la API online de SQLite (consistente aunque haya
  // escrituras), junto a la DB — en Docker cae dentro del volumen /data.
  if (config.dbPath !== ':memory:') {
    try {
      const dir = path.join(path.dirname(config.dbPath), 'backups');
      fs.mkdirSync(dir, { recursive: true });
      await db.backup(path.join(dir, `limitarr-${today}.db`));
      const backups = fs
        .readdirSync(dir)
        .filter((f) => /^limitarr-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort();
      for (const old of backups.slice(0, -config.backupKeep)) {
        fs.unlinkSync(path.join(dir, old));
      }
      console.log(`[maintenance] backup ${today} OK (${Math.min(backups.length, config.backupKeep)} conservados)`);
    } catch (err) {
      console.error('[maintenance] backup failed:', err.message);
    }
  }
}

// Issue #13 (fase 3): en cuanto la temporada en curso de una serie sale de
// pendientes (vista), pide en Seerr la siguiente temporada en cola — una fila
// por tmdb_id+usuario (solo se procesa la más baja de cada grupo; el resto
// espera su turno). La solicitud nueva entra en el flujo normal (cupo,
// aprobación) del próximo ciclo, igual que cualquier otra.
export async function processSeasonQueue() {
  const rows = getSeasonQueueRows.all();
  if (rows.length === 0) return;

  // Fetch propio (no el `pending` ya leído al principio del ciclo): la
  // temporada en curso puede haberse creado en Seerr en ESTE mismo ciclo (justo
  // antes, al dividir la solicitud multi-temporada) y aún no estar aprobada —
  // sin este fetch fresco, pendingItems saldría vacío (nada logueado como
  // 'approved' todavía) y se adelantaría la cola antes de tiempo.
  const pending = await listPendingRequests();
  const seenShows = new Set();
  for (const row of rows) {
    const showKey = `${row.tmdb_id}:${row.user_id}`;
    if (seenShows.has(showKey)) continue; // solo la más baja de cada serie+usuario
    seenShows.add(showKey);

    const { pendingItems } = await getBalance(row.user_id, row.library_id);
    const sameShowUnwatched = pendingItems.some((item) => item.tmdbId === row.tmdb_id);
    const lowerSeasonPending = pending.some(
      (other) =>
        other.mediaType === 'tv' &&
        other.tmdbId === row.tmdb_id &&
        other.requestedBy?.id === row.seerr_user_id &&
        other.seasons.length > 0 &&
        Math.min(...other.seasons) < row.season_number
    );
    if (sameShowUnwatched || lowerSeasonPending) continue; // aún viendo/esperando la anterior

    try {
      await createSeasonRequest(row.tmdb_id, row.season_number, row.seerr_user_id);
      deleteSeasonQueueRow.run(row.id);
    } catch (err) {
      console.error('[scheduler] season_queue: no se pudo pedir la siguiente temporada:', err.message);
    }
  }
}

export async function runPollCycle() {
  await runDailyMaintenance();
  await reconcileVoidedRequests();

  const [pending, tautulliUsers] = await Promise.all([
    listPendingRequests(),
    getUsers(),
  ]);

  for (const request of pending) {
    const sectionType = request.mediaType === 'tv' ? 'show' : 'movie';
    const library = getLibraryForRequest.get(sectionType, request.is4k ? '4k' : 'standard');
    const tautulliUser = matchByEmailOrUsername(tautulliUsers, request.requestedBy || {});
    const requestedSeasons = request.mediaType === 'tv' && request.seasons.length > 0 ? request.seasons : [null];

    const base = {
      requestId: request.id,
      userId: tautulliUser?.id ?? null,
      username: tautulliUser?.username ?? request.requestedBy?.username ?? 'unknown',
      libraryId: library?.id ?? null,
      mediaTitle: null,
      mediaType: request.mediaType,
      tmdbId: request.tmdbId ?? null,
      seasonNumber: requestedSeasons[0],
      posterUrl: null,
      balanceBefore: null,
      limitApplied: null,
    };

    if (!library) {
      logIfChanged(base, 'no_library_config');
      continue;
    }
    if (!tautulliUser) {
      logIfChanged(base, 'unmatched_user');
      continue;
    }

    // v2: temporizador de aprobación — el admin aplazó ESTA solicitud concreta
    // (acción puntual, no una norma del usuario) hasta una fecha; se comprueba
    // antes que cualquier otra regla, aunque haya cupo de sobra.
    const hold = getRequestHold(request.id);
    if (hold) {
      if (hold.holdUntil > Date.now()) {
        const details = await getMediaDetails(request.mediaType, request.tmdbId, requestedSeasons[0]);
        base.mediaTitle = formatMediaTitle(request.mediaType, details.title, requestedSeasons[0]);
        base.posterUrl = details.posterUrl;
        base.seasonNumber = null; // aplaza la solicitud entera, no una temporada suelta
        if (logIfChanged(base, 'held')) await notifyHeld(base, hold.holdUntil);
        continue;
      }
      clearRequestHold(request.id); // plazo cumplido: se limpia y sigue el flujo normal
    }

    // Issue #13: temporada a temporada. Con sequential_seasons activo, una
    // solicitud con varias temporadas de golpe ya no se rechaza entera (fase 3,
    // pedido de Edu tras el caso Ted Lasso 2+3+4): se rechaza en Seerr pero se
    // vuelve a pedir solo la más baja, y el resto queda en season_queue para
    // pedirse solo cuando le toque (ver processSeasonQueue). Con
    // one_season_per_request SIN cola secuencial se mantiene el rechazo entero
    // de siempre (el usuario debe volver a pedir él mismo, de una en una).
    if (request.mediaType === 'tv' && requestedSeasons.length > 1 && (library.one_season_per_request || library.sequential_seasons)) {
      const details = await getMediaDetails(request.mediaType, request.tmdbId, requestedSeasons[0]);
      base.mediaTitle = details.title;
      base.posterUrl = details.posterUrl;
      base.seasonNumber = null; // la decisión aplica a la solicitud entera

      if (library.sequential_seasons && request.tmdbId != null) {
        const [firstSeason, ...restSeasons] = [...requestedSeasons].sort((a, b) => a - b);
        await declineRequest(request.id);
        try {
          await createSeasonRequest(request.tmdbId, firstSeason, request.requestedBy?.id);
          for (const seasonNumber of restSeasons) {
            insertSeasonQueue.run({
              tmdbId: request.tmdbId,
              seasonNumber,
              userId: tautulliUser.id,
              seerrUserId: request.requestedBy?.id ?? null,
              libraryId: library.id,
            });
          }
          if (logIfChanged(base, 'split_sequential')) {
            await notifySequentialSplit(base, firstSeason, restSeasons);
          }
        } catch (err) {
          console.error('[scheduler] no se pudo dividir la solicitud multi-temporada:', err.message);
        }
        continue;
      }

      await declineRequest(request.id);
      if (logIfChanged(base, 'declined_multi_season')) {
        await notifyMultiSeasonDeclined(base, requestedSeasons.length);
      }
      continue;
    }

    const detailsBySeason = new Map();
    for (const seasonNumber of requestedSeasons) {
      const details = await getMediaDetails(request.mediaType, request.tmdbId, seasonNumber);
      detailsBySeason.set(seasonNumber ?? 'movie', details);
    }

    const firstDetails = detailsBySeason.get(requestedSeasons[0] ?? 'movie') || {};
    base.mediaTitle = formatMediaTitle(request.mediaType, firstDetails.title, requestedSeasons[0]);
    base.posterUrl = firstDetails.posterUrl;

    const { limit, balance, pendingItems, monthly } = await getBalance(tautulliUser.id, library.id);

    // Issue #13 (fase 2): cola secuencial. La solicitud espera en Seerr si el
    // usuario ya tiene una temporada de ESTA serie sin terminar de ver, o si
    // hay otra solicitud pendiente suya de una temporada menor (se aprueba
    // siempre la más baja primero). Al terminar la temporada en curso, el
    // siguiente ciclo la deja pasar y sigue el flujo normal de cupo.
    if (library.sequential_seasons && request.mediaType === 'tv' && request.tmdbId != null) {
      const minSeason = Math.min(...requestedSeasons.map((s) => s ?? 0));
      const sameShowUnwatched = pendingItems.some((item) => item.tmdbId === request.tmdbId);
      const lowerSeasonQueued = pending.some(
        (other) =>
          other.id !== request.id &&
          other.mediaType === 'tv' &&
          other.tmdbId === request.tmdbId &&
          other.requestedBy?.id === request.requestedBy?.id &&
          other.seasons.length > 0 &&
          Math.min(...other.seasons) < minSeason
      );
      if (sameShowUnwatched || lowerSeasonQueued) {
        base.balanceBefore = balance;
        base.limitApplied = limit;
        if (logIfChanged(base, 'season_hold')) await notifySeasonHold(base);
        continue;
      }
    }

    const requiredUnits = request.mediaType === 'tv' ? requestedSeasons.length : 1;
    // v2: cupo mensual — tope aparte del saldo de pendientes por ver; agotado
    // bloquea igual aunque el usuario tenga saldo libre.
    const monthlyOk = !monthly.enabled || monthly.remaining >= requiredUnits;
    // v3: cupo mensual TOTAL — igual que el anterior, pero sumando todas las
    // bibliotecas; se comprueba aparte porque puede estar activado aunque esta
    // biblioteca en concreto no tenga cupo mensual propio.
    const monthlyTotal = await getMonthlyTotalQuota(tautulliUser.id);
    const monthlyTotalOk = !monthlyTotal.enabled || monthlyTotal.remaining >= requiredUnits;
    const decision =
      balance >= requiredUnits && monthlyOk && monthlyTotalOk
        ? 'approved'
        : !monthlyTotalOk
          ? 'no_monthly_total_quota'
          : monthlyOk
            ? 'no_quota'
            : 'no_monthly_quota';

    if (decision === 'approved') {
      await approveRequest(request.id);
    }

    base.balanceBefore = balance;
    base.limitApplied = limit;
    const rowsToLog = decision === 'approved'
      ? requestedSeasons.map((seasonNumber) => {
          const details = detailsBySeason.get(seasonNumber ?? 'movie') || {};
          return {
            ...base,
            mediaTitle: formatMediaTitle(request.mediaType, details.title, seasonNumber),
            seasonNumber,
            posterUrl: details.posterUrl ?? null,
          };
        })
      : [base];

    let isNew = false;
    for (const row of rowsToLog) {
      isNew = logIfChanged(row, decision) || isNew;
    }
    if (decision === 'no_quota' && isNew) await notifyNoQuota(base);
    if (decision === 'no_monthly_quota' && isNew) await notifyNoMonthlyQuota(base, monthly);
    if (decision === 'no_monthly_total_quota' && isNew) await notifyNoMonthlyTotalQuota(base, monthlyTotal);

    // Recalcula la caché de verdad (con la aprobación recién logueada incluida)
    // en vez de ajustar el contador a mano — así pending_items queda al día y
    // el panel enseña la película nueva sin esperar al siguiente sondeo. El
    // aviso de aprobado necesita este resultado para listar lo pendiente.
    const refreshed = await refreshQuotaCache(tautulliUser.id, library.id);
    if (decision === 'approved' && isNew) {
      await notifyApproved(base, refreshed.pendingItems);
    }
  }

  // Issue #5: detectar visionados sin esperar a un "recalcular todo" manual —
  // los pares recién refrescados arriba quedan excluidos por su computed_at.
  // Además avisa por Telegram del cupo liberado (si está activado).
  await refreshStaleAndNotify();
  await processSeasonQueue();
  await notifyStillUnavailable();
  await enforceSingleSession();
  await enforceBroadcast();
  await notifyBypassedApprovals();
}

function formatMediaTitle(mediaType, title, seasonNumber = null) {
  if (mediaType !== 'tv') return title;
  if (!seasonNumber) return title;
  return `${title ?? 'Serie'} - Temporada ${seasonNumber}`;
}

export function startScheduler() {
  runPollCycle().catch((err) => console.error('[scheduler] initial cycle failed:', err));
  setInterval(() => {
    runPollCycle().catch((err) => console.error('[scheduler] cycle failed:', err));
  }, config.pollIntervalMs);
}
