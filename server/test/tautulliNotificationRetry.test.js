import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { setRawSetting } from '../src/settings.js';
import { retryFailedTautulliNotifications } from '../src/services/tautulliNotificationRetry.js';

function tautulliResponse(data) {
  return new Response(JSON.stringify({ response: { result: 'success', data } }), { status: 200 });
}

test('recupera un aviso fallido sin duplicarlo y se detiene al confirmar el éxito', async () => {
  const now = 2_000_000_000_000;
  const nowSeconds = Math.floor(now / 1000);
  setRawSetting('tautulli_url', 'http://tautulli.test');
  setRawSetting('tautulli_api_key', 'test-key');
  setRawSetting('tautulli_notification_retry_started_at', String(nowSeconds - 3600));
  db.prepare('DELETE FROM tautulli_notification_retries').run();

  let logRows = [{
    id: 500,
    timestamp: nowSeconds - 301,
    rating_key: 10184,
    notifier_id: 2,
    agent_name: 'telegram',
    notify_action: 'on_created',
    success: 0,
  }];
  const posts = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const cmd = url.searchParams.get('cmd');
    if (cmd === 'get_notification_log') return tautulliResponse({ data: logRows });
    if (cmd === 'notify_recently_added') {
      posts.push({
        method: options.method,
        ratingKey: url.searchParams.get('rating_key'),
        notifierId: url.searchParams.get('notifier_id'),
      });
      return tautulliResponse({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const first = await retryFailedTautulliNotifications(now);
    assert.equal(first.retried, 1);
    assert.deepEqual(posts, [{ method: 'POST', ratingKey: '10184', notifierId: '2' }]);

    // El segundo ciclo inmediato no repite el mismo envío.
    const second = await retryFailedTautulliNotifications(now + 60_000);
    assert.equal(second.retried, 0);
    assert.equal(posts.length, 1);

    logRows = [{ ...logRows[0], id: 501, timestamp: nowSeconds + 90, success: 1 }];
    const third = await retryFailedTautulliNotifications(now + 120_000);
    assert.equal(third.resolved, 1);
    assert.equal(posts.length, 1);
    assert.ok(db.prepare(`
      SELECT resolved_at FROM tautulli_notification_retries
      WHERE rating_key = '10184' AND notifier_id = 2
    `).get().resolved_at);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM tautulli_notification_retries').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'tautulli_notification_retry_started_at')").run();
  }
});
