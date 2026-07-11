import { db } from './db.js';
import { config } from './config.js';
import { listPendingRequests, approveRequest, getMediaDetails } from './services/seerr.js';
import { getUsers } from './services/tautulli.js';
import { getBalance, reconcileVoidedRequests, refreshQuotaCache } from './quota.js';
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

export async function runPollCycle() {
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

    // Recalcula la caché de verdad (con la aprobación recién logueada incluida)
    // en vez de ajustar el contador a mano — así pending_items queda al día y
    // el panel enseña la película nueva sin esperar al siguiente sondeo.
    await refreshQuotaCache(tautulliUser.id, library.id);
  }
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
