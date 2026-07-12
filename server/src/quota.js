import { db } from './db.js';
import { config } from './config.js';
import {
  getItemWatchHistory,
  getSeasonEpisodes,
  getUserEpisodeHistory,
  getUserMovieHistory,
  getUsers as getTautulliUsers,
  searchMedia,
} from './services/tautulli.js';
import {
  getRequestStatus,
  getSeerrUsers,
  getApprovedRequestsForUser,
  getMediaDetails,
  getUnavailableTmdbIds,
} from './services/seerr.js';
import { matchByEmailOrUsername } from './userMatch.js';

// Tautulli's own "watched" threshold; below this a play doesn't free up quota.
const WATCHED_THRESHOLD = 85;

// El único enlace entre "aprobada en Seerr" y "vista en Tautulli" es el título en
// texto, así que hay que ser tolerante con acentos, mayúsculas, puntuación y
// espacios — sin esto, "Río" vs "Rio" o "Amélie" vs "Amelie" no encontraban match.
export function normalize(title) {
  return (title || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos/diacriticos (tras NFD)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // puntuación/símbolos -> espacio
    .trim()
    .replace(/\s+/g, ' ');
}

const getOverride = db.prepare('SELECT * FROM overrides WHERE user_id = ? AND library_id = ?');
const getGroupOverride = db.prepare(`
  SELECT go.limit_override FROM group_members gm
  JOIN group_overrides go ON go.group_id = gm.group_id
  WHERE gm.user_id = ? AND go.library_id = ?
`);
const getAggregatedGroupForUser = db.prepare(`
  SELECT g.id, g.name FROM group_members gm
  JOIN groups g ON g.id = gm.group_id
  WHERE gm.user_id = ? AND g.aggregated = 1
`);
const getGroupMemberIdsStmt = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?');
const getGroupOverrideByGroup = db.prepare(
  'SELECT limit_override FROM group_overrides WHERE group_id = ? AND library_id = ?'
);
const getLibrary = db.prepare('SELECT * FROM libraries WHERE id = ?');
const getResetAt = db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = ? AND library_id = ?');
const getApprovedTitles = db.prepare(`
  SELECT id, media_title, media_type, tmdb_id, season_number, poster_url FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision = 'approved' AND voided_at IS NULL AND created_at > ?
`);
const updateApprovalPoster = db.prepare(`
  UPDATE decisions_log SET poster_url = ? WHERE id = ?
`);
const upsertReset = db.prepare(`
  INSERT INTO quota_resets (user_id, library_id, reset_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT (user_id, library_id) DO UPDATE SET reset_at = excluded.reset_at
`);
const getUnvoidedApproved = db.prepare(`
  SELECT id, request_id, created_at FROM decisions_log
  WHERE decision = 'approved' AND voided_at IS NULL AND created_at > datetime('now', '-90 days')
`);
const markVoided = db.prepare(`UPDATE decisions_log SET voided_at = datetime('now') WHERE id = ?`);
const getLibraryForRequest = db.prepare(`
  SELECT * FROM libraries WHERE section_type = ? AND kind = ? AND enabled = 1 LIMIT 1
`);
const requestUnitAlreadyLogged = db.prepare(`
  SELECT 1 FROM decisions_log
  WHERE request_id = ?
    AND media_type = ?
    AND COALESCE(season_number, -1) = COALESCE(?, -1)
`);
const insertImportedApproval = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, poster_url, decision, created_at)
  VALUES (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, @posterUrl, 'approved', @createdAt)
`);
const upsertQuotaCache = db.prepare(`
  INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, pending_items, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, library_id) DO UPDATE SET
    limit_applied = excluded.limit_applied,
    outstanding = excluded.outstanding,
    balance = excluded.balance,
    pending_items = excluded.pending_items,
    computed_at = excluded.computed_at
