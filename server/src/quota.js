import { db } from './db.js';
import { config } from './config.js';
import { getRawSetting } from './settings.js';
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
  getMovieAvailability,
} from './services/seerr.js';
import { matchByEmailOrUsername } from './userMatch.js';

// Tautulli's own "watched" threshold; below this a play doesn't free up quota.
const WATCHED_THRESHOLD = 85;

// Issue #9: % de episodios vistos a partir del cual una temporada cuenta como
// vista y libera cupo (no hace falta el 100%: un episodio suelto sin ver, o un
// especial, dejaba la temporada ocupando cupo para siempre). Configurable en
// Configuración; 100 recupera el comportamiento antiguo.
const DEFAULT_SEASON_WATCHED_PERCENT = 85;

export function getSeasonWatchedPercent() {
  const value = Number(getRawSetting('tv_season_watched_percent'));
  return Number.isFinite(value) && value >= 1 && value <= 100 ? value : DEFAULT_SEASON_WATCHED_PERCENT;
}

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
  SELECT go.limit_override, go.expiry_override, go.monthly_limit_override FROM group_members gm
  JOIN group_overrides go ON go.group_id = gm.group_id
  WHERE gm.user_id = ? AND go.library_id = ?
`);
// v2: rol asignado al usuario (como mucho uno, igual que el grupo). Solo
// aplica a usuarios individuales — un grupo agregado no tiene rol propio.
const getRoleOverride = db.prepare(`
  SELECT ro.limit_override, ro.expiry_override, ro.monthly_limit_override FROM user_roles ur
  JOIN role_overrides ro ON ro.role_id = ur.role_id
  WHERE ur.user_id = ? AND ro.library_id = ?
`);
const getAggregatedGroupForUser = db.prepare(`
  SELECT g.id, g.name FROM group_members gm
  JOIN groups g ON g.id = gm.group_id
  WHERE gm.user_id = ? AND g.aggregated = 1
`);
const getGroupMemberIdsStmt = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?');
const getGroupOverrideByGroup = db.prepare(
  'SELECT limit_override, expiry_override FROM group_overrides WHERE group_id = ? AND library_id = ?'
);
const getLibrary = db.prepare('SELECT * FROM libraries WHERE id = ?');
const getResetAt = db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = ? AND library_id = ?');
const getApprovedTitles = db.prepare(`
  SELECT id, request_id, media_title, media_type, tmdb_id, season_number, poster_url, note, created_at FROM decisions_log
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
// v2: cupo mensual — cuenta lo aprobado (y no anulado) en el mes en curso,
// para TODOS los miembros de la identidad de cupo (igual que el saldo). Un
// cargo manual también es una fila 'approved' en esta tabla, así que cuenta
// igual sin lógica extra. 'start of month' es local a la fecha guardada (UTC).
const getMonthlyApprovedCount = db.prepare(`
  SELECT COUNT(*) AS n FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision = 'approved' AND voided_at IS NULL
    AND created_at >= datetime('now', 'start of month')
`);
const requestUnitAlreadyLogged = db.prepare(`
  SELECT 1 FROM decisions_log
  WHERE request_id = ?
    AND media_type = ?
    AND COALESCE(season_number, -1) = COALESCE(?, -1)
`);
const insertImportedApproval = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, poster_url, note, decision, created_at)
  VALUES (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, @posterUrl, @note, 'approved', @createdAt)
`);
const upsertQuotaCache = db.prepare(`
  INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, pending_items, monthly_enabled, monthly_limit, monthly_used, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, library_id) DO UPDATE SET
    limit_applied = excluded.limit_applied,
    outstanding = excluded.outstanding,
    balance = excluded.balance,
    pending_items = excluded.pending_items,
    monthly_enabled = excluded.monthly_enabled,
    monthly_limit = excluded.monthly_limit,
    monthly_used = excluded.monthly_used,
    computed_at = excluded.computed_at
