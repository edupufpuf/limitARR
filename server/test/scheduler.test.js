import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { notifyStillUnavailable, enforceSingleSession, enforceBroadcast, notifyBypassedApprovals, runPollCycle, processSeasonQueue } from '../src/scheduler.js';
import { setSessionGuardEnabled } from '../src/sessionGuard.js';
import { setBroadcastSettings } from '../src/services/broadcast.js';

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
        { session_key: 'old', user_id: 900, username: 'jesus', full_title: 'A', started: '1000', machine_id: 'tv-salon' },
        { session_key: 'new', user_id: 900, username: 'jesus', full_title: 'B', started: '2000', machine_id: 'movil' },
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

test('enforceSingleSession: no corta dos registros del mismo dispositivo', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    return mockActivity({
      tautulliUsers: [{ user_id: 903, username: 'pikohendrix', is_admin: '0' }],
      sessions: [
        { session_key: 'first', user_id: 903, username: 'pikohendrix', full_title: 'A', started: '1000', machine_id: 'same-device' },
        { session_key: 'overlap', user_id: 903, username: 'pikohendrix', full_title: 'B', started: '2000', machine_id: 'same-device' },
      ],
    })(input);
  };

  try {
    await enforceSingleSession();
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  }
});

test('enforceSingleSession: no corta si Tautulli no permite identificar el dispositivo', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    return mockActivity({
      tautulliUsers: [{ user_id: 904, username: 'unknown-device', is_admin: '0' }],
      sessions: [
        { session_key: 'first', user_id: 904, username: 'unknown-device', full_title: 'A', started: '1000' },
        { session_key: 'second', user_id: 904, username: 'unknown-device', full_title: 'B', started: '2000' },
      ],
    })(input);
  };

  try {
    await enforceSingleSession();
    assert.deepEqual(calls, []);
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

// Pedido de Edu (10 ago 2026): empujar a vincular Telegram con un pop-up en
// Plex (terminate_session con mensaje) — solo a quien no está vinculado, solo
// una vez, nunca al admin.

test('enforceBroadcast: corta a quien no tiene Telegram vinculado, con el mensaje configurado', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  setBroadcastSettings({ enabled: true, message: 'Vincula tu Telegram en cupo.eduflix.win' });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) {
      calls.push({ sessionKey: new URL(url).searchParams.get('session_key'), message: new URL(url).searchParams.get('message') });
    }
    const mock = mockActivity({
      tautulliUsers: [{ user_id: 910, username: 'sin_vincular', is_admin: '0' }],
      sessions: [{ session_key: 'sess-910', user_id: 910, username: 'sin_vincular', full_title: 'A', started: '1000' }],
    });
    return mock(input);
  };

  try {
    await enforceBroadcast();
    assert.deepEqual(calls, [{ sessionKey: 'sess-910', message: 'Vincula tu Telegram en cupo.eduflix.win' }]);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM broadcast_seen WHERE user_id = 910').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'broadcast_enabled', 'broadcast_message')").run();
  }
});

test('enforceBroadcast: no corta a quien ya tiene Telegram vinculado', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  setBroadcastSettings({ enabled: true, message: 'Vincula tu Telegram' });
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (911, 'chat-911', datetime('now'))").run();

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    const mock = mockActivity({
      tautulliUsers: [{ user_id: 911, username: 'ya_vinculado', is_admin: '0' }],
      sessions: [{ session_key: 'sess-911', user_id: 911, username: 'ya_vinculado', full_title: 'A', started: '1000' }],
    });
    return mock(input);
  };

  try {
    await enforceBroadcast();
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM telegram_links WHERE user_id = 911').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'broadcast_enabled', 'broadcast_message')").run();
  }
});

test('enforceBroadcast: a un admin nunca se le corta nada', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  setBroadcastSettings({ enabled: true, message: 'Vincula tu Telegram' });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    const mock = mockActivity({
      tautulliUsers: [{ user_id: 912, username: 'edu', is_admin: '1' }],
      sessions: [{ session_key: 'sess-912', user_id: 912, username: 'edu', full_title: 'A', started: '1000' }],
    });
    return mock(input);
  };

  try {
    await enforceBroadcast();
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'broadcast_enabled', 'broadcast_message')").run();
  }
});