`);
const deleteQuotaCache = db.prepare('DELETE FROM quota_cache WHERE user_id = ? AND library_id = ?');

function toSqliteDateTime(isoString) {
  return isoString.replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// Issue #4: identidad de cupo de un id. Un usuario de un grupo agregado no tiene
// cupo propio: comparte el del grupo, que vive en quota_cache/quota_resets con
// user_id = -group_id (los ids de Tautulli son siempre positivos, no chocan).
// Acepta también ids negativos (el propio grupo), para que las rutas del panel
// puedan operar directamente sobre la fila del grupo.
export function quotaIdentity(id) {
  const numericId = Number(id);
  if (numericId < 0) {
    const groupId = -numericId;
    const memberIds = getGroupMemberIdsStmt.all(groupId).map((r) => r.user_id);
    return { cacheId: numericId, groupId, memberIds, aggregated: true };
  }
  const group = getAggregatedGroupForUser.get(numericId);
  if (group) {
    const memberIds = getGroupMemberIdsStmt.all(group.id).map((r) => r.user_id);
    return { cacheId: -group.id, groupId: group.id, memberIds, aggregated: true };
  }
  return { cacheId: numericId, memberIds: [numericId], aggregated: false };
}

// Precedencia del límite efectivo. Comparaciones con != null a propósito:
// 0 es un valor legítimo (bloquear del todo) y no puede tratarse como "sin override".
export function resolveLimit(userOverride, groupOverride, defaultLimit) {
  if (userOverride != null) return userOverride;
  if (groupOverride != null) return groupOverride;
  return defaultLimit;
}

// Parte pura del cálculo (sin DB ni red), para poder testearla sin mockear
// Tautulli/Seerr: dado el límite ya resuelto, las filas aprobadas y el set de
// títulos vistos, decide cuántas están pendientes y cuál es el saldo. Nunca
// negativo: por debajo de 0 se queda en 0 (el bloqueo ya lo gestiona balance < 1).
export function computeBalance(limit, approvedRows, watchedTitles, unavailableTmdbIds = new Set(), percentByTitle = new Map()) {
  const pending = approvedRows.filter((r) => !watchedTitles.has(normalize(r.media_title)));
  // Issue #1: las que aún no están disponibles en Plex (según Seerr: faltante,
  // sin estrenar o no encontrada) no restan cupo, pero sí se listan como
  // pendientes (con marca) para que se vea que la solicitud existe y aún no cuenta.
  const isUnavailable = (r) => r.tmdb_id != null && unavailableTmdbIds.has(r.tmdb_id);
  const outstanding = pending.filter((r) => !isUnavailable(r)).length;

  const seenTitles = new Set();
  const pendingItems = [];
  for (const r of pending) {
    const key = normalize(r.media_title);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    pendingItems.push({
      title: r.media_title,
      mediaType: r.media_type || 'movie',
      tmdbId: r.tmdb_id,
      seasonNumber: r.season_number ?? null,
      posterUrl: r.poster_url ?? null,
      unavailable: isUnavailable(r),
      // Issue #7: % de avance del solicitante, para la rueda de la carátula.
      watchedPercent: Math.round(percentByTitle.get(key) ?? 0),
    });
  }

  return {
    limit,
    outstanding,
    balance: Math.max(0, limit - outstanding),
    pendingItems,
  };
}

async function hydrateMissingPosters(approvedRows) {
  for (const row of approvedRows) {
    if (row.poster_url || !row.tmdb_id) continue;
    const { posterUrl } = await getMediaDetails(row.media_type || 'movie', row.tmdb_id, row.season_number);
    if (!posterUrl) continue;
    row.poster_url = posterUrl;
    updateApprovalPoster.run(posterUrl, row.id);
  }
}

async function computeTvBalance(limit, approvedRows, watchedEpisodes) {
  await hydrateMissingPosters(approvedRows);
  const watchedRatingKeys = new Set(
    watchedEpisodes
      .filter((h) => h.percent >= WATCHED_THRESHOLD)
      .map((h) => h.ratingKey)
      .filter(Boolean)
  );

  const pending = [];
  const showDetailsCache = new Map();
  const seasonEpisodesCache = new Map();

  for (const row of approvedRows) {
    if (!row.tmdb_id || !row.season_number) {
      pending.push(row);
      continue;
    }
    if (!showDetailsCache.has(row.tmdb_id)) {
      showDetailsCache.set(row.tmdb_id, await getMediaDetails('tv', row.tmdb_id, row.season_number));
    }
    const showRatingKey = showDetailsCache.get(row.tmdb_id)?.showRatingKey;
    const cacheKey = `${showRatingKey || 'missing'}:${row.season_number}`;
    if (!seasonEpisodesCache.has(cacheKey)) {
      seasonEpisodesCache.set(cacheKey, await getSeasonEpisodes(showRatingKey, row.season_number));
    }
    const episodes = seasonEpisodesCache.get(cacheKey);
    const complete = episodes.length > 0 && episodes.every((episode) => watchedRatingKeys.has(episode.ratingKey));
    if (!complete) {
      // Issue #7: avance de la temporada = fracción de episodios ya vistos.
      const watchedCount = episodes.filter((episode) => watchedRatingKeys.has(episode.ratingKey)).length;
      row.watched_percent = episodes.length > 0 ? Math.round((watchedCount / episodes.length) * 100) : 0;
      pending.push(row);
    }
  }

  const pendingItems = pending.map((r) => ({
    title: r.media_title,
    mediaType: 'tv',
    tmdbId: r.tmdb_id,
    seasonNumber: r.season_number ?? null,
    posterUrl: r.poster_url ?? null,
    watchedPercent: r.watched_percent ?? 0,
  }));

  return {
    limit,
    outstanding: pending.length,
    balance: Math.max(0, limit - pending.length),
    pendingItems,
  };
}

// balance = limit - (peliculas aprobadas para este usuario en esta biblioteca que aun no ha visto).
// Se recalcula siempre en vivo a partir del historial de Tautulli y del propio log de decisiones,
// así que nunca se desincroniza: no hay contador mutable que decrementar/incrementar a mano.
export async function getBalance(userId, libraryId) {
  // Issue #4: en un grupo agregado, las aprobadas de TODOS los miembros restan
  // del mismo cupo y el visionado de CUALQUIER miembro lo libera (caso familia:
  // solicita uno, lo ven los demás). El override individual no aplica — el
  // grupo es un solo usuario: override de grupo > límite de biblioteca.
  const identity = quotaIdentity(userId);
  const library = getLibrary.get(libraryId);
  let limit;
  if (identity.aggregated) {
    const groupOverride = getGroupOverrideByGroup.get(identity.groupId, libraryId);
    limit = resolveLimit(null, groupOverride?.limit_override ?? null, library.default_limit);
  } else {
    const override = getOverride.get(identity.cacheId, libraryId);
    const groupOverride = getGroupOverride.get(identity.cacheId, libraryId);
    limit = resolveLimit(
      override?.limit_override ?? null,
      groupOverride?.limit_override ?? null,
      library.default_limit
    );
  }
  const resetAt = getResetAt.get(identity.cacheId, libraryId)?.reset_at ?? '0000-01-01';

  const approved = identity.memberIds.flatMap((memberId) =>
    getApprovedTitles.all(memberId, libraryId, resetAt)
  );
  if (library.section_type === 'show') {
    const history = [];
    for (const memberId of identity.memberIds) {
      history.push(...(await getUserEpisodeHistory(memberId, libraryId)));
    }
    return computeTvBalance(limit, approved, history);
  }

  const history = [];
  for (const memberId of identity.memberIds) {
    history.push(...(await getUserMovieHistory(memberId, libraryId)));
  }
  const watchedTitles = new Set(
    history.filter((h) => h.percent >= WATCHED_THRESHOLD).map((h) => normalize(h.title))
  );
  // Issue #7: mayor % alcanzado por título (puede haber varias sesiones parciales).
  const percentByTitle = new Map();
  for (const h of history) {
    const key = normalize(h.title);
    percentByTitle.set(key, Math.max(percentByTitle.get(key) ?? 0, h.percent));
  }
  await hydrateMissingPosters(approved);
  const unavailable = await getUnavailableTmdbIds(approved.map((r) => r.tmdb_id));
  return computeBalance(limit, approved, watchedTitles, unavailable, percentByTitle);
}

// "Resetea" el cupo de un usuario+biblioteca: las aprobaciones anteriores a ahora
// dejan de contar como pendientes, sin borrar el historial del registro.
export function resetQuota(userId, libraryId) {
  upsertReset.run(quotaIdentity(userId).cacheId, libraryId);
}

// rating_key de Plex para enlazar cada pendiente con su página de estadísticas
// en Tautulli. Se matchea primero por TMDB id (los guids de Plex incluyen
// "tmdb://<id>", independiente del idioma) y si no por título normalizado.
// Para series, el pendiente se titula "X - Temporada N": se busca "X" y se
// prefiere la temporada exacta (media_index), con la serie como fallback.
// Solo se memorizan aciertos: un pendiente aún no descargado no está en Plex
// todavía, y cachear el fallo lo dejaría sin enlace aunque aparezca más tarde.
const ratingKeyCache = new Map();

async function lookupRatingKey({ title, mediaType, tmdbId, seasonNumber }) {
  if (!title) return null;
  const isTv = mediaType === 'tv';
  const baseTitle = isTv ? title.replace(/ - Temporada \d+$/, '') : title;
  const wanted = normalize(baseTitle);
  const cacheKey = `${isTv ? 'tv' : 'movie'}:${tmdbId ?? wanted}:${isTv ? seasonNumber ?? '' : ''}`;
  if (ratingKeyCache.has(cacheKey)) return ratingKeyCache.get(cacheKey);
  try {
    const { movies, shows, seasons } = await searchMedia(baseTitle);
    const tmdbGuid = tmdbId != null ? `tmdb://${tmdbId}` : null;
    const byTmdbOrTitle = (entry, entryTitle) =>
      (tmdbGuid && entry.guids.includes(tmdbGuid)) || normalize(entryTitle) === wanted;

    let hit = null;
    if (isTv) {
      hit =
        (seasonNumber != null &&
          seasons.find((s) => byTmdbOrTitle(s, s.parentTitle) && s.seasonNumber === seasonNumber)) ||
        shows.find((s) => byTmdbOrTitle(s, s.title));
    } else {
      hit = movies.find((m) => byTmdbOrTitle(m, m.title));
    }
    if (hit) ratingKeyCache.set(cacheKey, hit.ratingKey);
    return hit?.ratingKey ?? null;
  } catch {
    return null; // sin Tautulli no hay enlace, pero el cupo sigue funcionando
  }
}