`);
const deleteQuotaCache = db.prepare('DELETE FROM quota_cache WHERE user_id = ? AND library_id = ?');

function toSqliteDateTime(isoString) {
  return isoString.replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// created_at de SQLite es "YYYY-MM-DD HH:MM:SS" en UTC.
function rowTimeMs(row) {
  return Date.parse(row.created_at.replace(' ', 'T') + 'Z');
}

// Issue #10: caducidad. Pasados expiryDays sin ver un pendiente, deja de contar
// y sale de la lista (el cupo se libera solo). 0 = sin caducidad; NULL hereda.
const DEFAULT_EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveExpiryDays(overrides, libraryDays) {
  const days = resolveLimit(overrides, libraryDays ?? DEFAULT_EXPIRY_DAYS);
  return days > 0 ? days : null; // null = no caduca
}

// Issue #14: el plazo cuenta desde que el título está disponible en Plex, no
// desde la aprobación (una película que tardó 29 días en descargarse caducaba
// al día siguiente de llegar). `availability` es el Map de getMovieAvailability;
// sin él (tests, series) se cae al comportamiento antiguo por created_at. Un
// pendiente aún no disponible no caduca: no se puede ver todavía, y las
// solicitudes atascadas ya las anula reconcileVoidedRequests.
export function dropExpiredRows(rows, expiryDays, nowMs = Date.now(), availability = null) {
  if (!expiryDays) return rows;
  const cutoff = nowMs - expiryDays * DAY_MS;
  return rows.filter((r) => {
    const info = r.tmdb_id != null ? availability?.get(r.tmdb_id) : null;
    if (info?.unavailable) return true;
    const base = info?.availableSince ?? (r.created_at ? rowTimeMs(r) : null);
    return base == null || base > cutoff;
  });
}

// Fecha de caducidad de un pendiente, para la ventana de detalle. Desde la
// disponibilidad si se conoce (issue #14), si no desde la aprobación.
function expiresAtMs(row, expiryDays, availableSinceMs = null) {
  if (!expiryDays) return null;
  const base = availableSinceMs ?? (row.created_at ? rowTimeMs(row) : null);
  return base == null ? null : base + expiryDays * DAY_MS;
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

// Precedencia del límite efectivo: el primer valor no-null de `overrides`, en
// el orden en que se pasen (individual > grupo > rol), y si no hay ninguno, el
// default de biblioteca. Comparación con != null a propósito: 0 es un valor
// legítimo (bloquear del todo) y no puede tratarse como "sin override". Misma
// función sirve para el límite normal, el mensual (v2) y, envuelta por
// resolveExpiryDays, la caducidad.
export function resolveLimit(overrides, defaultLimit) {
  for (const override of overrides) {
    if (override != null) return override;
  }
  return defaultLimit;
}

// Parte pura del cálculo (sin DB ni red), para poder testearla sin mockear
// Tautulli/Seerr: dado el límite ya resuelto, las filas aprobadas y el set de
// títulos vistos, decide cuántas están pendientes y cuál es el saldo. Nunca
// negativo: por debajo de 0 se queda en 0 (el bloqueo ya lo gestiona balance < 1).
export function computeBalance(limit, approvedRows, watchedTitles, unavailableTmdbIds = new Set(), percentByTitle = new Map(), expiryDays = null, availability = null) {
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
    // Issue #14: desde cuándo está en Plex (Seerr), si se sabe.
    const availableSince = isUnavailable(r) ? null : (r.tmdb_id != null ? availability?.get(r.tmdb_id)?.availableSince ?? null : null);
    pendingItems.push({
      title: r.media_title,
      mediaType: r.media_type || 'movie',
      tmdbId: r.tmdb_id,
      seasonNumber: r.season_number ?? null,
      posterUrl: r.poster_url ?? null,
      unavailable: isUnavailable(r),
      mediaStatus: r.tmdb_id != null ? availability?.get(r.tmdb_id)?.status ?? null : null,
      // Estado real de la cola de Radarr ("downloading", "queued", "paused"...),
      // no el status 2/3 de Seerr (que solo dice "solicitada"/"monitorizada") —
      // ver movieAvailability. null = nada en cola ahora mismo.
      queueStatus: r.tmdb_id != null ? availability?.get(r.tmdb_id)?.queueStatus ?? null : null,
      // Issue #7: % de avance del solicitante, para la rueda de la carátula.
      watchedPercent: Math.round(percentByTitle.get(key) ?? 0),
      availableSince,
      // Issue #10: cuándo caduca (ms epoch) o null si no caduca. Una no
      // disponible no caduca (issue #14): aún no se puede ver.
      expiresAt: isUnavailable(r) ? null : expiresAtMs(r, expiryDays, availableSince),
      // Issue #11: para poder rechazar la solicitud en Seerr desde el detalle.
      requestId: r.request_id ?? null,
      // Cargo manual: motivo puesto por el admin al restar cupo a mano.
      note: r.note ?? null,
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

// Issue #9: índice de episodios vistos con tres llaves. rating_key es la
// principal, pero muere cuando Plex re-escanea o se sustituye un archivo (el
// episodio recibe rating_key nuevo y las reproducciones viejas apuntan al
// muerto). De respaldo: serie+temporada+episodio, tanto por rating_key de la
// serie como por título normalizado.
export function buildWatchedEpisodeIndex(watchedEpisodes) {
  const ratingKeys = new Set();
  const byShowKey = new Set();
  const byTitle = new Set();
  for (const h of watchedEpisodes) {
    if (h.percent < WATCHED_THRESHOLD) continue;
    if (h.ratingKey) ratingKeys.add(h.ratingKey);
    if (Number.isFinite(h.seasonNumber) && Number.isFinite(h.episodeNumber)) {
      if (h.showRatingKey) byShowKey.add(`${h.showRatingKey}:${h.seasonNumber}:${h.episodeNumber}`);
      if (h.showTitle) byTitle.add(`${normalize(h.showTitle)}:${h.seasonNumber}:${h.episodeNumber}`);
    }
  }
  return { ratingKeys, byShowKey, byTitle };
}

// Estado de visionado de una temporada: episodios vistos / totales, % y si ya
// cuenta como vista según el umbral (issue #9). Pura, para poder testearla.
export function seasonWatchState(index, episodes, { showTitle, showRatingKey, seasonNumber }, seasonWatchedPercent) {
  const normalizedTitle = showTitle ? normalize(showTitle) : null;
  const watchedCount = episodes.filter(
    (episode) =>
      index.ratingKeys.has(episode.ratingKey) ||
      (showRatingKey != null && index.byShowKey.has(`${showRatingKey}:${seasonNumber}:${episode.episodeNumber}`)) ||
      (normalizedTitle != null && index.byTitle.has(`${normalizedTitle}:${seasonNumber}:${episode.episodeNumber}`))
  ).length;
  const percent = episodes.length > 0 ? Math.round((watchedCount / episodes.length) * 100) : 0;
  return {
    watchedCount,
    total: episodes.length,
    percent,
    complete: episodes.length > 0 && percent >= seasonWatchedPercent,
  };
}

async function computeTvBalance(limit, approvedRows, watchedEpisodes, seasonWatchedPercent = DEFAULT_SEASON_WATCHED_PERCENT, expiryDays = null) {
  await hydrateMissingPosters(approvedRows);
  const watchedIndex = buildWatchedEpisodeIndex(watchedEpisodes);

  const pending = [];
  const showDetailsCache = new Map();
  const seasonEpisodesCache = new Map();

  for (const row of approvedRows) {
    if (!row.tmdb_id || !row.season_number) {
      // Fila legada sin tmdb/temporada: sin datos de disponibilidad, caduca
      // por fecha de aprobación como antes del issue #14.
      if (expiryDays && row.created_at && rowTimeMs(row) + expiryDays * DAY_MS <= Date.now()) continue;
      pending.push(row);
      continue;
    }
    if (!showDetailsCache.has(row.tmdb_id)) {
      showDetailsCache.set(row.tmdb_id, await getMediaDetails('tv', row.tmdb_id, row.season_number));
    }
    const details = showDetailsCache.get(row.tmdb_id);
    const showRatingKey = details?.showRatingKey;
    const cacheKey = `${showRatingKey || 'missing'}:${row.season_number}`;
    if (!seasonEpisodesCache.has(cacheKey)) {
      seasonEpisodesCache.set(cacheKey, await getSeasonEpisodes(showRatingKey, row.season_number));
    }
    const episodes = seasonEpisodesCache.get(cacheKey);
    const state = seasonWatchState(
      watchedIndex,
      episodes,
      {
        showTitle: row.media_title.replace(/ - Temporada \d+$/, ''),
        showRatingKey,
        seasonNumber: row.season_number,
      },
      seasonWatchedPercent
    );
    if (!state.complete) {
      // Mismo criterio que en películas (issue #1): una temporada que Seerr aún
      // no da por disponible (status < 4: nada descargado) no resta cupo, pero
      // se lista con marca. seasonStatuses null = error de red → cuenta.
      const status = details?.seasonStatuses?.[row.season_number];
      row.unavailable = details?.seasonStatuses != null && (status ?? 0) < 4;
      row.media_status = status ?? null;
      // Estado real de la cola de Sonarr para esa temporada (ver getShowDetails).
      row.queue_status = details?.seasonQueueStatus?.[row.season_number] ?? null;
      // Issue #14: caducidad desde que la temporada está disponible (si Seerr
      // da la fecha); una no disponible no caduca. Una caducada ni se lista.
      row.available_since = row.unavailable ? null : details?.seasonAvailableSince?.[row.season_number] ?? null;
      if (!row.unavailable && expiryDays) {
        const base = row.available_since ?? (row.created_at ? rowTimeMs(row) : null);
        if (base != null && base + expiryDays * DAY_MS <= Date.now()) continue;
      }
      // Issue #7: avance de la temporada = fracción de episodios ya vistos.
      row.watched_percent = state.percent;
      // Issue #8: "vistos/totales" para la etiqueta de la carátula y el detalle.
      row.episodes_watched = state.watchedCount;
      row.episodes_total = state.total;
      pending.push(row);
    }
  }

  const outstanding = pending.filter((r) => !r.unavailable).length;
  const pendingItems = pending.map((r) => ({
    title: r.media_title,
    mediaType: 'tv',
    tmdbId: r.tmdb_id,
    seasonNumber: r.season_number ?? null,
    posterUrl: r.poster_url ?? null,
    unavailable: r.unavailable ?? false,
    mediaStatus: r.media_status ?? null,
    queueStatus: r.queue_status ?? null,
    watchedPercent: r.watched_percent ?? 0,
    episodesWatched: r.episodes_watched ?? null,
    episodesTotal: r.episodes_total ?? null,
    availableSince: r.available_since ?? null,
    expiresAt: r.unavailable ? null : expiresAtMs(r, expiryDays, r.available_since ?? null),
    requestId: r.request_id ?? null,
    note: r.note ?? null,
  }));

  return {
    limit,
    outstanding,
    balance: Math.max(0, limit - outstanding),
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
  let expiryDays;
  let monthlyLimit;
  if (identity.aggregated) {
    // Un grupo agregado no tiene rol propio (el rol es de usuario individual):
    // solo cuenta su propio override de grupo, igual que ya hacía el límite.
    const groupOverride = getGroupOverrideByGroup.get(identity.groupId, libraryId);
    limit = resolveLimit([groupOverride?.limit_override ?? null], library.default_limit);
    expiryDays = resolveExpiryDays([groupOverride?.expiry_override ?? null], library.expiry_days);
    monthlyLimit = resolveLimit([groupOverride?.monthly_limit_override ?? null], library.monthly_limit);
  } else {
    const override = getOverride.get(identity.cacheId, libraryId);
    const groupOverride = getGroupOverride.get(identity.cacheId, libraryId);
    const roleOverride = getRoleOverride.get(identity.cacheId, libraryId);
    // Precedencia (v2): override individual > override de grupo > rol asignado > biblioteca.
    const chain = (field) => [override?.[field] ?? null, groupOverride?.[field] ?? null, roleOverride?.[field] ?? null];
    limit = resolveLimit(chain('limit_override'), library.default_limit);
    expiryDays = resolveExpiryDays(chain('expiry_override'), library.expiry_days);
    monthlyLimit = resolveLimit(chain('monthly_limit_override'), library.monthly_limit);
  }
  const resetAt = getResetAt.get(identity.cacheId, libraryId)?.reset_at ?? '0000-01-01';
  // v2: cupo mensual — independiente de si se ha visto o no. Solo se aplica si
  // la biblioteca lo tiene activado; el resto del cálculo de saldo no cambia.
  const monthlyUsed = identity.memberIds.reduce(
    (sum, memberId) => sum + getMonthlyApprovedCount.get(memberId, libraryId).n,
    0
  );
  const monthly = {
    enabled: Boolean(library.monthly_quota_enabled),
    limit: monthlyLimit,
    used: monthlyUsed,
    remaining: Math.max(0, monthlyLimit - monthlyUsed),
  };

  const allApproved = identity.memberIds.flatMap((memberId) => getApprovedTitles.all(memberId, libraryId, resetAt));
  if (library.section_type === 'show') {
    // Issue #10/#14: la caducidad de series se aplica dentro de computeTvBalance,
    // donde ya se conoce la disponibilidad por temporada.
    const history = [];
    for (const memberId of identity.memberIds) {
      history.push(...(await getUserEpisodeHistory(memberId, libraryId)));
    }
    const tvResult = await computeTvBalance(limit, allApproved, history, getSeasonWatchedPercent(), expiryDays);
    return { ...tvResult, monthly };
  }

  // Issue #14: la disponibilidad se consulta antes de filtrar caducadas porque
  // el plazo cuenta desde que la película llegó a Plex, no desde la aprobación.
  const availability = await getMovieAvailability(allApproved.map((r) => r.tmdb_id), library.kind === '4k');
  // Issue #10: las aprobadas que han caducado sin verse ni se listan ni cuentan.
  const approved = dropExpiredRows(allApproved, expiryDays, Date.now(), availability);
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
  const unavailable = new Set([...availability].filter(([, v]) => v.unavailable).map(([k]) => k));
  return { ...computeBalance(limit, approved, watchedTitles, unavailable, percentByTitle, expiryDays, availability), monthly };
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
    return { limit: 0, outstanding: 0, balance: 0, pendingItems: [], disabled: true, monthly: { enabled: false, limit: 0, used: 0, remaining: 0 } };
  }
  const { limit, outstanding, balance, pendingItems, monthly } = await getBalance(identity.cacheId, libraryId);
  for (const item of pendingItems) {
    item.ratingKey = await lookupRatingKey(item);
  }
  if (identity.aggregated) {
    for (const memberId of identity.memberIds) deleteQuotaCache.run(memberId, libraryId);
  }
  upsertQuotaCache.run(
    identity.cacheId, libraryId, limit, outstanding, balance, JSON.stringify(pendingItems),
    monthly.enabled ? 1 : 0, monthly.limit, monthly.used
  );
  return { limit, outstanding, balance, pendingItems, monthly };
}

// Issue #5: ver una película en Plex no dispara ningún evento hacia limitARR, así
// que la caché del panel se quedaba desactualizada hasta la siguiente solicitud o
// un "recalcular todo" manual. Se refrescan desde el ciclo de sondeo, con un
// mínimo de antigüedad para no golpear Tautulli cada ciclo, los pares cuyo estado
// puede cambiar solo por eventos externos: con pendientes que restan cupo
// (outstanding > 0, un visionado los libera) o con pendientes aún no disponibles
// (issue #1: al llegar a Plex pasan a restar, y eso ocurre justo con outstanding 0).
const STALE_OUTSTANDING_MINUTES = 5;

const getStaleOutstandingPairs = db.prepare(`
  SELECT qc.user_id, qc.library_id
  FROM quota_cache qc
  JOIN libraries l ON l.id = qc.library_id
  WHERE l.enabled = 1
    AND (qc.outstanding > 0 OR qc.pending_items LIKE '%"unavailable":true%')
    AND qc.computed_at <= datetime('now', '-' || ? || ' minutes')