test('enforceBroadcast: solo corta una vez por usuario mientras el mensaje no cambie', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  setBroadcastSettings({ enabled: true, message: 'Vincula tu Telegram' });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    const mock = mockActivity({
      tautulliUsers: [{ user_id: 913, username: 'sin_vincular', is_admin: '0' }],
      sessions: [{ session_key: 'sess-913', user_id: 913, username: 'sin_vincular', full_title: 'A', started: '1000' }],
    });
    return mock(input);
  };

  try {
    await enforceBroadcast();
    await enforceBroadcast();
    assert.deepEqual(calls, ['sess-913']);

    // Cambiar el texto lo cuenta como aviso nuevo: vuelve a cortarle.
    setBroadcastSettings({ enabled: true, message: 'Nuevo texto' });
    await enforceBroadcast();
    assert.deepEqual(calls, ['sess-913', 'sess-913']);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM broadcast_seen WHERE user_id = 913').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'broadcast_enabled', 'broadcast_message')").run();
  }
});

test('enforceBroadcast: desactivado no corta a nadie', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  setBroadcastSettings({ enabled: false, message: 'Vincula tu Telegram' });

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('cmd=terminate_session')) calls.push(new URL(url).searchParams.get('session_key'));
    const mock = mockActivity({
      tautulliUsers: [{ user_id: 914, username: 'sin_vincular', is_admin: '0' }],
      sessions: [{ session_key: 'sess-914', user_id: 914, username: 'sin_vincular', full_title: 'A', started: '1000' }],
    });
    return mock(input);
  };

  try {
    await enforceBroadcast();
    assert.deepEqual(calls, []);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'broadcast_enabled', 'broadcast_message')").run();
  }
});

// Caso Edu (3 ago 2026): admin de Seerr se autoaprueba al instante, sin pasar
// por la cola de pendientes — limitARR nunca lo procesa, así que ni cupo ni
// aviso. Aviso informativo aparte, detectado por "sin ninguna fila en
// decisions_log para este request_id".

function mockBypassed({ tautulliUsers, movieRequests = [], tvRequests = [], movieDetails = {} }) {
  return async (input, options) => {
    const url = String(input);
    if (url.includes('cmd=get_users')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: tautulliUsers } }), { status: 200 });
    }
    if (url.includes('/api/v1/request?filter=approved') && url.includes('mediaType=movie')) {
      return new Response(JSON.stringify({ results: movieRequests }), { status: 200 });
    }
    if (url.includes('/api/v1/request?filter=approved') && url.includes('mediaType=tv')) {
      return new Response(JSON.stringify({ results: tvRequests }), { status: 200 });
    }
    const movieMatch = url.match(/\/api\/v1\/movie\/(\d+)$/);
    if (movieMatch) {
      return new Response(JSON.stringify(movieDetails[movieMatch[1]] ?? { title: 'Desconocida' }), { status: 200 });
    }
    if (url.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url} ${options?.method || 'GET'}`);
  };
}

test('notifyBypassedApprovals: avisa (una vez) de lo aprobado fuera de limitARR', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  upsertSetting('telegram_bot_token', 'test-bot-token');
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (950, 'chat-950', datetime('now'))").run();
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (9900, 'Películas', 'movie', 'standard', 1, 4)
  `).run();

  const sentMessages = [];
  const originalFetch = global.fetch;
  const mock = mockBypassed({
    tautulliUsers: [{ user_id: 950, username: 'edu', is_admin: 1 }],
    movieRequests: [{
      id: 5001,
      status: 2,
      type: 'movie',
      media: { tmdbId: 601 },
      createdAt: '2026-08-03T06:30:00.000Z',
      requestedBy: { id: 1, email: null, plexUsername: 'edu' },
    }],
    movieDetails: { 601: { title: 'Constantine', posterPath: '/c.jpg' } },
  });
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) sentMessages.push(JSON.parse(options.body));
    return mock(input, options);
  };

  try {
    await notifyBypassedApprovals();
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].chat_id, 'chat-950');
    assert.match(sentMessages[0].text, /Constantine/);

    const logged = db.prepare(
      "SELECT * FROM decisions_log WHERE request_id = 5001 AND decision = 'approved_outside_limitarr'"
    ).get();
    assert.ok(logged);
    assert.equal(logged.user_id, 950);
    assert.equal(logged.library_id, 9900); // sin esto getBalance nunca la ve (bug real, 3 ago 2026)

    // Segundo ciclo: ya está logueado, no se repite el aviso.
    await notifyBypassedApprovals();
    assert.equal(sentMessages.length, 1);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE request_id = 5001').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 950').run();
    db.prepare('DELETE FROM libraries WHERE id = 9900').run();
    db.prepare(
      "DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key', 'telegram_bot_token')"
    ).run();
  }
});