// La pestaña Cupo lee de quota_cache, no calcula en vivo — cualquier cosa que
// cambie el resultado de getBalance (override, reset, ...) tiene que llamar esto
// para que el panel lo refleje al momento en vez de esperar al siguiente sondeo.
export async function refreshQuotaCache(userId, libraryId) {
  // Issue #4: la caché de un miembro de grupo agregado es la del grupo — se
  // escribe bajo -group_id y se borran las filas individuales de los miembros,
  // que ya no deben aparecer en el panel.
  const identity = quotaIdentity(userId);
  const library = getLibrary.get(libraryId);
  if (!library?.enabled) {
    deleteQuotaCache.run(identity.cacheId, libraryId);
    return { limit: 0, outstanding: 0, balance: 0, pendingItems: [], disabled: true };
  }
  const { limit, outstanding, balance, pendingItems } = await getBalance(identity.cacheId, libraryId);
  for (const item of pendingItems) {
    item.ratingKey = await lookupRatingKey(item);
  }
  if (identity.aggregated) {
    for (const memberId of identity.memberIds) deleteQuotaCache.run(memberId, libraryId);
  }
  upsertQuotaCache.run(identity.cacheId, libraryId, limit, outstanding, balance, JSON.stringify(pendingItems));
  return { limit, outstanding, balance, pendingItems };
}

