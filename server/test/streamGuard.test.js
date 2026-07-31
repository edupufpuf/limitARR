import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { enforceStreamLimit, updateStreamLimitSettings } from '../src/services/streamGuard.js';

// Test del límite de dispositivos: DB en memoria y fetch mockeado (nada de
// red real, ni Tautulli ni Plex), estilo maintainerr.test.js.

const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value
`);

const realFetch = global.fetch;
let fetchCalls;

const USERS = [
  { user_id: 1, username: 'ana', email: 'ana@test.com', friendly_name: 'Ana', is_admin: 0 },
  { user_id: 2, username: 'root', email: 'root@test.com', friendly_name: 'Root', is_admin: 1 },
];

function mockFetch(sessions) {
  fetchCalls = [];
  global.fetch = async (url) => {
    const u = String(url);
    fetchCalls.push(u);
    if (u.startsWith('http://tautulli.test')) {
      const cmd = new URL(u).searchParams.get('cmd');
      if (cmd === 'get_activity') {
        return new Response(JSON.stringify({ response: { result: 'success', data: { sessions } } }), { status: 200 });
      }
      if (cmd === 'get_users') {
        return new Response(JSON.stringify({ response: { result: 'success', data: USERS } }), { status: 200 });
      }
      throw new Error(`unexpected tautulli cmd ${cmd}`);
    }
    if (u.startsWith('http://plex.test')) {
      return new Response('{}', { status: 200 });
    }
    throw new Error(`fetch inesperado en test: ${u}`);
  };
}

function setup() {
  upsertSetting.run('tautulli_url', 'http://tautulli.test');
  upsertSetting.run('tautulli_api_key', 'key-de-test');
  upsertSetting.run('plex_url', 'http://plex.test');
  upsertSetting.run('plex_token', 'token-de-test');
  updateStreamLimitSettings({ enabled: true, max: 1, message: 'Corte de prueba' });
}

afterEach(() => {
  global.fetch = realFetch;
  updateStreamLimitSettings({ enabled: false });
});

test('stream-limit: dos sesiones del mismo usuario corta la más reciente', async () => {
  setup();
  mockFetch([
    { session_key: '10', session_id: 'sid-viejo', user_id: '1', friendly_name: 'Ana', player: 'TV Salón' },
    { session_key: '11', session_id: 'sid-nuevo', user_id: '1', friendly_name: 'Ana', player: 'Móvil' },
  ]);

  await enforceStreamLimit();

  const terminateCalls = fetchCalls.filter((u) => u.includes('/status/sessions/terminate'));
  assert.equal(terminateCalls.length, 1);
  assert.match(terminateCalls[0], /sessionId=sid-nuevo/);
  assert.match(terminateCalls[0], /reason=Corte\+de\+prueba/);
});

test('stream-limit: una sola sesión no corta nada', async () => {
  setup();
  mockFetch([{ session_key: '10', session_id: 'sid-unico', user_id: '1', friendly_name: 'Ana', player: 'TV Salón' }]);

  await enforceStreamLimit();

  assert.equal(fetchCalls.filter((u) => u.includes('/status/sessions/terminate')).length, 0);
});

test('stream-limit: los admins quedan exentos', async () => {
  setup();
  mockFetch([
    { session_key: '10', session_id: 'sid-a', user_id: '2', friendly_name: 'Root', player: 'TV' },
    { session_key: '11', session_id: 'sid-b', user_id: '2', friendly_name: 'Root', player: 'Móvil' },
  ]);

  await enforceStreamLimit();

  assert.equal(fetchCalls.filter((u) => u.includes('/status/sessions/terminate')).length, 0);
});

test('stream-limit: desactivado no llama a Tautulli ni a Plex', async () => {
  setup();
  updateStreamLimitSettings({ enabled: false });
  mockFetch([
    { session_key: '10', session_id: 'sid-a', user_id: '1', friendly_name: 'Ana', player: 'TV' },
    { session_key: '11', session_id: 'sid-b', user_id: '1', friendly_name: 'Ana', player: 'Móvil' },
  ]);

  await enforceStreamLimit();

  assert.equal(fetchCalls.length, 0);
});