test('notifyBypassedApprovals: en nombre de otro usuario (no admin) sí resta cupo', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  upsertSetting('telegram_bot_token', 'test-bot-token');
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (952, 'chat-952', datetime('now'))").run();
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (9901, 'Películas', 'movie', 'standard', 1, 4)
  `).run();

  const sentMessages = [];
  const originalFetch = global.fetch;
  const mock = mockBypassed({
    // Edu (admin) pide en nombre de Rocío: la que hace match es la cuenta
    // de Rocío, no admin, aunque quien lo pidió/autoaprobó en Seerr fue Edu.
    tautulliUsers: [{ user_id: 952, username: 'rocio', is_admin: 0 }],
    movieRequests: [{
      id: 5003,
      status: 2,
      type: 'movie',
      media: { tmdbId: 603 },
      createdAt: '2026-08-06T06:30:00.000Z',
      requestedBy: { id: 3, email: null, plexUsername: 'rocio' },
    }],
    movieDetails: { 603: { title: 'Sentido y Sensibilidad', posterPath: '/s.jpg' } },
  });
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) sentMessages.push(JSON.parse(options.body));
    return mock(input, options);
  };

  try {
    await notifyBypassedApprovals();
    const logged = db.prepare("SELECT * FROM decisions_log WHERE request_id = 5003").get();
    assert.ok(logged);
    assert.equal(logged.decision, 'approved');
    assert.equal(logged.user_id, 952);
    assert.equal(logged.library_id, 9901);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE request_id = 5003').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 952').run();
    db.prepare('DELETE FROM libraries WHERE id = 9901').run();
    db.prepare(
      "DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key', 'telegram_bot_token')"
    ).run();
  }
});

test('notifyBypassedApprovals: no avisa de lo que limitARR ya procesó', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  upsertSetting('telegram_bot_token', 'test-bot-token');
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (951, 'chat-951', datetime('now'))").run();
  // Ya tiene una fila (flujo normal, quota-gated) para este request_id.
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, decision)
    VALUES (5002, 951, 'jesus', 1, 'Ya procesada', 'movie', 602, 'approved')
  `).run();

  const sentMessages = [];
  const originalFetch = global.fetch;
  const mock = mockBypassed({
    tautulliUsers: [{ user_id: 951, username: 'jesus' }],
    movieRequests: [{
      id: 5002,
      status: 2,
      type: 'movie',
      media: { tmdbId: 602 },
      createdAt: '2026-08-03T06:30:00.000Z',
      requestedBy: { id: 2, email: null, plexUsername: 'jesus' },
    }],
  });
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) sentMessages.push(JSON.parse(options.body));
    return mock(input, options);
  };

  try {
    await notifyBypassedApprovals();
    assert.equal(sentMessages.length, 0);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE request_id = 5002').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 951').run();
    db.prepare(
      "DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key', 'telegram_bot_token')"
    ).run();
  }
});