// Issue #5: ver una película en Plex no dispara ningún evento hacia limitARR, así
// que la caché del panel se quedaba desactualizada hasta la siguiente solicitud o
// un "recalcular todo" manual. Solo pueden cambiar por visionado los pares con
// pendientes (outstanding > 0); se refrescan desde el ciclo de sondeo, con un
// mínimo de antigüedad para no golpear Tautulli cada ciclo.
const STALE_OUTSTANDING_MINUTES = 5;

const getStaleOutstandingPairs = db.prepare(`
  SELECT qc.user_id, qc.library_id
  FROM quota_cache qc
  JOIN libraries l ON l.id = qc.library_id
  WHERE l.enabled = 1
    AND qc.outstanding > 0
    AND qc.computed_at <= datetime('now', '-' || ? || ' minutes')
`);

export function listStaleOutstandingPairs(staleMinutes = STALE_OUTSTANDING_MINUTES) {
  return getStaleOutstandingPairs.all(staleMinutes);
}

export async function refreshStaleOutstandingCaches() {
  const pairs = listStaleOutstandingPairs();
  for (const { user_id, library_id } of pairs) {
    await refreshQuotaCache(user_id, library_id);
  }
  return pairs.length;
}

const getPendingApprovedRows = db.prepare(`
  SELECT id, media_title, tmdb_id, season_number, created_at FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision = 'approved' AND voided_at IS NULL
`);

