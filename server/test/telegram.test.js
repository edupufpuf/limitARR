import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db.js';
import { processUpdates, handlePlexNotifyWebhook } from '../src/services/telegram.js';

// Pedido de Edu (3 ago 2026): comando /pendientes escrito al bot — lista lo
// pendiente de TODAS las bibliotecas, sin depender de un botón previo.

function upsertSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

function pendienteUpdate(chatId, text = '/pendientes') {
  return { message: { chat: { id: chatId, type: 'private' }, text } };
}

test('/pendientes: sin chat vinculado, pide vincular primero', async () => {
  upsertSetting('telegram_bot_token', 'test-bot-token');

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.includes('api.telegram.org')) {
      sent.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    await processUpdates([pendienteUpdate('chat-sin-vincular')]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.text, /No tengo tu cuenta vinculada/);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key = 'telegram_bot_token'").run();
  }
});

test('/pendientes: con chat vinculado, lista lo pendiente de todas sus bibliotecas', async () => {
  upsertSetting('telegram_bot_token', 'test-bot-token');
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (960, 'chat-960', datetime('now'))").run();
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (9600, 'Películas', 'movie', 'standard', 1, 4)
  `).run();
  db.prepare(`
    INSERT INTO decisions_log (request_id, user_id, username, library_id, media_title, media_type, decision)
    VALUES (-9601, 960, 'edu', 9600, 'Pendiente sin carátula', 'movie', 'approved')
  `).run();

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith('http://tautulli.test')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: [] } }), { status: 200 });
    }
    if (url.includes('api.telegram.org')) {
      sent.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    await processUpdates([pendienteUpdate('chat-960')]);
    const withCaption = sent.find((s) => /Sin carátula/.test(s.body.text || ''));
    assert.ok(withCaption, 'debe listar la pendiente sin carátula');
    assert.match(withCaption.body.text, /Pendiente sin carátula \(Películas\)/);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM decisions_log WHERE library_id = 9600').run();
    db.prepare('DELETE FROM quota_cache WHERE library_id = 9600').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 960').run();
    db.prepare('DELETE FROM libraries WHERE id = 9600').run();
    db.prepare("DELETE FROM settings WHERE key IN ('telegram_bot_token', 'tautulli_url', 'tautulli_api_key')").run();
  }
});

test('/pendientes: sin nada pendiente, lo dice', async () => {
  upsertSetting('telegram_bot_token', 'test-bot-token');
  upsertSetting('tautulli_url', 'http://tautulli.test');
  upsertSetting('tautulli_api_key', 'test-key');
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (961, 'chat-961', datetime('now'))").run();
  db.prepare(`
    INSERT OR REPLACE INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (9601, 'Películas', 'movie', 'standard', 1, 4)
  `).run();

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    const url = String(input);
    if (url.startsWith('http://tautulli.test')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: [] } }), { status: 200 });
    }
    if (url.includes('api.telegram.org')) {
      sent.push({ url, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    await processUpdates([pendienteUpdate('chat-961')]);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body.text, /No tienes nada pendiente de ver ahora mismo/);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM quota_cache WHERE library_id = 9601').run();
    db.prepare('DELETE FROM telegram_links WHERE user_id = 961').run();
    db.prepare('DELETE FROM libraries WHERE id = 9601').run();
    db.prepare("DELETE FROM settings WHERE key IN ('telegram_bot_token', 'tautulli_url', 'tautulli_api_key')").run();
  }
});

test('webhook Tautulli: user_id vinculado recibe el mensaje tal cual', async () => {
  upsertSetting('telegram_bot_token', 'test-bot-token');
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (962, 'chat-962', datetime('now'))").run();

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    sent.push({ url: String(input), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };

  try {
    await handlePlexNotifyWebhook({ user_id: '962', message: '▶️ Edu ha empezado a ver Silo' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.chat_id, 'chat-962');
    assert.equal(sent[0].body.text, '▶️ Edu ha empezado a ver Silo');
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM telegram_links WHERE user_id = 962').run();
    db.prepare("DELETE FROM settings WHERE key = 'telegram_bot_token'").run();
  }
});

test('webhook Tautulli: user_id sin vincular no manda nada a nadie (nunca broadcast)', async () => {
  upsertSetting('telegram_bot_token', 'test-bot-token');
  // Otro usuario SÍ vinculado, para comprobar que el aviso no se le cuela a él.
  db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (963, 'chat-963', datetime('now'))").run();

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    sent.push({ url: String(input), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };

  try {
    await handlePlexNotifyWebhook({ user_id: '999999', message: 'no debería llegar a nadie' });
    assert.equal(sent.length, 0);
  } finally {
    global.fetch = originalFetch;
    db.prepare('DELETE FROM telegram_links WHERE user_id = 963').run();
    db.prepare("DELETE FROM settings WHERE key = 'telegram_bot_token'").run();
  }
});

test('webhook Tautulli: sin user_id o sin message, se descarta sin llamar a Telegram', async () => {
  upsertSetting('telegram_bot_token', 'test-bot-token');
  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (input, options) => {
    sent.push({ url: String(input), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  };

  try {
    await handlePlexNotifyWebhook({ message: 'sin user_id' });
    await handlePlexNotifyWebhook({ user_id: '962' });
    await handlePlexNotifyWebhook({});
    assert.equal(sent.length, 0);
  } finally {
    global.fetch = originalFetch;
    db.prepare("DELETE FROM settings WHERE key = 'telegram_bot_token'").run();
  }
});
