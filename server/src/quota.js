import { db } from './db.js';
import { config } from './config.js';
import { getUserMovieHistory, getUsers as getTautulliUsers } from './services/tautulli.js';
import { getRequestStatus, getSeerrUsers, getApprovedMovieRequestsForUser, getMovieTitle } from './services/seerr.js';
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
const getLibrary = db.prepare('SELECT * FROM libraries WHERE id = ?');
const getResetAt = db.prepare('SELECT reset_at FROM quota_resets WHERE user_id = ? AND library_id = ?');
const getApprovedTitles = db.prepare(`
  SELECT media_title, tmdb_id FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision = 'approved' AND voided_at IS NULL AND created_at > ?
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
const getLibraryByKind = db.prepare(`SELECT * FROM libraries WHERE kind = ? AND enabled = 1 LIMIT 1`);
const requestAlreadyLogged = db.prepare(`SELECT 1 FROM decisions_log WHERE request_id = ?`);
const insertImportedApproval = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, tmdb_id, decision, created_at)
  VALUES (@requestId, @userId, @username, @libraryId, @mediaTitle, @tmdbId, 'approved', @createdAt)
`);
const upsertQuotaCache = db.prepare(`
  INSERT INTO quota_cache (user_id, library_id, limit_applied, outstanding, balance, computed_at)
  VALUES (?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT (user_id, library_id) DO UPDATE SET
    limit_applied = excluded.limit_applied,
    outstanding = excluded.outstanding,
    balance = excluded.balance,
    computed_at = excluded.computed_at
`);

function toSqliteDateTime(isoString) {
  return isoString.replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

// Parte pura del cálculo (sin DB ni red), para poder testearla sin mockear
// Tautulli/Seerr: dado el límite ya resuelto, las filas aprobadas y el set de
// títulos vistos, decide cuántas están pendientes y cuál es el saldo. Nunca
// negativo: por debajo de 0 se queda en 0 (el bloqueo ya lo gestiona balance < 1).
export function computeBalance(limit, approvedRows, watchedTitles) {
  const pending = approvedRows.filter((r) => !watchedTitles.has(normalize(r.media_title)));
  const outstanding = pending.length;

  const seenTitles = new Set();
  const pendingItems = [];
  for (const r of pending) {
    const key = normalize(r.media_title);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    pendingItems.push({ title: r.media_title, tmdbId: r.tmdb_id });
  }

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
  const library = getLibrary.get(libraryId);
  const override = getOverride.get(userId, libraryId);
  const limit = override ? override.limit_override : library.default_limit;
  const resetAt = getResetAt.get(userId, libraryId)?.reset_at ?? '0000-01-01';

  const history = await getUserMovieHistory(userId, libraryId);
  const watchedTitles = new Set(
    history.filter((h) => h.percent >= WATCHED_THRESHOLD).map((h) => normalize(h.title))
  );

  const approved = getApprovedTitles.all(userId, libraryId, resetAt);
  return computeBalance(limit, approved, watchedTitles);
}

// "Resetea" el cupo de un usuario+biblioteca: las aprobaciones anteriores a ahora
// dejan de contar como pendientes, sin borrar el historial del registro.
export function resetQuota(userId, libraryId) {
  upsertReset.run(userId, libraryId);
}

// La pestaña Cupo lee de quota_cache, no calcula en vivo — cualquier cosa que
// cambie el resultado de getBalance (override, reset, ...) tiene que llamar esto
// para que el panel lo refleje al momento en vez de esperar al siguiente sondeo.
export async function refreshQuotaCache(userId, libraryId) {
  const { limit, outstanding, balance } = await getBalance(userId, libraryId);
  upsertQuotaCache.run(userId, libraryId, limit, outstanding, balance);
  return { limit, outstanding, balance };
}

// Sin esto, una aprobada que nunca llega a ver la luz (cancelada por el usuario, o
// Radarr no la encuentra) se queda ocupando su hueco de cupo para siempre. Se
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

    const requests = await getApprovedMovieRequestsForUser(seerrUser.id);
    for (const request of requests) {
      if (requestAlreadyLogged.get(request.id)) continue;

      const library = getLibraryByKind.get(request.is4k ? '4k' : 'standard');
      if (!library) continue;

      const mediaTitle = await getMovieTitle(request.tmdbId);
      insertImportedApproval.run({
        requestId: request.id,
        userId: tautulliUser.id,
        username: tautulliUser.username,
        libraryId: library.id,
        mediaTitle,
        tmdbId: request.tmdbId ?? null,
        createdAt: toSqliteDateTime(request.createdAt),
      });
      imported += 1;
    }
  }
  return imported;
}