// Mismo criterio de match que dismissPendingItem: tmdb_id+temporada o, en su
// defecto, título normalizado (filas antiguas/importadas sin tmdb_id).
function matchesPendingRow(row, { tmdbId, seasonNumber, title }) {
  const wanted = normalize(title);
  return (
    (tmdbId != null &&
      row.tmdb_id === Number(tmdbId) &&
      (row.season_number ?? null) === (seasonNumber ?? null)) ||
    (wanted !== '' && normalize(row.media_title) === wanted)
  );
}

// Issue #6: datos para la ventana de detalle de un pendiente — cuándo se
// solicitó/aprobó (decisions_log) y quién lo ha visto, cuánto y cuándo
// (historial de Tautulli del ítem, todas las cuentas, agregado por usuario).
export async function getPendingItemDetail(userId, libraryId, { tmdbId, seasonNumber, title, ratingKey, mediaType }) {
  const matching = quotaIdentity(userId)
    .memberIds.flatMap((memberId) => getPendingApprovedRows.all(memberId, libraryId))
    .filter((row) => matchesPendingRow(row, { tmdbId, seasonNumber, title }));
  const requestedAt = matching.map((r) => r.created_at).sort()[0] ?? null;

  const sessions = ratingKey ? await getItemWatchHistory(ratingKey, mediaType === 'tv') : [];
  const byUser = new Map();
  for (const s of sessions) {
    const u = byUser.get(s.userId) ?? {
      userId: s.userId,
      username: s.username,
      plays: 0,
      maxPercent: 0,
      lastWatchedAt: null,
    };
    u.plays += 1;
    u.maxPercent = Math.max(u.maxPercent, Math.round(s.percent));
    if (s.watchedAt && (!u.lastWatchedAt || s.watchedAt > u.lastWatchedAt)) u.lastWatchedAt = s.watchedAt;
    byUser.set(s.userId, u);
  }
  const watchers = [...byUser.values()].sort(
    (a, b) => b.maxPercent - a.maxPercent || (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0)
  );
  return { requestedAt, watchers };
}

