import { db } from './db.js';
import { getBalance, refreshQuotaCache } from './quota.js';
import { getMediaDetails, getMovieAvailability } from './services/seerr.js';
import { getRadarrWaitState, searchRadarrMovie, setRadarrMovieMonitored } from './services/radarr.js';
import { getSonarrWaitState, searchSonarrSeason, setSonarrSeasonMonitored } from './services/sonarr.js';

const RETRY_HOURS = 6;
const QUOTA_RECHECK_MINUTES = 5;
const ACTIVATION_TIMEOUT_MINUTES = 20;

const insertWaiting = db.prepare(`
  INSERT INTO download_waitlist
    (request_id, user_id, username, library_id, media_type, tmdb_id, season_number, external_service_id)
  VALUES
    (@requestId, @userId, @username, @libraryId, @mediaType, @tmdbId, @seasonNumber, @externalServiceId)
  ON CONFLICT(request_id, media_type, season_number) DO UPDATE SET
    user_id=excluded.user_id,
    username=excluded.username,
    library_id=excluded.library_id,
    tmdb_id=excluded.tmdb_id,
    external_service_id=COALESCE(excluded.external_service_id, download_waitlist.external_service_id)
`);
const listRows = db.prepare(`
  SELECT * FROM download_waitlist
  ORDER BY datetime(created_at), id
`);
const deleteRow = db.prepare('DELETE FROM download_waitlist WHERE id = ?');
const setExternalId = db.prepare('UPDATE download_waitlist SET external_service_id = ? WHERE id = ?');
const setActivated = db.prepare(`
  UPDATE download_waitlist
  SET state='activated', release_ready=1, activated_at=datetime('now'), next_check_at=NULL
  WHERE id=? AND state='waiting'
`);
const setWaiting = db.prepare(`
  UPDATE download_waitlist
  SET state='waiting', release_ready=0, activated_at=NULL, next_check_at=datetime('now', '+' || ? || ' hours')
  WHERE id=?
`);
const postpone = db.prepare(`
  UPDATE download_waitlist
  SET next_check_at=datetime('now', '+' || ? || ' hours')
  WHERE id=?
`);
const postponeMinutes = db.prepare(`
  UPDATE download_waitlist
  SET next_check_at=datetime('now', '+' || ? || ' minutes')
  WHERE id=?
`);
const setReleaseReady = db.prepare('UPDATE download_waitlist SET release_ready=? WHERE id=?');
const pruneOrphans = db.prepare(`
  DELETE FROM download_waitlist
  WHERE NOT EXISTS (
    SELECT 1 FROM decisions_log dl
    WHERE dl.request_id=download_waitlist.request_id
      AND dl.media_type=download_waitlist.media_type
      AND COALESCE(dl.season_number,-1)=download_waitlist.season_number
      AND dl.decision='approved' AND dl.voided_at IS NULL
  )
`);

function isDue(row) {
  return !row.next_check_at || Date.parse(`${row.next_check_at}Z`) <= Date.now();
}

function activationExpired(row) {
  if (!row.activated_at) return true;
  return Date.now() - Date.parse(`${row.activated_at}Z`) >= ACTIVATION_TIMEOUT_MINUTES * 60_000;
}

async function stateFor(row) {
  if (row.media_type === 'movie') return getRadarrWaitState(row.tmdb_id);
  return getSonarrWaitState(row.external_service_id, row.season_number);
}

async function hold(row) {
  if (row.media_type === 'movie') {
    const externalId = await setRadarrMovieMonitored(row.tmdb_id, false);
    if (externalId != null) setExternalId.run(externalId, row.id);
    return externalId;
  }
  return setSonarrSeasonMonitored(row.external_service_id, row.season_number, false);
}

async function activate(row) {
  if (row.media_type === 'movie') return searchRadarrMovie(row.tmdb_id);
  return searchSonarrSeason(row.external_service_id, row.season_number);
}

// Se llama justo despues de aprobar en Seerr. La solicitud queda aceptada,
// pero Radarr/Sonarr no conserva permiso para descargarla en el futuro por su
// cuenta. Si ya hay una release, processDownloadWaitlist la activara solo tras
// reservar un hueco.
export async function enqueueApprovedDownload(base, details = {}) {
  if (base.tmdbId == null || base.userId == null || base.libraryId == null) return;
  insertWaiting.run({
    requestId: base.requestId,
    userId: base.userId,
    username: base.username ?? null,
    libraryId: base.libraryId,
    mediaType: base.mediaType,
    tmdbId: base.tmdbId,
    seasonNumber: base.seasonNumber ?? -1,
    externalServiceId: details.externalServiceId ?? null,
  });
  const row = db.prepare(`
    SELECT * FROM download_waitlist
    WHERE request_id=? AND media_type=? AND season_number=?
  `).get(base.requestId, base.mediaType, base.seasonNumber ?? -1);
  try {
    await hold(row);
  } catch (err) {
    console.error('[waitlist] no se pudo pausar la descarga recien aprobada:', err.message);
  }
}