// Issue #13 (fase 3), caso Ted Lasso (4 ago 2026): con sequential_seasons, una
// solicitud multi-temporada de golpe ya no se rechaza entera — se pide de
// nuevo solo la más baja en Seerr y el resto queda en season_queue hasta que
// le toque (ver processSeasonQueue). Mock de Seerr con estado mutable (no solo
// respuestas fijas) para comprobar que, en el MISMO ciclo, la cola no se
// adelanta antes de tiempo: la temporada 3 debe ver que la 2 sigue pendiente.
function mockSequentialSplit({ tautulliUsers, tvPending }) {
  const createdRequests = [];
  const declinedIds = [];
  let nextRequestId = 9920;

  const fetchImpl = async (input, options) => {
    const url = String(input);
    const method = options?.method || 'GET';

    if (url.includes('cmd=get_users')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: tautulliUsers } }), { status: 200 });
    }
    if (url.includes('cmd=get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [] } } }), { status: 200 });
    }
    if (url.includes('/api/v1/request?filter=pending') && url.includes('mediaType=movie')) {
      return new Response(JSON.stringify({ results: [], pageInfo: { results: 0 } }), { status: 200 });
    }
    if (url.includes('/api/v1/request?filter=pending') && url.includes('mediaType=tv')) {
      return new Response(JSON.stringify({ results: tvPending, pageInfo: { results: tvPending.length } }), { status: 200 });
    }
    if (/\/api\/v1\/tv\/66260$/.test(url)) {
      return new Response(JSON.stringify({ title: 'Ted Lasso', posterPath: '/tedlasso.jpg', seasons: [], mediaInfo: null }), { status: 200 });
    }
    const declineMatch = url.match(/\/api\/v1\/request\/(\d+)\/decline$/);
    if (method === 'POST' && declineMatch) {
      const id = Number(declineMatch[1]);
      declinedIds.push(id);
      tvPending.splice(0, tvPending.length, ...tvPending.filter((r) => r.id !== id));
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url.endsWith('/api/v1/request')) {
      const body = JSON.parse(options.body);
      createdRequests.push(body);
      const id = nextRequestId++;
      tvPending.push({
        id,
        status: 1,
        type: 'tv',
        media: { tmdbId: body.mediaId },
        seasons: body.seasons.map((s) => ({ seasonNumber: s })),
        createdAt: new Date().toISOString(),
        requestedBy: { id: body.userId, email: 'edu@test.com', plexUsername: 'edu' },
      });
      return new Response(JSON.stringify({ id }), { status: 201 });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  };

  return { fetchImpl, createdRequests, declinedIds };
}

