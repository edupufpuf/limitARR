import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { getRawSetting, setRawSetting } from './settings.js';
import { listPendingRequests, approveRequest, declineRequest, getMediaDetails } from './services/seerr.js';
import { getUsers } from './services/tautulli.js';
import { getBalance, reconcileVoidedRequests, refreshQuotaCache, listStaleOutstandingPairs, normalize } from './quota.js';
import { sendMessage, getNotifyTarget, pendingButton, renderNoQuotaMessage } from './services/telegram.js';
import { matchByEmailOrUsername } from './userMatch.js';

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
const getCacheRow = db.prepare('SELECT outstanding, pending_items FROM quota_cache WHERE user_id = ? AND library_id = ?');
const getGroupName = db.prepare('SELECT name FROM groups WHERE id = ?');

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

  const target = getNotifyTarget();
  try {
    if (target.mode === 'group') {
      if (!target.groupChatId) return;
      const text = renderNoQuotaMessage(target.noQuotaMessage, {
        username: base.username,
        libraryName,
        mediaTitle: base.mediaTitle,
        unit,
      });
      await sendMessage(target.groupChatId, text, { messageThreadId: target.groupTopicId, replyMarkup });
    } else {
      const chatId = getChatId.get(base.userId)?.chat_id;
      if (!chatId) return;
      const text = renderNoQuotaMessage(target.noQuotaMessage, {
        username: base.username,
        libraryName,
        mediaTitle: base.mediaTitle,
        unit,
      });
      await sendMessage(chatId, text, { replyMarkup });
    }
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// Issue #13: aviso de rechazo por pedir varias temporadas de golpe, para que el
// usuario sepa qué hacer (pedir de una en una) en vez de ver la solicitud
// desaparecer en silencio.
async function notifyMultiSeasonDeclined(base, seasonsCount) {
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const text =
    `🚫 Solicitud rechazada: ${base.mediaTitle ?? 'una serie'} (${libraryName}) pedía ${seasonsCount} temporadas de golpe.\n` +
    `${base.username}: pide las temporadas de una en una.`;

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

// Aviso de aprobación: cierra el ciclo con el usuario (antes solo se le avisaba
// de lo malo, el "sin cupo"). `remaining` = saldo tras descontar esta solicitud.
async function notifyApproved(base, remaining) {
  const target = getNotifyTarget();
  if (!target.notifyApproved) return;
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const holes = remaining === 1 ? '1 hueco' : `${remaining} huecos`;

  try {
    if (target.mode === 'group') {
      if (!target.groupChatId) return;
      await sendMessage(
        target.groupChatId,
        `✅ Aprobada para ${base.username}: ${base.mediaTitle} (${libraryName}). Le quedan ${holes}.`,
        { messageThreadId: target.groupTopicId }
      );
    } else {
      const chatId = getChatId.get(base.userId)?.chat_id;
      if (!chatId) return;
      await sendMessage(chatId, `✅ Solicitud aprobada: ${base.mediaTitle} (${libraryName}). Te quedan ${holes}.`);
    }
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

// Clave estable de un pendiente para comparar caché vieja vs nueva.
function pendingItemKey(item) {
  if (item.tmdbId != null) return `${item.tmdbId}:${item.seasonNumber ?? ''}`;
  return `t:${normalize(item.title)}`;
}

// Aviso de cupo liberado: al refrescar los pares con pendientes (issue #5) se
// compara la caché de antes con la de después — lo que desaparece de la lista
// con el contador bajando es cupo liberado (visto, o cancelado en Seerr).
// Los avisos van tras el refresco para no retrasar la caché si Telegram cojea.
async function refreshStaleAndNotify(tautulliUsers) {
  const pairs = listStaleOutstandingPairs();
  const userMap = new Map(tautulliUsers.map((u) => [u.id, u]));

  for (const { user_id, library_id } of pairs) {
    const before = getCacheRow.get(user_id, library_id);
    const result = await refreshQuotaCache(user_id, library_id);

    const target = getNotifyTarget();
    if (!target.notifyFreed || !before || result.outstanding >= before.outstanding) continue;

    let oldItems = [];
    try {
      oldItems = JSON.parse(before.pending_items || '[]');
    } catch { /* caché de una versión anterior */ }
    const newKeys = new Set(result.pendingItems.map(pendingItemKey));
    const freedTitles = oldItems
      .filter((item) => !newKeys.has(pendingItemKey(item)))
      .map((item) => item.title)
      .filter(Boolean);
    if (freedTitles.length === 0) continue;

    const libraryName = getLibraryName.get(library_id)?.name ?? `biblioteca #${library_id}`;
    const list = freedTitles.map((t) => `• ${t}`).join('\n');
    const saldo = `Saldo en ${libraryName}: ${result.balance} de ${result.limit}.`;
    // user_id negativo = grupo agregado (issue #4): se nombra al grupo y, al no
    // tener DM propio, el aviso solo sale en modo grupo.
    const username = user_id < 0
      ? getGroupName.get(-user_id)?.name ?? `grupo#${-user_id}`
      : userMap.get(user_id)?.username ?? `user#${user_id}`;

    try {
      if (target.mode === 'group') {
        if (!target.groupChatId) continue;
        await sendMessage(
          target.groupChatId,
          `🎉 ${username} ha liberado cupo:\n${list}\n${saldo}`,
          { messageThreadId: target.groupTopicId }
        );
      } else {
        const chatId = getChatId.get(user_id)?.chat_id;
        if (!chatId) continue;
        await sendMessage(chatId, `🎉 Has liberado cupo:\n${list}\n${saldo}`);
      }
    } catch (err) {
      console.error('[scheduler] telegram notify failed:', err.message);
    }
  }
  return pairs.length;
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

    // Issue #13: temporada a temporada. Con el toggle activo en la biblioteca,
    // una solicitud con varias temporadas se rechaza entera y con aviso —
    // Seerr no permite aprobar una solicitud a medias.
    if (library.one_season_per_request && request.mediaType === 'tv' && requestedSeasons.length > 1) {
      const details = await getMediaDetails(request.mediaType, request.tmdbId, requestedSeasons[0]);
      base.mediaTitle = details.title;
      base.posterUrl = details.posterUrl;
      base.seasonNumber = null; // la decisión aplica a la solicitud entera
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

    const { limit, balance } = await getBalance(tautulliUser.id, library.id);
    const requiredUnits = request.mediaType === 'tv' ? requestedSeasons.length : 1;
    const decision = balance >= requiredUnits ? 'approved' : 'no_quota';

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
    if (decision === 'approved' && isNew) {
      await notifyApproved(base, Math.max(0, balance - requiredUnits));
    }

    // Recalcula la caché de verdad (con la aprobación recién logueada incluida)
    // en vez de ajustar el contador a mano — así pending_items queda al día y
    // el panel enseña la película nueva sin esperar al siguiente sondeo.
    await refreshQuotaCache(tautulliUser.id, library.id);
  }

  // Issue #5: detectar visionados sin esperar a un "recalcular todo" manual —
  // los pares recién refrescados arriba quedan excluidos por su computed_at.
  // Además avisa por Telegram del cupo liberado (si está activado).
  await refreshStaleAndNotify(tautulliUsers);
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
