import { db } from '../db.js';
import { getRawSetting, setRawSetting } from '../settings.js';
import { getNotificationLog, notifyRecentlyAdded } from './tautulli.js';

const STARTED_AT_KEY = 'tautulli_notification_retry_started_at';
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_SECONDS = [5 * 60, 15 * 60, 60 * 60];

const getRetry = db.prepare(`
  SELECT * FROM tautulli_notification_retries
  WHERE rating_key = ? AND notifier_id = ?
`);
const insertRetry = db.prepare(`
  INSERT OR IGNORE INTO tautulli_notification_retries
    (rating_key, notifier_id, failed_log_id)
  VALUES (?, ?, ?)
`);
const resetRetry = db.prepare(`
  UPDATE tautulli_notification_retries
  SET failed_log_id = ?, attempts = 0, last_attempt_at = NULL, resolved_at = NULL
  WHERE rating_key = ? AND notifier_id = ?
`);
const markAttempt = db.prepare(`
  UPDATE tautulli_notification_retries
  SET attempts = attempts + 1, last_attempt_at = ?
  WHERE rating_key = ? AND notifier_id = ?
`);
const markResolved = db.prepare(`
  UPDATE tautulli_notification_retries SET resolved_at = ?
  WHERE rating_key = ? AND notifier_id = ? AND resolved_at IS NULL
`);

function eventKey(row) {
  return `${row.rating_key}:${row.notifier_id}`;
}

export async function retryFailedTautulliNotifications(now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  const configuredStart = Number(getRawSetting(STARTED_AT_KEY));
  if (!Number.isFinite(configuredStart) || configuredStart <= 0) {
    // No se recupera el histórico antiguo al estrenar la función: podría
    // inundar Telegram con avisos de semanas anteriores.
    setRawSetting(STARTED_AT_KEY, String(nowSeconds));
    return { initialized: true, retried: 0, resolved: 0 };
  }

  const rows = (await getNotificationLog(200))
    .filter((row) =>
      row.notify_action === 'on_created' &&
      String(row.agent_name).toLowerCase() === 'telegram' &&
      row.rating_key != null &&
      Number.isFinite(Number(row.notifier_id))
    )
    .sort((a, b) => Number(b.id) - Number(a.id));

  // Solo importa el resultado más reciente de cada contenido/notificador. Si
  // un reintento ya produjo success=1, el fallo anterior queda resuelto.
  const latestByEvent = new Map();
  for (const row of rows) {
    const key = eventKey(row);
    if (!latestByEvent.has(key)) latestByEvent.set(key, row);
  }

  let retried = 0;
  let resolved = 0;
  for (const row of latestByEvent.values()) {
    const ratingKey = String(row.rating_key);
    const notifierId = Number(row.notifier_id);
    const logId = Number(row.id);
    const timestamp = Number(row.timestamp);
    let state = getRetry.get(ratingKey, notifierId);

    if (Number(row.success) === 1) {
      if (state?.resolved_at == null) {
        const result = markResolved.run(nowSeconds, ratingKey, notifierId);
        resolved += result.changes;
        if (result.changes) console.info(`[tautulli-retry] aviso recuperado para rating_key ${ratingKey}`);
      }
      continue;
    }

    if (!Number.isFinite(timestamp) || timestamp < configuredStart) continue;

    if (!state) {
      insertRetry.run(ratingKey, notifierId, logId);
      state = getRetry.get(ratingKey, notifierId);
    } else if (state.resolved_at != null && logId > state.failed_log_id) {
      // El mismo contenido puede volver a añadirse en el futuro. Un fallo
      // posterior al que ya se resolvió inicia un ciclo de reintentos nuevo.
      resetRetry.run(logId, ratingKey, notifierId);
      state = getRetry.get(ratingKey, notifierId);
    }

    if (state.resolved_at != null || state.attempts >= MAX_ATTEMPTS) continue;
    const delay = RETRY_DELAYS_SECONDS[state.attempts];
    const reference = state.last_attempt_at ?? timestamp;
    if (nowSeconds - reference < delay) continue;

    console.info(
      `[tautulli-retry] reintentando aviso rating_key ${ratingKey} ` +
      `(intento ${state.attempts + 1}/${MAX_ATTEMPTS})`
    );
    await notifyRecentlyAdded(ratingKey, notifierId);
    markAttempt.run(nowSeconds, ratingKey, notifierId);
    retried += 1;
  }

  return { initialized: false, retried, resolved };
}