// Incorpora solicitudes antiguas aprobadas y aun no descargadas. Es idempotente
// y permite desplegar la correccion sin cancelar ni volver a crear peticiones.
export async function reconcileApprovedWaitlist() {
  pruneOrphans.run();
  const rows = db.prepare(`
    SELECT dl.request_id,dl.user_id,dl.username,dl.library_id,dl.media_type,dl.tmdb_id,dl.season_number
    FROM decisions_log dl
    JOIN libraries l ON l.id=dl.library_id AND l.enabled=1
    WHERE dl.decision='approved' AND dl.voided_at IS NULL
      AND dl.user_id IS NOT NULL AND dl.tmdb_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM download_waitlist w
        WHERE w.request_id=dl.request_id AND w.media_type=dl.media_type
          AND COALESCE(w.season_number,-1)=COALESCE(dl.season_number,-1)
      )
      AND NOT EXISTS (
        SELECT 1 FROM decisions_log watched
        WHERE watched.request_id=dl.request_id AND watched.media_type=dl.media_type
          AND COALESCE(watched.season_number,-1)=COALESCE(dl.season_number,-1)
          AND watched.decision='watched'
      )
  `).all();
  for (const row of rows) {
    const details = await getMediaDetails(row.media_type, row.tmdb_id, row.season_number);
    const waitState = row.media_type === 'movie'
      ? await getRadarrWaitState(row.tmdb_id)
      : await getSonarrWaitState(details.externalServiceId, row.season_number);
    const unavailable = row.media_type === 'movie'
      ? !waitState.downloaded
      : (details.seasonStatuses?.[row.season_number] ?? 0) < 4;
    if (!unavailable) continue;
    await enqueueApprovedDownload({
      requestId: row.request_id,
      userId: row.user_id,
      username: row.username,
      libraryId: row.library_id,
      mediaType: row.media_type,
      tmdbId: row.tmdb_id,
      seasonNumber: row.season_number,
    }, details);
    if (waitState.downloading) {
      const inserted = db.prepare(`
        SELECT id FROM download_waitlist
        WHERE request_id=? AND media_type=? AND season_number=?
      `).get(row.request_id, row.media_type, row.season_number ?? -1);
      if (inserted) setActivated.run(inserted.id);
    }
  }
}

export async function processDownloadWaitlist() {
  const rows = listRows.all();

  // Primero resuelve descargas terminadas y busquedas que no encontraron nada.
  for (const row of rows) {
    let state;
    try {
      state = await stateFor(row);
    } catch (err) {
      console.error('[waitlist] no se pudo consultar el estado:', err.message);
      continue;
    }
    if (state.externalServiceId != null && state.externalServiceId !== row.external_service_id) {
      setExternalId.run(state.externalServiceId, row.id);
      row.external_service_id = state.externalServiceId;
    }
    if (state.downloaded) {
      let visibleInPlex;
      if (row.media_type === 'movie') {
        const availability = (await getMovieAvailability([row.tmdb_id])).get(row.tmdb_id);
        visibleInPlex = Number(availability?.status ?? 0) >= 4;
      } else {
        const details = await getMediaDetails('tv', row.tmdb_id, row.season_number);
        visibleInPlex = Number(details.seasonStatuses?.[row.season_number] ?? 0) >= 4;
      }
      // Radarr/Sonarr puede haber importado el archivo unos minutos antes de
      // que Seerr/Plex lo vea. Hasta entonces se conserva la reserva para no
      // activar otro contenido y acabar sobrepasando el limite por ese desfase.
      if (!visibleInPlex) continue;
      deleteRow.run(row.id);
      await refreshQuotaCache(row.user_id, row.library_id);
      continue;
    }
    if (row.state === 'activated' && !state.downloading && activationExpired(row)) {
      try { await hold(row); } catch (err) { console.error('[waitlist] no se pudo volver a pausar:', err.message); }
      setWaiting.run(RETRY_HOURS, row.id);
      row.state = 'waiting';
    }
  }

  // Las activaciones ya iniciadas reservan hueco aunque el archivo todavia no
  // este en Plex. Sin esta reserva, dos ciclos simultaneos podrian excederlo.
  const liveRows = listRows.all();
  const reserved = new Map();
  for (const row of liveRows.filter((item) => item.state === 'activated')) {
    const key = `${row.user_id}:${row.library_id}`;
    reserved.set(key, (reserved.get(key) || 0) + 1);
  }

  for (const row of liveRows.filter((item) => item.state === 'waiting' && isDue(item))) {
    const key = `${row.user_id}:${row.library_id}`;
    let state;
    try {
      state = await stateFor(row);
    } catch (err) {
      console.error('[waitlist] no se pudo buscar releases:', err.message);
      continue;
    }
    if (!state.releaseAvailable) {
      setReleaseReady.run(0, row.id);
      postpone.run(RETRY_HOURS, row.id);
      continue;
    }
    setReleaseReady.run(1, row.id);

    const quota = await getBalance(row.user_id, row.library_id);
    if (quota.balance - (reserved.get(key) || 0) <= 0) {
      postponeMinutes.run(QUOTA_RECHECK_MINUTES, row.id);
      continue;
    }

    // Reserva en SQLite antes de tocar Radarr/Sonarr.
    if (setActivated.run(row.id).changes !== 1) continue;
    reserved.set(key, (reserved.get(key) || 0) + 1);
    try {
      const externalId = await activate({ ...row, external_service_id: state.externalServiceId ?? row.external_service_id });
      if (externalId != null) setExternalId.run(externalId, row.id);
    } catch (err) {
      reserved.set(key, Math.max(0, (reserved.get(key) || 1) - 1));
      setWaiting.run(RETRY_HOURS, row.id);
      console.error('[waitlist] no se pudo activar la descarga:', err.message);
    }
  }
}
