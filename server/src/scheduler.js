import { db } from './db.js';
import { config } from './config.js';
import { listPendingMovieRequests, approveRequest, getMovieDetails } from './services/seerr.js';
import { getUsers } from './services/tautulli.js';
import { getBalance, reconcileVoidedRequests, refreshQuotaCache } from './quota.js';
import { sendMessage, getNotifyTarget, pendingButton } from './services/telegram.js';
import { matchByEmailOrUsername } from './userMatch.js';

const insertLog = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, tmdb_id, poster_url, balance_before, limit_applied, decision)
  VALUES
    (@requestId, @userId, @username, @libraryId, @mediaTitle, @tmdbId, @posterUrl, @balanceBefore, @limitApplied, @decision)
`);
const getLibraryByKind = db.prepare(`SELECT * FROM libraries WHERE kind = ? AND enabled = 1 LIMIT 1`);
const getLastDecision = db.prepare(`
  SELECT decision FROM decisions_log WHERE request_id = ? ORDER BY id DESC LIMIT 1
`);
const getLibraryName = db.prepare('SELECT name FROM libraries WHERE id = ?');
const getChatId = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?');

// Avoids re-logging (and re-notifying) the same still-pending request every poll
// cycle when nothing about its situation has changed since the last time.
function logIfChanged(base, decision) {
  const last = getLastDecision.get(base.requestId)?.decision;
  if (last === decision) return false;
  insertLog.run({ ...base, decision });
  return true;
}

async function notifyNoQuota(base) {
  const libraryName = getLibraryName.get(base.libraryId)?.name ?? `biblioteca #${base.libraryId}`;
  const replyMarkup = pendingButton(base.userId, base.libraryId);

  const target = getNotifyTarget();
  try {
    if (target.mode === 'group') {
      if (!target.groupChatId) return;
      const text = `🔴 ${base.username} se ha pasado del cupo en ${libraryName} pidiendo "${base.mediaTitle ?? 'una película'}".`;
      await sendMessage(target.groupChatId, text, { messageThreadId: target.groupTopicId, replyMarkup });
    } else {
      const chatId = getChatId.get(base.userId)?.chat_id;
      if (!chatId) return;
      const text =
        `🔴 TE HAS PASADO DEL CUPO en ${libraryName} pidiendo "${base.mediaTitle ?? 'una película'}".\n` +
        `Ve alguna película antes de solicitar más.`;
      await sendMessage(chatId, text, { replyMarkup });
    }
  } catch (err) {
    console.error('[scheduler] telegram notify failed:', err.message);
  }
}

export async function runPollCycle() {
  await reconcileVoidedRequests();

  const [pending, tautulliUsers] = await Promise.all([
    listPendingMovieRequests(),
    getUsers(),
  ]);

  for (const request of pending) {
    const library = getLibraryByKind.get(request.is4k ? '4k' : 'standard');
    const tautulliUser = matchByEmailOrUsername(tautulliUsers, request.requestedBy || {});

    const base = {
      requestId: request.id,
      userId: tautulliUser?.id ?? null,
      username: tautulliUser?.username ?? request.requestedBy?.username ?? 'unknown',
      libraryId: library?.id ?? null,
      mediaTitle: null,
      tmdbId: request.tmdbId ?? null,
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

    const details = await getMovieDetails(request.tmdbId);
    base.mediaTitle = details.title;
    base.posterUrl = details.posterUrl;

    const { limit, balance } = await getBalance(tautulliUser.id, library.id);
    const decision = balance >= 1 ? 'approved' : 'no_quota';

    if (decision === 'approved') {
      await approveRequest(request.id);
    }

    base.balanceBefore = balance;
    base.limitApplied = limit;
    const isNew = logIfChanged(base, decision);
    if (decision === 'no_quota' && isNew) await notifyNoQuota(base);

    // Recalcula la caché de verdad (con la aprobación recién logueada incluida)
    // en vez de ajustar el contador a mano — así pending_items queda al día y
    // el panel enseña la película nueva sin esperar al siguiente sondeo.
    await refreshQuotaCache(tautulliUser.id, library.id);
  }
}

export function startScheduler() {
  runPollCycle().catch((err) => console.error('[scheduler] initial cycle failed:', err));
  setInterval(() => {
    runPollCycle().catch((err) => console.error('[scheduler] cycle failed:', err));
  }, config.pollIntervalMs);
}