`);

export function listStaleOutstandingPairs(staleMinutes = STALE_OUTSTANDING_MINUTES) {
  return getStaleOutstandingPairs.all(staleMinutes);
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
// Issue #8: en series, el % por usuario es el avance de la TEMPORADA (episodios
// vistos / totales), no el % del último episodio reproducido, y cada usuario
// lleva su lista de episodios con el % de cada uno para el desplegable.
export async function getPendingItemDetail(userId, libraryId, { tmdbId, seasonNumber, title, ratingKey, mediaType, episodesTotal }) {
  const matching = quotaIdentity(userId)
    .memberIds.flatMap((memberId) => getPendingApprovedRows.all(memberId, libraryId))
    .filter((row) => matchesPendingRow(row, { tmdbId, seasonNumber, title }));
  const requestedAt = matching.map((r) => r.created_at).sort()[0] ?? null;

  const isTv = mediaType === 'tv';
  let sessions = ratingKey ? await getItemWatchHistory(ratingKey, isTv) : [];
  // El ratingKey guardado puede ser el de la serie entera: el historial trae
  // entonces todas las temporadas y hay que quedarse solo con la pedida.
  if (isTv && seasonNumber != null) {
    sessions = sessions.filter((s) => s.seasonNumber == null || s.seasonNumber === seasonNumber);
  }

  const byUser = new Map();
  for (const s of sessions) {
    const u = byUser.get(s.userId) ?? {
      userId: s.userId,
      username: s.username,
      plays: 0,
      maxPercent: 0,
      lastWatchedAt: null,
      episodes: new Map(),
    };
    u.plays += 1;
    u.maxPercent = Math.max(u.maxPercent, Math.round(s.percent));
    if (s.watchedAt && (!u.lastWatchedAt || s.watchedAt > u.lastWatchedAt)) u.lastWatchedAt = s.watchedAt;
    if (isTv && Number.isFinite(s.episodeNumber)) {
      const episode = u.episodes.get(s.episodeNumber) ?? {
        episodeNumber: s.episodeNumber,
        title: s.episodeTitle,
        percent: 0,
      };
      episode.percent = Math.max(episode.percent, Math.round(s.percent));
      u.episodes.set(s.episodeNumber, episode);
    }
    byUser.set(s.userId, u);
  }

  const watchers = [...byUser.values()].map((u) => {
    const episodes = [...u.episodes.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
    if (!isTv) return { ...u, episodes: undefined };
    const episodesWatched = episodes.filter((e) => e.percent >= WATCHED_THRESHOLD).length;
    return {
      ...u,
      episodes,
      episodesWatched,
      episodesTotal: episodesTotal ?? null,
      // % de temporada si sabemos cuántos episodios tiene; si no (caché vieja),
      // el cliente enseña solo "vistos" y se apaña.
      maxPercent: episodesTotal > 0 ? Math.round((episodesWatched / episodesTotal) * 100) : u.maxPercent,
    };
  });
  watchers.sort((a, b) => b.maxPercent - a.maxPercent || (b.lastWatchedAt ?? 0) - (a.lastWatchedAt ?? 0));
  return { requestedAt, watchers };
}

// Cargo manual: algo que se bajó/vio fuera de Seerr (a mano) y aun así debe
// restar cupo — incluye películas ya en Plex que nunca se pidieron en Seerr
// (buscador GET /media/plex-search, ver routes/api.js), con posterUrl resuelto
// ahí desde TMDB una sola vez al hacer el cargo. tmdb_id se deja SIEMPRE null
// a propósito, aunque venga de una búsqueda real en Plex: si se guardara,
// computeBalance consultaría a Seerr su disponibilidad y, como nunca se pidió
// ahí, Seerr no tiene mediaInfo → status 0 → "no disponible", marcando como
// "no cuenta" algo que YA está en Plex. Sin tmdb_id/season_number cae en la
// misma rama de "fila legada" que las importadas antes del issue #14: no se
// resuelve sola por visionado en series (no hay tmdb con el que comparar
// episodios — en películas SÍ se resuelve, es por título normalizado), solo
// caduca por fecha (expiry_days de la biblioteca) o se quita a mano con el
// mismo botón ✕ que un pendiente normal.
// En grupo agregado se atribuye al primer miembro (el saldo es compartido
// igualmente, y decisions_log necesita un user_id real, no el -group_id).
export function addManualCharge(userId, libraryId, title, username = null, note = null, posterUrl = null) {
  const identity = quotaIdentity(userId);
  const attributedUserId = identity.memberIds[0];
  const library = getLibrary.get(libraryId);
  insertImportedApproval.run({
    requestId: -Date.now(),
    userId: attributedUserId,
    username,
    libraryId: Number(libraryId),
    mediaTitle: title,
    mediaType: library?.section_type === 'show' ? 'tv' : 'movie',
    tmdbId: null,
    seasonNumber: null,
    posterUrl: posterUrl || null,
    note: note || null,
    createdAt: toSqliteDateTime(new Date().toISOString()),
  });
}

// v2: temporizador de aprobación — aplaza UNA solicitud concreta hasta
// hold_until, aunque el usuario tenga cupo de sobra. Es una acción puntual del
// admin sobre esa solicitud (no una norma general del usuario o su rol).
const getRequestHoldStmt = db.prepare('SELECT hold_until FROM request_holds WHERE request_id = ?');
const upsertRequestHold = db.prepare(`
  INSERT INTO request_holds (request_id, hold_until) VALUES (?, ?)
  ON CONFLICT (request_id) DO UPDATE SET hold_until = excluded.hold_until
