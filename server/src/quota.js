import { db } from './db.js';
import { getRawSetting, setRawSetting } from './settings.js';
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
  approveRequest,
  declineRequest,
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

// Pedido de Edu (2 ago 2026): al quitar un pendiente del cupo, opción de
// penalizar restando huecos durante N meses. user_id es el cacheId de
// quotaIdentity (real o -group_id), igual que los overrides — una
// penalización se aplica a una identidad concreta, no se reparte por miembro.
// Varias activas a la vez se SUMAN (pedido explícito, no "manda la última").
const getActivePenaltyHoles = db.prepare(`
  SELECT COALESCE(SUM(holes), 0) AS total FROM penalties
  WHERE user_id = ? AND kind = ? AND library_id = ? AND ends_at > datetime('now')
`);
const getActiveTotalPenaltyHoles = db.prepare(`
  SELECT COALESCE(SUM(holes), 0) AS total FROM penalties
  WHERE user_id = ? AND kind = 'monthly' AND library_id IS NULL AND ends_at > datetime('now')
`);
const insertPenalty = db.prepare(`
  INSERT INTO penalties (user_id, library_id, kind, holes, note, ends_at)
  VALUES (@userId, @libraryId, @kind, @holes, @note, datetime('now', '+' || @months || ' months'))
`);
// Sin undo_data a propósito (undoable = undo_data IS NOT NULL en /decisions):
// v1 sin gestión ni deshacer, solo visibilidad en el Registro — caduca sola.
const insertPenaltyLog = db.prepare(`
  INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, decision, note)
  VALUES (@requestId, @userId, @username, @libraryId, @mediaTitle, 'penalty_applied', @note)
`);