test('runPollCycle: Ted Lasso 2+3+4 con sequential_seasons se divide (pide t2, encola t3/t4) sin adelantar la cola en el mismo ciclo', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit, sequential_seasons, one_season_per_request)
    VALUES (9750, 'Series', 'show', 'standard', 1, 4, 1, 1)
  `).run();

  const tvPending = [{
    id: 9910,
    status: 2,
    type: 'tv',
    media: { tmdbId: 66260 },
    seasons: [{ seasonNumber: 2 }, { seasonNumber: 3 }, { seasonNumber: 4 }],
    createdAt: '2026-08-04T10:00:00.000Z',
    requestedBy: { id: 501, email: 'edu@test.com', plexUsername: 'edu' },
  }];
  const { fetchImpl, createdRequests, declinedIds } = mockSequentialSplit({
    tautulliUsers: [{ user_id: 6001, username: 'edu', email: 'edu@test.com', friendly_name: 'Edu', is_admin: '0' }],
    tvPending,
  });

  const originalFetch = global.fetch;
  global.fetch = fetchImpl;

  try {
    await runPollCycle();

    assert.deepEqual(declinedIds, [9910], 'la solicitud original de 3 temporadas se rechaza en Seerr');
    assert.equal(createdRequests.length, 1, 'solo se crea la solicitud de la temporada más baja en este ciclo');
    assert.deepEqual(createdRequests[0], { mediaType: 'tv', mediaId: 66260, seasons: [2], userId: 501 });

    const logged = db.prepare(
      "SELECT * FROM decisions_log WHERE request_id = 9910 AND decision = 'split_sequential'"
    ).get();
    assert.ok(logged, 'debe quedar logueado en Registro');
    assert.equal(logged.season_number, null);

    const queued = db.prepare(
      'SELECT season_number, previous_season_number FROM season_queue WHERE tmdb_id = 66260 ORDER BY season_number'
    ).all();
    assert.deepEqual(
      queued.map((r) => [r.season_number, r.previous_season_number]),
      [[3, 2], [4, 3]],
      'temporadas 3 y 4 esperan en cola; ninguna se pide todavía porque la 2 sigue pendiente de aprobar/ver'
    );
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE request_id = 9910').run();
    db.prepare('DELETE FROM season_queue WHERE tmdb_id = 66260').run();
    db.prepare('DELETE FROM libraries WHERE id = 9750').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('processSeasonQueue: pide la siguiente temporada únicamente cuando la anterior consta como vista', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit, sequential_seasons)
    VALUES (9751, 'Series', 'show', 'standard', 1, 4, 1)
  `).run();
  db.prepare(`
    INSERT INTO season_queue (id, tmdb_id, season_number, previous_season_number, user_id, seerr_user_id, library_id)
    VALUES (77001, 66261, 3, 2, 6002, 502, 9751)
  `).run();
  db.prepare(`
    INSERT INTO decisions_log
      (request_id, user_id, library_id, media_title, media_type, tmdb_id, season_number, decision)
    VALUES (77000, 6002, 9751, 'Serie - Temporada 2', 'tv', 66261, 2, 'watched')
  `).run();

  const { fetchImpl, createdRequests } = mockSequentialSplit({
    tautulliUsers: [{ user_id: 6002, username: 'edu2', email: 'edu2@test.com', friendly_name: 'Edu2', is_admin: '0' }],
    tvPending: [], // nada pendiente en Seerr para esta serie: la temporada 2 ya se vio/liberó
  });

  const originalFetch = global.fetch;
  global.fetch = fetchImpl;

  try {
    await processSeasonQueue();

    assert.equal(createdRequests.length, 1);
    assert.deepEqual(createdRequests[0], { mediaType: 'tv', mediaId: 66261, seasons: [3], userId: 502 });

    const remaining = db.prepare('SELECT 1 FROM season_queue WHERE id = 77001').get();
    assert.equal(remaining, undefined, 'la fila se borra al pedir la temporada en Seerr');
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM season_queue WHERE tmdb_id = 66261').run();
    db.prepare('DELETE FROM decisions_log WHERE request_id = 77000').run();
    db.prepare('DELETE FROM libraries WHERE id = 9751').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});

test('processSeasonQueue: quitar la temporada anterior no desbloquea la siguiente', async () => {
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  upsertSetting('seerr_url', 'http://seerr.test');
  upsertSetting('seerr_api_key', 'test-key');
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit, sequential_seasons)
    VALUES (9752, 'Series', 'show', 'standard', 1, 4, 1)
  `).run();
  db.prepare(`
    INSERT INTO season_queue (id, tmdb_id, season_number, previous_season_number, user_id, seerr_user_id, library_id)
    VALUES (77002, 66262, 3, 2, 6003, 503, 9752)
  `).run();

  const { fetchImpl, createdRequests } = mockSequentialSplit({
    tautulliUsers: [{ user_id: 6003, username: 'edu3', email: 'edu3@test.com', friendly_name: 'Edu3', is_admin: '0' }],
    tvPending: [],
  });
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;

  try {
    await processSeasonQueue();
    assert.equal(createdRequests.length, 0);
    assert.ok(db.prepare('SELECT 1 FROM season_queue WHERE id = 77002').get());
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM season_queue WHERE tmdb_id = 66262').run();
    db.prepare('DELETE FROM libraries WHERE id = 9752').run();
    db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key', 'seerr_url', 'seerr_api_key')").run();
  }
});
