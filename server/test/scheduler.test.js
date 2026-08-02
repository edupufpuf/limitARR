import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { notifyStillUnavailable, enforceSingleSession } from '../src/scheduler.js';
import { setSessionGuardEnabled } from '../src/sessionGuard.js';

// Pedido de Edu (2 ago 2026): si a las 12h de aprobarse sigue sin estar en
// Plex, avisar una vez de que aún no está disponible. Idempotente: no debe
// repetirse en ciclos siguientes, ni dispararse para algo ya disponible.

function upsertSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

test('notifyStillUnavailable: avisa una sola vez si sigue sin descargar a las 12h', async () => {
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  upsertSetting('telegram_bot_token', 'test-bot-token');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (9700, 'Películas', 'movie', 'standard', 1, 4)
  `).run();
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, decision, created_at)
    VALUES (9801, 9800, 'jesus', 9700, 'Todavía sin bajar', 'movie', 555001, 'approved', datetime('now', '-13 hours'))
  `).run();
  db.prepare(`
    INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (9800, 'chat-9800', datetime('now'))
  `).run();

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/555001') {
      return new Response(JSON.stringify({ mediaInfo: { status: 2 } }), { status: 200 }); // 2 = pedida, no disponible
    }
    if (url.includes('api.telegram.org')) {
      sentMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    await notifyStillUnavailable();
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].chat_id, 'chat-9800');
    assert.match(sentMessages[0].text, /Todavía sin bajar/);
    assert.match(sentMessages[0].text, /sigue sin estar disponible/);

    const logged = db.prepare(
      "SELECT * FROM decisions_log WHERE request_id = 9801 AND decision = 'unavailable_reminder'"
    ).get();
    assert.ok(logged, 'debe quedar logueado en Registro');

    // Un segundo ciclo no debe repetir el aviso (idempotente).
    await notifyStillUnavailable();
    assert.equal(sentMessages.length, 1);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE request_id = 9801').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 9800').run();
    db.prepare('DELETE FROM libraries WHERE id = 9700').run();
    db.prepare("DELETE FROM settings WHERE key IN ('seerr_url', 'seerr_api_key', 'telegram_bot_token')").run();
  }
});

test('notifyStillUnavailable: no avisa si ya está disponible en Plex', async () => {
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  upsertSetting('telegram_bot_token', 'test-bot-token');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (9701, 'Películas', 'movie', 'standard', 1, 4)
  `).run();
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, decision, created_at)
    VALUES (9802, 9801, 'jesus', 9701, 'Ya disponible', 'movie', 555002, 'approved', datetime('now', '-13 hours'))
  `).run();
  db.prepare(`
    INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (9801, 'chat-9801', datetime('now'))
  `).run();

  const sentMessages = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url === 'http://seerr.test/api/v1/movie/555002') {
      return new Response(JSON.stringify({ mediaInfo: { status: 5 } }), { status: 200 }); // 5 = disponible
    }
    if (url.includes('api.telegram.org')) {
      sentMessages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    await notifyStillUnavailable();
    assert.equal(sentMessages.length, 0);
    const logged = db.prepare(
      "SELECT * FROM decisions_log WHERE request_id = 9802 AND decision = 'unavailable_reminder'"
    ).get();
    assert.equal(logged, undefined);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE request_id = 9802').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 9801').run();
    db.prepare('DELETE FROM libraries WHERE id = 9701').run();
    db.prepare("DELETE FROM settings WHERE key IN ('seerr_url', 'seerr_api_key', 'telegram_bot_token')").run();
  }
});

// Pedido de Edu (2 ago 2026): mismo usuario con 2 sesiones de Plex a la vez —
// se corta la más nueva, se deja la que ya estaba viendo desde antes.

function mockActivity({ tautulliUsers, sessions }) {
  return async (input) => {
    const url = String(input);
    if (url.includes('cmd=get_users')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: tautulliUsers } }), { status: 200 });
    }
    if (url.includes('cmd=get_activity')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { sessions } } }), { status: 200 });
    }
    if (url.includes('cmd=terminate_session')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: {} } }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

test('enforceSingleSession: corta la sesión más nueva, deja la más vieja', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    return mockActivity({
      tautulliUsers: [{ user_id: 900, username: 'jesus', is_admin: '0' }],
      sessions: [
        { session_key: 'old', user_id: 900, username: 'jesus', full_title: 'A', started: '1000' },
        { session_key: 'new', user_id: 900, username: 'jesus', full_title: 'B', started: '2000' },
      ],
    })(input);
  };

  try {
    await enforceSingleSession();
    assert.deepEqual(calls, ['new']);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
});

test('enforceSingleSession: a un admin nunca se le corta nada', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');

  const calls = [];
  const originalFetch = global.fetch;
  const mock = mockActivity({
    tautulliUsers: [{ user_id: 901, username: 'edu', is_admin: '1' }],
    sessions: [
      { session_key: 'old', user_id: 901, username: 'edu', full_title: 'A', started: '1000' },
      { session_key: 'new', user_id: 901, username: 'edu', full_title: 'B', started: '2000' },
    ],
  });
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    return mock(input);
  };

  try {
    await enforceSingleSession();
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
});

test('enforceSingleSession: no corta si el usuario lo desactivó en su panel', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  setSessionGuardEnabled(902, false);

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    const mock = mockActivity({
      tautulliUsers: [{ user_id: 902, username: 'seve', is_admin: '0' }],
      sessions: [
        { session_key: 'old', user_id: 902, username: 'seve', full_title: 'A', started: '1000' },
        { session_key: 'new', user_id: 902, username: 'seve', full_title: 'B', started: '2000' },
      ],
    });
    return mock(input);
  };

  try {
    await enforceSingleSession();
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM session_guard_settings WHERE user_id = 902').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
});