// kind='normal' resta del límite de pendientes de esa biblioteca. kind='monthly'
// resta del cupo mensual — de esa biblioteca en modo 'per_library', o del total
// (library_id NULL) en modo 'total', para que aplique al sistema que de verdad
// está en uso.
export function addPenalty(userId, libraryId, kind, holes, months, username = null) {
  const identity = quotaIdentity(userId);
  const targetLibraryId = kind === 'monthly' && getMonthlyQuotaMode() === 'total' ? null : Number(libraryId);
  const holesNum = Math.max(1, Number(holes) || 1);
  const monthsNum = Math.max(1, Number(months) || 1);
  const note = `${kind === 'monthly' ? 'Cupo mensual' : 'Límite normal'}: -${holesNum} durante ${monthsNum} mes${monthsNum === 1 ? '' : 'es'}`;
  insertPenalty.run({ userId: identity.cacheId, libraryId: targetLibraryId, kind, holes: holesNum, note, months: monthsNum });
  insertPenaltyLog.run({
    requestId: -Date.now(),
    userId: identity.cacheId,
    username,
    libraryId: Number(libraryId),
    mediaTitle: null,
    note,
  });
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
// Pedido de Edu (3 ago 2026): lo aprobado fuera de limitARR (admin
// autoaprobado en Seerr, o aprobado a mano en su web — decision
// 'approved_outside_limitarr', ver scheduler.js notifyBypassedApprovals)
// también se lista como pendiente de ver, pero sin restar cupo (computeBalance/
// computeTvBalance lo excluyen de `outstanding` mirando esta misma `decision`).
const getApprovedTitles = db.prepare(`
  SELECT id, request_id, media_title, media_type, tmdb_id, season_number, poster_url, note, created_at, decision FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision IN ('approved', 'approved_outside_limitarr') AND voided_at IS NULL AND created_at > ?
`);
const updateApprovalPoster = db.prepare(`
  UPDATE decisions_log SET poster_url = ? WHERE id = ?
`);
const upsertReset = db.prepare(`
  INSERT INTO quota_resets (user_id, library_id, reset_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT (user_id, library_id) DO UPDATE SET reset_at = excluded.reset_at
`);
// Restaura un reset_at concreto (deshacer un reset), a diferencia de upsertReset
// que siempre fija "ahora".
const restoreResetAt = db.prepare(`
  INSERT INTO quota_resets (user_id, library_id, reset_at) VALUES (?, ?, ?)
  ON CONFLICT (user_id, library_id) DO UPDATE SET reset_at = excluded.reset_at
`);
const deleteReset = db.prepare('DELETE FROM quota_resets WHERE user_id = ? AND library_id = ?');
// request_id > 0: solo solicitudes reales de Seerr. Los cargos manuales
// (addManualCharge) usan un request_id sintético negativo (-Date.now()) que
// nunca existe en Seerr — comprobarlo contra la API devuelve 404 ("gone") y
// los anulaba a los pocos segundos de crearlos (caso Rocío/Euphoria, 21 jul
// 2026: 3 intentos, los 3 anulados en <1 min por el scheduler).
const getUnvoidedApproved = db.prepare(`
  SELECT id, request_id, created_at FROM decisions_log
  WHERE decision IN ('approved', 'approved_outside_limitarr') AND voided_at IS NULL
    AND created_at > datetime('now', '-90 days') AND request_id > 0
`);
const markVoided = db.prepare(`UPDATE decisions_log SET voided_at = datetime('now') WHERE id = ?`);
const clearVoided = db.prepare(`UPDATE decisions_log SET voided_at = NULL WHERE id = ?`);
// Registro de "quitar del cupo"/"resetear" en decisions_log, para que aparezcan
// en la pestaña Registro y se puedan deshacer (issue de jesusgarrigues, 20 jul
// 2026) — fila NUEVA, no se toca la fila 'approved' original (esa solo se
// vacía/revacía vía voided_at). undo_data guarda lo necesario para deshacer.
const insertQuotaActionLog = db.prepare(`
  INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, poster_url, decision, undo_data, created_at)
  VALUES (@requestId, @userId, @username, @libraryId, @mediaTitle, @posterUrl, @decision, @undoData, datetime('now'))
`);
// Atajo para loguear una acción admin deshacible — todas las variantes
// (override, hold, aprobar/rechazar...) comparten esta forma.
function logAdminChange({ decision, userId = null, libraryId = null, username = null, mediaTitle = null, posterUrl = null, undoData }) {
  insertQuotaActionLog.run({
    requestId: -Date.now(),
    userId,
    username,
    libraryId: libraryId != null ? Number(libraryId) : null,
    mediaTitle,
    posterUrl,
    decision,
    undoData: JSON.stringify(undoData),
  });
}
const getDecisionRow = db.prepare('SELECT * FROM decisions_log WHERE id = ?');
const markUndone = db.prepare(`UPDATE decisions_log SET undone_at = datetime('now') WHERE id = ?`);
const setUndoData = db.prepare(`UPDATE decisions_log SET undo_data = ? WHERE id = ?`);
const getLibraryForRequest = db.prepare(`
  SELECT * FROM libraries WHERE section_type = ? AND kind = ? AND enabled = 1 LIMIT 1
`);
// v3: cupo mensual TOTAL — igual que el mensual por biblioteca, pero sin
// filtrar por library_id: cuenta TODAS las aprobaciones del mes, en
// cualquier biblioteca. El límite por defecto vive en settings (Ajustes),
// no en libraries.
const DEFAULT_MONTHLY_TOTAL_LIMIT = 20;

// Reset de cupo mensual = inicio del mes UTC siguiente (mismo corte que usa
// filterAvailableThisMonth vía 'start of month' en SQLite, que es UTC).
export function getDaysUntilMonthlyReset() {
  const now = new Date();
  const nextMonthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.ceil((nextMonthStartMs - now.getTime()) / 86400000);
}

// Filas aprobadas de un usuario en TODAS las bibliotecas habilitadas, con el
// kind (HD/4K) de cada una — Seerr guarda disponibilidad por separado para
// cada calidad, hace falta saber cuál mirar (ver filterAvailableThisMonth).
const getApprovedRowsAllLibraries = db.prepare(`
  SELECT dl.id, dl.media_title, dl.media_type, dl.tmdb_id, dl.season_number, dl.poster_url,
         dl.username, dl.library_id, dl.created_at, l.kind AS kind
  FROM decisions_log dl
  JOIN libraries l ON l.id = dl.library_id
  WHERE dl.user_id = ? AND dl.decision = 'approved' AND dl.voided_at IS NULL AND l.enabled = 1
`);

// Pedido de Edu (2 ago 2026): lo que aún no está descargado no debe contar
// para el cupo mensual — antes se contaba igual que lo ya disponible,
// dejando "gastar" cupo mensual en algo que ni siquiera ha llegado a Plex.
// Filtra `rows` (aprobadas, cualquier estado, con `kind` en las de película)
// a las de este mes que YA están disponibles — vista o no, da igual, con que
// se pueda ver ya. Async: consulta Seerr igual que el cálculo del saldo.
async function filterAvailableThisMonth(rows) {
  const now = new Date();
  const startOfMonthMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const thisMonth = rows.filter((r) => rowTimeMs(r) >= startOfMonthMs);
  if (thisMonth.length === 0) return [];

  const movieRows = thisMonth.filter((r) => r.media_type !== 'tv');
  const tvRows = thisMonth.filter((r) => r.media_type === 'tv');
  const available = [];

  const moviesByKind = new Map();
  for (const r of movieRows) {
    const kind = r.kind || 'standard';
    if (!moviesByKind.has(kind)) moviesByKind.set(kind, []);
    moviesByKind.get(kind).push(r);
  }
  for (const [kind, kindRows] of moviesByKind) {
    const availability = await getMovieAvailability(kindRows.map((r) => r.tmdb_id), kind === '4k');
    for (const r of kindRows) {
      if (r.tmdb_id == null || !availability.get(r.tmdb_id)?.unavailable) available.push(r);
    }
  }

  const tvDetailsCache = new Map();
  for (const r of tvRows) {
    if (r.tmdb_id == null || r.season_number == null) {
      available.push(r);
      continue;
    }
    const key = `${r.tmdb_id}:${r.season_number}`;
    if (!tvDetailsCache.has(key)) tvDetailsCache.set(key, await getMediaDetails('tv', r.tmdb_id, r.season_number));
    const details = tvDetailsCache.get(key);
    // seasonStatuses null = error de red: no se sabe, se cuenta igual (mismo
    // criterio que el resto del código: en la duda, cuenta).
    const status = details?.seasonStatuses?.[r.season_number] ?? 0;
    const unavailable = details?.seasonStatuses != null && status < 4;
    if (!unavailable) available.push(r);
  }
  return available;
}

// Issue #20: filas detrás del contador getMonthlyTotalQuota (mismo filtro de
// disponibilidad), para el mismo usuario/grupo agregado.
export async function getMonthlyHistoryRowsTotal(userId) {
  const identity = quotaIdentity(userId);
  const rows = identity.memberIds.flatMap((memberId) => getApprovedRowsAllLibraries.all(memberId));
  const available = await filterAvailableThisMonth(rows);
  return available.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
const getMonthlyTotalOverrideRaw = db.prepare('SELECT * FROM monthly_total_overrides WHERE user_id = ?');
const getGroupMonthlyTotalOverrideForUser = db.prepare(`
  SELECT gmto.limit_override FROM group_members gm
  JOIN group_monthly_total_overrides gmto ON gmto.group_id = gm.group_id
  WHERE gm.user_id = ?
`);
const getGroupMonthlyTotalOverrideRaw = db.prepare('SELECT * FROM group_monthly_total_overrides WHERE group_id = ?');
const getRoleMonthlyTotalOverrideForUser = db.prepare(`
  SELECT rmto.limit_override FROM user_roles ur
  JOIN role_monthly_total_overrides rmto ON rmto.role_id = ur.role_id
  WHERE ur.user_id = ?
`);
const getRoleMonthlyTotalOverrideRaw = db.prepare('SELECT * FROM role_monthly_total_overrides WHERE role_id = ?');

// El cupo mensual es o por biblioteca (v2) o total (v3), nunca los dos a la
// vez — Edu lo pidió tras tener ambos activables por separado y confundirse
// sobre cuál mandaba. El modo vive en un único setting; 'per_library' es el
// valor por defecto porque es el que ya estaba en uso en producción.
export function getMonthlyQuotaMode() {
  return getRawSetting('monthly_quota_mode') === 'total' ? 'total' : 'per_library';
}

export function setMonthlyQuotaMode(mode) {
  if (mode === 'total' || mode === 'per_library') setRawSetting('monthly_quota_mode', mode);
}

export function getMonthlyTotalSettings() {
  const enabled = getMonthlyQuotaMode() === 'total';
  const rawLimit = Number(getRawSetting('monthly_total_limit'));
  const limit = Number.isInteger(rawLimit) && rawLimit >= 0 ? rawLimit : DEFAULT_MONTHLY_TOTAL_LIMIT;
  return { enabled, limit };
}

export function setMonthlyTotalSettings({ limit }) {
  if (limit !== undefined && limit !== null && limit !== '') {
    const n = Number(limit);
    if (Number.isInteger(n) && n >= 0) setRawSetting('monthly_total_limit', String(n));
  }
}

// Mismo cálculo que getBalance().monthly, pero global: suma lo aprobado en
// TODAS las bibliotecas (no una sola) contra el límite de Ajustes, con la
// misma precedencia de overrides (individual > grupo > rol > global). Un
// grupo agregado no tiene rol propio, igual que en getBalance.
export async function getMonthlyTotalQuota(userId) {
  const { enabled, limit: globalLimit } = getMonthlyTotalSettings();
  const identity = quotaIdentity(userId);
  let limit;
  if (identity.aggregated) {
    const groupOverride = getGroupMonthlyTotalOverrideRaw.get(identity.groupId);
    limit = resolveLimit([groupOverride?.limit_override ?? null], globalLimit);
  } else {
    const override = getMonthlyTotalOverrideRaw.get(identity.cacheId);
    const groupOverride = getGroupMonthlyTotalOverrideForUser.get(identity.cacheId);
    const roleOverride = getRoleMonthlyTotalOverrideForUser.get(identity.cacheId);
    limit = resolveLimit(
      [override?.limit_override ?? null, groupOverride?.limit_override ?? null, roleOverride?.limit_override ?? null],
      globalLimit
    );
  }
  limit = Math.max(0, limit - getActiveTotalPenaltyHoles.get(identity.cacheId).total);
  let used = 0;
  if (enabled) {
    const rows = identity.memberIds.flatMap((memberId) => getApprovedRowsAllLibraries.all(memberId));
    used = (await filterAvailableThisMonth(rows)).length;
  }
  return { enabled, limit, used, remaining: Math.max(0, limit - used), daysUntilReset: getDaysUntilMonthlyReset() };
}

// v2: cupo mensual — cuenta lo aprobado (y no anulado, y ya disponible en
// Plex — ver filterAvailableThisMonth) en el mes en curso, para TODOS los
// miembros de la identidad de cupo (igual que el saldo). Un cargo manual
// también es una fila 'approved' en esta tabla, así que cuenta igual sin
// lógica extra (siempre que tenga tmdb_id; si no, se trata como disponible).
const getApprovedRowsForLibrary = db.prepare(`
  SELECT id, media_title, media_type, tmdb_id, season_number, poster_url, username, created_at
  FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision = 'approved' AND voided_at IS NULL
`);

export async function getMonthlyHistoryRows(userId, libraryId) {
  const identity = quotaIdentity(userId);
  const library = getLibrary.get(libraryId);
  const rows = identity.memberIds.flatMap((memberId) =>
    getApprovedRowsForLibrary.all(memberId, libraryId).map((r) => ({ ...r, kind: library?.kind }))
  );
  const available = await filterAvailableThisMonth(rows);
  return available.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}
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
// pendiente aún no disponible no caduca: no se puede ver todavía. Se mantiene
// visible hasta que llegue a estar disponible o se quite/cancele en Seerr.
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

// Pedido de Edu (17 ago 2026): persiste la fecha de entrada en biblioteca en
// vez de fiarse del mediaAddedAt de Seerr tal cual (ver comentario en la
// tabla library_entries, db.js) — así una película que sale y vuelve a
// entrar recupera la fecha de la ÚLTIMA vez, no la primera. Muta en sitio los
// valores de `availability` (Map nuevo por llamada a getMovieAvailability,
// no el objeto cacheado dentro de seerr.js) para que dropExpiredRows/
// computeBalance usen ya la fecha corregida sin más cambios.
const getLibraryEntry = db.prepare('SELECT entered_at, was_unavailable FROM library_entries WHERE tmdb_id = ? AND is4k = ?');
const upsertLibraryEntry = db.prepare(`
  INSERT INTO library_entries (tmdb_id, is4k, entered_at, was_unavailable)
  VALUES (@tmdbId, @is4k, @enteredAt, 0)
  ON CONFLICT (tmdb_id, is4k) DO UPDATE SET entered_at = @enteredAt, was_unavailable = 0
`);
const markLibraryEntryUnavailable = db.prepare(
  'UPDATE library_entries SET was_unavailable = 1 WHERE tmdb_id = ? AND is4k = ?'
);

function trackLibraryEntries(availability, is4k) {
  const is4kFlag = is4k ? 1 : 0;
  for (const [tmdbId, info] of availability) {
    if (info.unavailable) {
      markLibraryEntryUnavailable.run(tmdbId, is4kFlag);
      continue;
    }
    const existing = getLibraryEntry.get(tmdbId, is4kFlag);
    if (!existing) {
      const enteredAt = new Date(info.availableSince ?? Date.now()).toISOString();
      upsertLibraryEntry.run({ tmdbId, is4k: is4kFlag, enteredAt });
      info.availableSince = Date.parse(enteredAt);
    } else if (existing.was_unavailable) {
      const enteredAt = new Date().toISOString();
      upsertLibraryEntry.run({ tmdbId, is4k: is4kFlag, enteredAt });
      info.availableSince = Date.parse(enteredAt);
    } else {
      info.availableSince = Date.parse(existing.entered_at);
    }
  }
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
  // Pedido de Edu (3 ago 2026): lo aprobado fuera de limitARR (admin
  // autoaprobado en Seerr) se lista igual, pero no resta cupo.
  const isBypassed = (r) => r.decision === 'approved_outside_limitarr';
  const outstanding = pending.filter((r) => !isUnavailable(r) && !isBypassed(r)).length;

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
      bypassed: isBypassed(r),
      mediaStatus: r.tmdb_id != null ? availability?.get(r.tmdb_id)?.status ?? null : null,
      // Estado real de la cola de Radarr ("downloading", "queued", "paused"...),
      // no el status 2/3 de Seerr (que solo dice "solicitada"/"monitorizada") —
      // ver movieAvailability. null = nada en cola ahora mismo.
      queueStatus: r.tmdb_id != null ? availability?.get(r.tmdb_id)?.queueStatus ?? null : null,
      // Estado real de Radarr (opcional, requiere radarr_url/radarr_api_key en
      // Configuración) cuando no hay nada en cola — "No disponible", "Falta"...
      // en vez de un "pendiente de descarga" genérico. Ver movieAvailability.
      radarrLabel: r.tmdb_id != null ? availability?.get(r.tmdb_id)?.radarrLabel ?? null : null,
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

// Mismas tres llaves que buildWatchedEpisodeIndex, pero guardando la fecha más
// reciente en vez de solo si se vio — para el backfill del Registro (reconstruir
// cuándo se vio algo aprobado antes de que existiera el log de 'watched').
function buildWatchedEpisodeDateIndex(watchedEpisodes) {
  const byRatingKey = new Map();
  const byShowKey = new Map();
  const byTitle = new Map();
  for (const h of watchedEpisodes) {
    if (h.percent < WATCHED_THRESHOLD || h.date == null) continue;
    if (h.ratingKey) byRatingKey.set(h.ratingKey, Math.max(byRatingKey.get(h.ratingKey) ?? 0, h.date));
    if (Number.isFinite(h.seasonNumber) && Number.isFinite(h.episodeNumber)) {
      if (h.showRatingKey) {
        const k = `${h.showRatingKey}:${h.seasonNumber}:${h.episodeNumber}`;
        byShowKey.set(k, Math.max(byShowKey.get(k) ?? 0, h.date));
      }
      if (h.showTitle) {
        const k = `${normalize(h.showTitle)}:${h.seasonNumber}:${h.episodeNumber}`;
        byTitle.set(k, Math.max(byTitle.get(k) ?? 0, h.date));
      }
    }
  }
  return { byRatingKey, byShowKey, byTitle };
}

// Fecha en la que una temporada quedó vista: la más tardía entre sus episodios
// que hicieron match (mismo criterio de 3 llaves que seasonWatchState), es
// decir cuándo se completó el umbral. null si no hay fecha para ninguno.
function seasonCompletionDate(dateIndex, episodes, { showTitle, showRatingKey, seasonNumber }) {
  const normalizedTitle = showTitle ? normalize(showTitle) : null;
  let latest = null;
  for (const episode of episodes) {
    const date =
      dateIndex.byRatingKey.get(episode.ratingKey) ??
      (showRatingKey != null ? dateIndex.byShowKey.get(`${showRatingKey}:${seasonNumber}:${episode.episodeNumber}`) : null) ??
      (normalizedTitle != null ? dateIndex.byTitle.get(`${normalizedTitle}:${seasonNumber}:${episode.episodeNumber}`) : null);
    if (date != null) latest = latest == null ? date : Math.max(latest, date);
  }
  return latest;
}

// Caso Seve/Silo (2 ago 2026): Maintainerr puede borrar una temporada de Plex
// tras verla (colección tipo "temporada" con borrado a los N días); Tautulli
// deja entonces de tener sus episodios en get_children_metadata y
// seasonWatchState no puede confirmar el visionado (total=0, nunca "complete"),
// así que la temporada resucitaba como pendiente pese a haberse liberado ya el
// cupo. Respaldo: si ya hay un 'watched'/'expired' logueado para esta fila
// exacta (mismo criterio que hasWatchedOrExpired/requestUnitAlreadyLogged),
// se confía en ese registro en vez de en Tautulli.
const hasWatchedOrExpiredForRow = db.prepare(`
  SELECT 1 FROM decisions_log
  WHERE request_id = ? AND media_type = 'tv' AND COALESCE(season_number, -1) = COALESCE(?, -1)
    AND decision IN ('watched', 'expired')
  LIMIT 1
`);

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
    // Cacheada por tmdb_id+temporada, no solo tmdb_id: posterUrl (carátula de
    // la temporada) y sonarrLabel dependen de qué temporada se pide, y un
    // mismo show puede tener varias temporadas pendientes a la vez.
    const detailsCacheKey = `${row.tmdb_id}:${row.season_number}`;
    if (!showDetailsCache.has(detailsCacheKey)) {
      showDetailsCache.set(detailsCacheKey, await getMediaDetails('tv', row.tmdb_id, row.season_number));
    }
    const details = showDetailsCache.get(detailsCacheKey);
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
    const alreadyFreed = state.total === 0 && Boolean(hasWatchedOrExpiredForRow.get(row.request_id, row.season_number));
    if (!state.complete && !alreadyFreed) {
      // Mismo criterio que en películas (issue #1): una temporada que Seerr aún
      // no da por disponible (status < 4: nada descargado) no resta cupo, pero
      // se lista con marca. seasonStatuses null = error de red → cuenta.
      const status = details?.seasonStatuses?.[row.season_number];
      row.unavailable = details?.seasonStatuses != null && (status ?? 0) < 4;
      row.media_status = status ?? null;
      // Estado real de la cola de Sonarr para esa temporada (ver getShowDetails).
      row.queue_status = details?.seasonQueueStatus?.[row.season_number] ?? null;
      // Estado real de Sonarr (derivado, sin cola activa) — ver getShowDetails.
      row.sonarr_label = details?.sonarrLabel ?? null;
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

  // Pedido de Edu (3 ago 2026): lo aprobado fuera de limitARR (admin
  // autoaprobado en Seerr) se lista igual, pero no resta cupo.
  const isBypassed = (r) => r.decision === 'approved_outside_limitarr';
  const outstanding = pending.filter((r) => !r.unavailable && !isBypassed(r)).length;
  const pendingItems = pending.map((r) => ({
    title: r.media_title,
    mediaType: 'tv',
    tmdbId: r.tmdb_id,
    seasonNumber: r.season_number ?? null,
    posterUrl: r.poster_url ?? null,
    unavailable: r.unavailable ?? false,
    bypassed: isBypassed(r),
    mediaStatus: r.media_status ?? null,
    queueStatus: r.queue_status ?? null,
    sonarrLabel: r.sonarr_label ?? null,
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
  limit = Math.max(0, limit - getActivePenaltyHoles.get(identity.cacheId, 'normal', libraryId).total);
  // Penalización de cupo mensual guardada en modo 'total' vive con library_id
  // NULL (ver addPenalty) — aquí no aplica, la resta getMonthlyTotalQuota.
  monthlyLimit = Math.max(0, monthlyLimit - getActivePenaltyHoles.get(identity.cacheId, 'monthly', libraryId).total);
  const resetAt = getResetAt.get(identity.cacheId, libraryId)?.reset_at ?? '0000-01-01';
  // v2: cupo mensual — independiente de si se ha visto o no, pero NO de si ya
  // está disponible en Plex (pedido de Edu, 2 ago 2026: lo aún no descargado
  // no debe contar). Consulta propia sin filtrar por resetAt: un reset del
  // saldo normal no afecta al mensual, igual que antes. Solo se calcula si
  // está activado — si no, ahorra la consulta a Seerr en cada ciclo/biblioteca.
  const monthlyEnabled = getMonthlyQuotaMode() === 'per_library' && Boolean(library.monthly_quota_enabled);
  let monthlyUsed = 0;
  if (monthlyEnabled) {
    const monthlyRows = identity.memberIds.flatMap((memberId) =>
      getApprovedRowsForLibrary.all(memberId, libraryId).map((r) => ({ ...r, kind: library.kind }))
    );
    monthlyUsed = (await filterAvailableThisMonth(monthlyRows)).length;
  }
  const monthly = {
    enabled: monthlyEnabled,
    limit: monthlyLimit,
    used: monthlyUsed,
    remaining: Math.max(0, monthlyLimit - monthlyUsed),
    daysUntilReset: getDaysUntilMonthlyReset(),
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
  trackLibraryEntries(availability, library.kind === '4k');
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
// dejan de contar como pendientes, sin borrar el historial del registro. Queda
// logueado en decisions_log (decision='reset') con el reset_at anterior (o
// null si nunca se había reseteado) para poder deshacerlo exactamente.
export function resetQuota(userId, libraryId, username = null) {
  const cacheId = quotaIdentity(userId).cacheId;
  const previousResetAt = getResetAt.get(cacheId, libraryId)?.reset_at ?? null;
  upsertReset.run(cacheId, libraryId);
  insertQuotaActionLog.run({
    requestId: -Date.now(),
    userId: cacheId,
    username,
    libraryId: Number(libraryId),
    mediaTitle: null,
    posterUrl: null,
    decision: 'reset',
    undoData: JSON.stringify({ previousResetAt }),
  });
}

// --- Overrides de límite/caducidad, con registro + deshacer (petición de
// Edu, 20 jul 2026, ampliando el issue de jesusgarrigues a "cualquier cambio
// admin"). Mismo patrón en los tres niveles: se guarda la fila ANTERIOR
// completa (o null si no existía) en undo_data — deshacer solo la reinserta
// tal cual, o borra si no había nada antes. La escritura real vive aquí (antes
// estaba inline en la ruta) para que capturar el "antes" y loguear queden
// atómicos con el cambio, no repartidos entre quota.js y routes/api.js.
const getGroupOverrideRaw = db.prepare('SELECT * FROM group_overrides WHERE group_id = ? AND library_id = ?');
const getRoleOverrideRaw = db.prepare('SELECT * FROM role_overrides WHERE role_id = ? AND library_id = ?');

function restoreOverride(userId, libraryId, previous) {
  if (!previous) {
    db.prepare('DELETE FROM overrides WHERE user_id = ? AND library_id = ?').run(userId, libraryId);
    return;
  }
  db.prepare(`
    INSERT INTO overrides (user_id, library_id, limit_override, note, expiry_override, monthly_limit_override, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override, note = excluded.note,
      expiry_override = excluded.expiry_override, monthly_limit_override = excluded.monthly_limit_override,
      updated_at = excluded.updated_at
  `).run(userId, libraryId, previous.limit_override, previous.note, previous.expiry_override, previous.monthly_limit_override);
}

function restoreGroupOverride(groupId, libraryId, previous) {
  if (!previous) {
    db.prepare('DELETE FROM group_overrides WHERE group_id = ? AND library_id = ?').run(groupId, libraryId);
    return;
  }
  db.prepare(`
    INSERT INTO group_overrides (group_id, library_id, limit_override, expiry_override, monthly_limit_override, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (group_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override, expiry_override = excluded.expiry_override,
      monthly_limit_override = excluded.monthly_limit_override, updated_at = excluded.updated_at
  `).run(groupId, libraryId, previous.limit_override, previous.expiry_override, previous.monthly_limit_override);
}

function restoreRoleOverride(roleId, libraryId, previous) {
  if (!previous) {
    db.prepare('DELETE FROM role_overrides WHERE role_id = ? AND library_id = ?').run(roleId, libraryId);
    return;
  }
  db.prepare(`
    INSERT INTO role_overrides (role_id, library_id, limit_override, expiry_override, monthly_limit_override, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (role_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override, expiry_override = excluded.expiry_override,
      monthly_limit_override = excluded.monthly_limit_override, updated_at = excluded.updated_at
  `).run(roleId, libraryId, previous.limit_override, previous.expiry_override, previous.monthly_limit_override);
}

export function setOverride(userId, libraryId, { limitOverride, note, expiryOverride, monthlyLimitOverride }, actorUsername = null) {
  const previous = getOverride.get(userId, libraryId) ?? null;
  db.prepare(`
    INSERT INTO overrides (user_id, library_id, limit_override, note, expiry_override, monthly_limit_override, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override, note = excluded.note,
      expiry_override = excluded.expiry_override, monthly_limit_override = excluded.monthly_limit_override,
      updated_at = excluded.updated_at
  `).run(userId, libraryId, limitOverride, note || null, expiryOverride ?? null, monthlyLimitOverride ?? null);
  logAdminChange({
    decision: 'override_changed',
    userId: Number(userId),
    libraryId,
    username: actorUsername,
    undoData: { userId: Number(userId), libraryId: Number(libraryId), previous },
  });
}

export function deleteOverride(userId, libraryId, actorUsername = null) {
  const previous = getOverride.get(userId, libraryId) ?? null;
  db.prepare('DELETE FROM overrides WHERE user_id = ? AND library_id = ?').run(userId, libraryId);
  if (!previous) return; // nada que había, nada que deshacer
  logAdminChange({
    decision: 'override_changed',
    userId: Number(userId),
    libraryId,
    username: actorUsername,
    undoData: { userId: Number(userId), libraryId: Number(libraryId), previous },
  });
}

export function setGroupOverride(groupId, libraryId, { limitOverride, expiryOverride, monthlyLimitOverride }, groupName = null) {
  const previous = getGroupOverrideRaw.get(groupId, libraryId) ?? null;
  db.prepare(`
    INSERT INTO group_overrides (group_id, library_id, limit_override, expiry_override, monthly_limit_override, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (group_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override, expiry_override = excluded.expiry_override,
      monthly_limit_override = excluded.monthly_limit_override, updated_at = excluded.updated_at
  `).run(groupId, libraryId, limitOverride, expiryOverride ?? null, monthlyLimitOverride ?? null);
  logAdminChange({
    decision: 'group_override_changed',
    libraryId,
    username: groupName,
    undoData: { groupId: Number(groupId), libraryId: Number(libraryId), previous },
  });
}

export function deleteGroupOverride(groupId, libraryId, groupName = null) {
  const previous = getGroupOverrideRaw.get(groupId, libraryId) ?? null;
  db.prepare('DELETE FROM group_overrides WHERE group_id = ? AND library_id = ?').run(groupId, libraryId);
  if (!previous) return;
  logAdminChange({
    decision: 'group_override_changed',
    libraryId,
    username: groupName,
    undoData: { groupId: Number(groupId), libraryId: Number(libraryId), previous },
  });
}

export function setRoleOverride(roleId, libraryId, { limitOverride, expiryOverride, monthlyLimitOverride }, roleName = null) {
  const previous = getRoleOverrideRaw.get(roleId, libraryId) ?? null;
  db.prepare(`
    INSERT INTO role_overrides (role_id, library_id, limit_override, expiry_override, monthly_limit_override, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (role_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override, expiry_override = excluded.expiry_override,
      monthly_limit_override = excluded.monthly_limit_override, updated_at = excluded.updated_at
  `).run(roleId, libraryId, limitOverride, expiryOverride ?? null, monthlyLimitOverride ?? null);
  logAdminChange({
    decision: 'role_override_changed',
    libraryId,
    username: roleName,
    undoData: { roleId: Number(roleId), libraryId: Number(libraryId), previous },
  });
}

export function deleteRoleOverride(roleId, libraryId, roleName = null) {
  const previous = getRoleOverrideRaw.get(roleId, libraryId) ?? null;
  db.prepare('DELETE FROM role_overrides WHERE role_id = ? AND library_id = ?').run(roleId, libraryId);
  if (!previous) return;
  logAdminChange({
    decision: 'role_override_changed',
    libraryId,
    username: roleName,
    undoData: { roleId: Number(roleId), libraryId: Number(libraryId), previous },
  });
}

// --- Overrides del cupo mensual TOTAL (v3): mismo patrón que arriba, pero sin
// libraryId — un único override por usuario/grupo/rol.
function restoreMonthlyTotalOverride(userId, previous) {
  if (!previous) {
    db.prepare('DELETE FROM monthly_total_overrides WHERE user_id = ?').run(userId);
    return;
  }
  db.prepare(`
    INSERT INTO monthly_total_overrides (user_id, limit_override, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (user_id) DO UPDATE SET limit_override = excluded.limit_override, updated_at = excluded.updated_at
  `).run(userId, previous.limit_override);
}

function restoreGroupMonthlyTotalOverride(groupId, previous) {
  if (!previous) {
    db.prepare('DELETE FROM group_monthly_total_overrides WHERE group_id = ?').run(groupId);
    return;
  }
  db.prepare(`
    INSERT INTO group_monthly_total_overrides (group_id, limit_override, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (group_id) DO UPDATE SET limit_override = excluded.limit_override, updated_at = excluded.updated_at
  `).run(groupId, previous.limit_override);
}

function restoreRoleMonthlyTotalOverride(roleId, previous) {
  if (!previous) {
    db.prepare('DELETE FROM role_monthly_total_overrides WHERE role_id = ?').run(roleId);
    return;
  }
  db.prepare(`
    INSERT INTO role_monthly_total_overrides (role_id, limit_override, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (role_id) DO UPDATE SET limit_override = excluded.limit_override, updated_at = excluded.updated_at
  `).run(roleId, previous.limit_override);
}

export function setMonthlyTotalOverride(userId, limitOverride, actorUsername = null) {
  const previous = getMonthlyTotalOverrideRaw.get(userId) ?? null;
  db.prepare(`
    INSERT INTO monthly_total_overrides (user_id, limit_override, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (user_id) DO UPDATE SET limit_override = excluded.limit_override, updated_at = excluded.updated_at
  `).run(userId, limitOverride);
  logAdminChange({
    decision: 'monthly_total_override_changed',
    userId: Number(userId),
    username: actorUsername,
    undoData: { userId: Number(userId), previous },
  });
}

export function deleteMonthlyTotalOverride(userId, actorUsername = null) {
  const previous = getMonthlyTotalOverrideRaw.get(userId) ?? null;
  db.prepare('DELETE FROM monthly_total_overrides WHERE user_id = ?').run(userId);
  if (!previous) return;
  logAdminChange({
    decision: 'monthly_total_override_changed',
    userId: Number(userId),
    username: actorUsername,
    undoData: { userId: Number(userId), previous },
  });
}

export function setGroupMonthlyTotalOverride(groupId, limitOverride, groupName = null) {
  const previous = getGroupMonthlyTotalOverrideRaw.get(groupId) ?? null;
  db.prepare(`
    INSERT INTO group_monthly_total_overrides (group_id, limit_override, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (group_id) DO UPDATE SET limit_override = excluded.limit_override, updated_at = excluded.updated_at
  `).run(groupId, limitOverride);
  logAdminChange({
    decision: 'group_monthly_total_override_changed',
    username: groupName,
    undoData: { groupId: Number(groupId), previous },
  });
}

export function deleteGroupMonthlyTotalOverride(groupId, groupName = null) {
  const previous = getGroupMonthlyTotalOverrideRaw.get(groupId) ?? null;
  db.prepare('DELETE FROM group_monthly_total_overrides WHERE group_id = ?').run(groupId);
  if (!previous) return;
  logAdminChange({
    decision: 'group_monthly_total_override_changed',
    username: groupName,
    undoData: { groupId: Number(groupId), previous },
  });
}

export function setRoleMonthlyTotalOverride(roleId, limitOverride, roleName = null) {
  const previous = getRoleMonthlyTotalOverrideRaw.get(roleId) ?? null;
  db.prepare(`
    INSERT INTO role_monthly_total_overrides (role_id, limit_override, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT (role_id) DO UPDATE SET limit_override = excluded.limit_override, updated_at = excluded.updated_at
  `).run(roleId, limitOverride);
  logAdminChange({
    decision: 'role_monthly_total_override_changed',
    username: roleName,
    undoData: { roleId: Number(roleId), previous },
  });
}

export function deleteRoleMonthlyTotalOverride(roleId, roleName = null) {
  const previous = getRoleMonthlyTotalOverrideRaw.get(roleId) ?? null;
  db.prepare('DELETE FROM role_monthly_total_overrides WHERE role_id = ?').run(roleId);
  if (!previous) return;
  logAdminChange({
    decision: 'role_monthly_total_override_changed',
    username: roleName,
    undoData: { roleId: Number(roleId), previous },
  });
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
  SELECT id, media_title, tmdb_id, season_number, created_at, username, poster_url FROM decisions_log
  WHERE user_id = ? AND library_id = ? AND decision IN ('approved', 'approved_outside_limitarr') AND voided_at IS NULL
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
  const info = insertImportedApproval.run({
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
  // Deshacer un cargo manual (issue de jesusgarrigues, 20 jul 2026, ampliado a
  // "cualquier cambio admin") es anular esta misma fila — no hace falta una
  // fila de registro aparte, la propia 'approved' lleva su undo_data.
  setUndoData.run(JSON.stringify({ selfIds: [info.lastInsertRowid] }), info.lastInsertRowid);
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

// `context` es opcional a propósito: el scheduler también llama a estas dos
// funciones (plazo cumplido, limpieza automática) y esos casos NO deben
// aparecer en el Registro como si fueran una acción del admin — solo se
// loguea cuando quien llama pasa contexto (el botón del panel sí lo pasa).
export function setRequestHold(requestId, days, context = {}) {
  upsertRequestHold.run(requestId, toSqliteDateTime(new Date(Date.now() + days * DAY_MS).toISOString()));
  if (context.userId != null) {
    logAdminChange({
      decision: 'held',
      userId: context.userId,
      libraryId: context.libraryId,
      username: context.username,
      mediaTitle: context.title,
      posterUrl: context.posterUrl,
      undoData: { requestId },
    });
  }
}

export function clearRequestHold(requestId, context = {}) {
  const existing = getRequestHold(requestId);
  deleteRequestHold.run(requestId);
  if (context.userId != null && existing) {
    logAdminChange({
      decision: 'hold_cleared',
      userId: context.userId,
      libraryId: context.libraryId,
      username: context.username,
      mediaTitle: context.title,
      posterUrl: context.posterUrl,
      undoData: { requestId, holdUntil: existing.holdUntil },
    });
  }
}

// Restaura un hold_until concreto (deshacer un "quitar aplazamiento"), a
// diferencia de setRequestHold que siempre cuenta N días desde ahora.
function restoreRequestHold(requestId, holdUntilMs) {
  upsertRequestHold.run(requestId, toSqliteDateTime(new Date(holdUntilMs).toISOString()));
}

// Quita a mano UN pendiente del cupo de un usuario (botón ✕ del panel), sin
// resetear todo: anula (voided_at) sus filas aprobadas, igual que hace la
// reconciliación automática con las canceladas.
// Queda logueado en decisions_log (decision='dismissed') con los ids de las
// filas anuladas, para poder deshacerlo (issue de jesusgarrigues, 20 jul 2026)
// — al deshacer solo se limpia voided_at, la caducidad de siempre (comprobada
// en vivo en cada cálculo) ya se encarga de que no reaparezca si mientras tanto
// caducó por tiempo.
export function dismissPendingItem(userId, libraryId, { tmdbId, seasonNumber, title }, username = null) {
  const identity = quotaIdentity(userId);
  const voidedIds = [];
  let matchedTitle = title || null;
  let matchedUsername = username;
  let matchedPosterUrl = null;
  for (const memberId of identity.memberIds) {
    for (const row of getPendingApprovedRows.all(memberId, libraryId)) {
      if (matchesPendingRow(row, { tmdbId, seasonNumber, title })) {
        markVoided.run(row.id);
        voidedIds.push(row.id);
        matchedTitle = matchedTitle ?? row.media_title;
        matchedUsername = matchedUsername ?? row.username;
        matchedPosterUrl = matchedPosterUrl ?? row.poster_url;
      }
    }
  }
  if (voidedIds.length > 0) {
    insertQuotaActionLog.run({
      requestId: -Date.now(),
      userId: identity.cacheId,
      username: matchedUsername,
      libraryId: Number(libraryId),
      mediaTitle: matchedTitle,
      posterUrl: matchedPosterUrl,
      decision: 'dismissed',
      undoData: JSON.stringify({ voidedIds }),
    });
  }
  return voidedIds.length;
}

// Deshace un 'dismissed' o 'reset' del Registro (issue de jesusgarrigues, 20
// jul 2026): limpia voided_at de las filas afectadas, o restaura el reset_at
// anterior. No se puede deshacer dos veces (undone_at) ni nada que no sea uno
// de estos dos tipos.
// Ampliado (petición de Edu, 20 jul 2026) de solo dismiss/reset a "cualquier
// cambio admin": cargo manual, aprobar/rechazar/aplazar solicitudes, y
// overrides de límite/caducidad (individual/grupo/rol). approved/declined
// también deshacen el lado de Seerr (approveRequest/declineRequest) — no es
// solo un cambio local, es literalmente "deshacer la aprobación/rechazo de
// verdad", así que cancela/reactiva la descarga en Radarr/Sonarr vía Seerr.
// async por eso (approve/decline pegan a la red); el resto es solo DB.
export async function undoQuotaAction(logId) {
  const row = getDecisionRow.get(logId);
  if (!row || row.undone_at || !row.undo_data) return null;
  const data = JSON.parse(row.undo_data);
  let result;
  switch (row.decision) {
    case 'dismissed':
      for (const id of data.voidedIds || []) clearVoided.run(id);
      result = { kind: 'user', userId: row.user_id, libraryId: row.library_id };
      break;
    case 'reset':
      if (data.previousResetAt) restoreResetAt.run(row.user_id, row.library_id, data.previousResetAt);
      else deleteReset.run(row.user_id, row.library_id);
      result = { kind: 'user', userId: row.user_id, libraryId: row.library_id };
      break;
    case 'approved':
      // Cargo manual (selfIds propios) o aprobación admin de una solicitud de
      // Seerr (selfIds + requestId: además de anular localmente, se rechaza
      // en Seerr para que de verdad se cancele la descarga).
      for (const id of data.selfIds || []) markVoided.run(id);
      if (data.requestId) await declineRequest(data.requestId);
      result = { kind: 'user', userId: row.user_id, libraryId: row.library_id };
      break;
    case 'declined':
      for (const id of data.voidedIds || []) clearVoided.run(id);
      if (data.requestId) await approveRequest(data.requestId);
      result = { kind: 'user', userId: row.user_id, libraryId: row.library_id };
      break;
    case 'held':
      if (data.requestId != null) clearRequestHold(data.requestId);
      result = { kind: 'user', userId: row.user_id, libraryId: row.library_id };
      break;
    case 'hold_cleared':
      if (data.requestId != null && data.holdUntil != null) restoreRequestHold(data.requestId, data.holdUntil);
      result = { kind: 'user', userId: row.user_id, libraryId: row.library_id };
      break;
    case 'override_changed':
      restoreOverride(data.userId, data.libraryId, data.previous);
      result = { kind: 'user', userId: data.userId, libraryId: data.libraryId };
      break;
    case 'group_override_changed':
      restoreGroupOverride(data.groupId, data.libraryId, data.previous);
      result = { kind: 'group', groupId: data.groupId, libraryId: data.libraryId };
      break;
    case 'role_override_changed':
      restoreRoleOverride(data.roleId, data.libraryId, data.previous);
      result = { kind: 'role', roleId: data.roleId, libraryId: data.libraryId };
      break;
    case 'monthly_total_override_changed':
      restoreMonthlyTotalOverride(data.userId, data.previous);
      result = { kind: 'user', userId: data.userId, libraryId: null };
      break;
    case 'group_monthly_total_override_changed':
      restoreGroupMonthlyTotalOverride(data.groupId, data.previous);
      result = { kind: 'group', groupId: data.groupId, libraryId: null };
      break;
    case 'role_monthly_total_override_changed':
      restoreRoleMonthlyTotalOverride(data.roleId, data.previous);
      result = { kind: 'role', roleId: data.roleId, libraryId: null };
      break;
    default:
      return null;
  }
  markUndone.run(logId);
  return result;
}

// Una solicitud aprobada y aún sin descargar debe seguir apareciendo en el cupo
// sin límite de tiempo. Solo se anula automáticamente cuando Seerr confirma que
// la solicitud ya no existe; los estados pending/available/unknown se conservan.
export function shouldVoidApprovedRequest(status) {
  return status === 'gone';
}

export async function reconcileVoidedRequests() {
  const rows = getUnvoidedApproved.all();

  for (const row of rows) {
    const status = await getRequestStatus(row.request_id);
    if (shouldVoidApprovedRequest(status)) markVoided.run(row.id);
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

const getUnresolvedApproved = db.prepare(`
  SELECT id, request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, poster_url
  FROM decisions_log
  WHERE decision = 'approved' AND voided_at IS NULL AND user_id IS NOT NULL AND library_id IS NOT NULL
`);
// Si ya hay un 'watched'/'expired' para esa unidad (evento real del scheduler
// desde el 21 jul 2026, o de una pasada anterior de este mismo backfill), no
// se vuelve a loguear — idempotente igual que requestUnitAlreadyLogged.
const hasWatchedOrExpired = db.prepare(`
  SELECT 1 FROM decisions_log
  WHERE request_id = ? AND media_type = ? AND COALESCE(season_number, -1) = COALESCE(?, -1)
    AND decision IN ('watched', 'expired')
  LIMIT 1
`);
const insertBackfilledWatched = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, poster_url, decision, created_at)
  VALUES
    (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, @posterUrl, 'watched', @createdAt)
`);

// Reconstruye en el Registro, con la fecha real de Tautulli, lo que ya se vio
// ANTES de que el scheduler empezara a loguear 'watched'/'expired' (21 jul
// 2026, adc28de) — y también lo que importSeerrHistory trae de aprobaciones
// viejas de Seerr que ya estaban vistas antes de instalar limitARR. Pedido
// expreso de Edu: solo 'watched', no 'expired' (eso no se puede saber a
// ciencia cierta a toro pasado, así que no se inventa). Idempotente: se puede
// re-ejecutar sin duplicar.
export async function backfillWatchedHistory() {
  const groups = new Map();
  for (const row of getUnresolvedApproved.all()) {
    if (hasWatchedOrExpired.get(row.request_id, row.media_type, row.season_number ?? null)) continue;
    const key = `${row.user_id}:${row.library_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let backfilled = 0;
  const showDetailsCache = new Map();
  const seasonEpisodesCache = new Map();

  for (const [key, groupRows] of groups) {
    const [userId, libraryId] = key.split(':').map(Number);

    const movieRows = groupRows.filter((r) => r.media_type !== 'tv');
    if (movieRows.length > 0) {
      const history = await getUserMovieHistory(userId, libraryId, 2000);
      // Primer visionado que cruzó el umbral, no el último (varias
      // reproducciones sueltas no cambian cuándo "se vio" de verdad).
      const firstWatchedByTitle = new Map();
      for (const h of history) {
        if (h.percent < WATCHED_THRESHOLD || h.date == null) continue;
        const titleKey = normalize(h.title);
        const prev = firstWatchedByTitle.get(titleKey);
        if (prev == null || h.date < prev) firstWatchedByTitle.set(titleKey, h.date);
      }
      for (const row of movieRows) {
        const date = firstWatchedByTitle.get(normalize(row.media_title));
        if (date == null) continue;
        insertBackfilledWatched.run({
          requestId: row.request_id,
          userId: row.user_id,
          username: row.username,
          libraryId: row.library_id,
          mediaTitle: row.media_title,
          mediaType: row.media_type,
          tmdbId: row.tmdb_id,
          seasonNumber: row.season_number,
          posterUrl: row.poster_url,
          createdAt: toSqliteDateTime(new Date(date).toISOString()),
        });
        backfilled += 1;
      }
    }

    const tvRows = groupRows.filter((r) => r.media_type === 'tv' && r.tmdb_id && r.season_number);
    if (tvRows.length > 0) {
      const history = await getUserEpisodeHistory(userId, libraryId, 5000);
      const watchedIndex = buildWatchedEpisodeIndex(history);
      const dateIndex = buildWatchedEpisodeDateIndex(history);
      const seasonWatchedPercent = getSeasonWatchedPercent();

      for (const row of tvRows) {
        const detailsCacheKey = `${row.tmdb_id}:${row.season_number}`;
        if (!showDetailsCache.has(detailsCacheKey)) {
          showDetailsCache.set(detailsCacheKey, await getMediaDetails('tv', row.tmdb_id, row.season_number));
        }
        const showRatingKey = showDetailsCache.get(detailsCacheKey)?.showRatingKey;
        const episodesCacheKey = `${showRatingKey || 'missing'}:${row.season_number}`;
        if (!seasonEpisodesCache.has(episodesCacheKey)) {
          seasonEpisodesCache.set(episodesCacheKey, await getSeasonEpisodes(showRatingKey, row.season_number));
        }
        const episodes = seasonEpisodesCache.get(episodesCacheKey);
        if (episodes.length === 0) continue;

        const seasonCtx = {
          showTitle: row.media_title.replace(/ - Temporada \d+$/, ''),
          showRatingKey,
          seasonNumber: row.season_number,
        };
        const state = seasonWatchState(watchedIndex, episodes, seasonCtx, seasonWatchedPercent);
        if (!state.complete) continue;
        const date = seasonCompletionDate(dateIndex, episodes, seasonCtx);
        if (date == null) continue;

        insertBackfilledWatched.run({
          requestId: row.request_id,
          userId: row.user_id,
          username: row.username,
          libraryId: row.library_id,
          mediaTitle: row.media_title,
          mediaType: row.media_type,
          tmdbId: row.tmdb_id,
          seasonNumber: row.season_number,
          posterUrl: row.poster_url,
          createdAt: toSqliteDateTime(new Date(date).toISOString()),
        });
        backfilled += 1;
      }
    }
  }

  return backfilled;
}

function formatMediaTitle(mediaType, title, seasonNumber = null) {
  if (mediaType !== 'tv') return title;
  if (!seasonNumber) return title;
  return `${title ?? 'Serie'} - Temporada ${seasonNumber}`;
}