`);
const deleteRequestHold = db.prepare('DELETE FROM request_holds WHERE request_id = ?');

export function getRequestHold(requestId) {
  const row = getRequestHoldStmt.get(requestId);
  if (!row) return null;
  return { holdUntil: Date.parse(row.hold_until.replace(' ', 'T') + 'Z') };
}

export function setRequestHold(requestId, days) {
  upsertRequestHold.run(requestId, toSqliteDateTime(new Date(Date.now() + days * DAY_MS).toISOString()));
}

export function clearRequestHold(requestId) {
  deleteRequestHold.run(requestId);
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

const getCachedUserIds = db.prepare('SELECT DISTINCT user_id FROM quota_cache WHERE user_id >= 0');
const deleteCacheByUser = db.prepare('DELETE FROM quota_cache WHERE user_id = ?');

// Sincroniza la caché de cupo con la lista de usuarios activos de Tautulli: un
// usuario al que se le ha quitado el compartido en Plex (deleted_user/inactivo
// en Tautulli) sigue teniendo fila en quota_cache de cuando era usuario, y su
// tarjeta se quedaba ahí para siempre en la pestaña Cupo. Solo toca la caché
// (recalculable siempre) — decisions_log no se toca, es historial. Ids
// negativos son grupos agregados, no usuarios de Tautulli: se ignoran.
export async function pruneStaleQuotaCache() {
  const activeIds = new Set((await getTautulliUsers()).map((u) => u.id));
  let removed = 0;
  for (const { user_id: userId } of getCachedUserIds.all()) {
    if (!activeIds.has(userId)) {
      deleteCacheByUser.run(userId);
      removed += 1;
    }
  }
  return removed;
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
          note: null,
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