// Quita a mano UN pendiente del cupo de un usuario (botón ✕ del panel), sin
// resetear todo: anula (voided_at) sus filas aprobadas, igual que hace la
// reconciliación automática con las canceladas.
export function dismissPendingItem(userId, libraryId, { tmdbId, seasonNumber, title }) {
  let dismissed = 0;
  for (const memberId of quotaIdentity(userId).memberIds) {
    for (const row of getPendingApprovedRows.all(memberId, libraryId)) {
      if (matchesPendingRow(row, { tmdbId, seasonNumber, title })) {
        markVoided.run(row.id);
        dismissed += 1;
      }
    }
  }
  return dismissed;
}

// Sin esto, una aprobada que nunca llega a ver la luz (cancelada por el usuario, o
// nunca llega a descargarse) se queda ocupando su hueco de cupo para siempre. Se
// libera si Seerr confirma que ya no existe, o si sigue "pendiente" (nunca
// disponible) pasado el plazo de gracia — una ya disponible no se toca nunca,
// por vieja que sea: sigue contando hasta que el usuario la vea de verdad.
export async function reconcileVoidedRequests() {
  const rows = getUnvoidedApproved.all();
  const graceMs = config.stuckRequestGraceDays * 24 * 60 * 60 * 1000;

  for (const row of rows) {
    const status = await getRequestStatus(row.request_id);
    if (status === 'gone') {
      markVoided.run(row.id);
      continue;
    }
    if (status === 'pending') {
      const ageMs = Date.now() - new Date(row.created_at.replace(' ', 'T') + 'Z').getTime();
      if (ageMs > graceMs) markVoided.run(row.id);
    }
  }
}

// Sin esto, el cupo solo cuenta lo que limitARR aprobó él mismo: una solicitud de
// antes de instalarlo, o aprobada a mano directamente en Seerr, no contaría nunca
// contra el usuario. Recorre el historial real de Seerr y rellena decisions_log
// con lo que falte (created_at real, no "ahora"), sin duplicar por request_id.
export async function importSeerrHistory() {
  const [seerrUsers, tautulliUsers] = await Promise.all([getSeerrUsers(), getTautulliUsers()]);

  let imported = 0;
  for (const tautulliUser of tautulliUsers) {
    const seerrUser = matchByEmailOrUsername(seerrUsers, tautulliUser);
    if (!seerrUser) continue;

    const requests = await getApprovedRequestsForUser(seerrUser.id);
    for (const request of requests) {
      const sectionType = request.mediaType === 'tv' ? 'show' : 'movie';
      const library = getLibraryForRequest.get(sectionType, request.is4k ? '4k' : 'standard');
      if (!library) continue;

      const units = request.mediaType === 'tv' && request.seasons.length > 0 ? request.seasons : [null];
      for (const seasonNumber of units) {
        if (requestUnitAlreadyLogged.get(request.id, request.mediaType, seasonNumber ?? null)) continue;

        const { title, posterUrl } = await getMediaDetails(request.mediaType, request.tmdbId, seasonNumber);
        insertImportedApproval.run({
          requestId: request.id,
          userId: tautulliUser.id,
          username: tautulliUser.username,
          libraryId: library.id,
          mediaTitle: formatMediaTitle(request.mediaType, title, seasonNumber),
          mediaType: request.mediaType,
          tmdbId: request.tmdbId ?? null,
          seasonNumber,
          posterUrl,
          createdAt: toSqliteDateTime(request.createdAt),
        });
        imported += 1;
      }
    }
  }
  return imported;
}

function formatMediaTitle(mediaType, title, seasonNumber = null) {
  if (mediaType !== 'tv') return title;
  if (!seasonNumber) return title;
  return `${title ?? 'Serie'} - Temporada ${seasonNumber}`;
}
