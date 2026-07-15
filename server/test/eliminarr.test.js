import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db } from '../src/db.js';
import { setRawSetting } from '../src/settings.js';
import { evaluateRule } from '../src/rules.js';

// GB de tamaño de fichero, para que los tests de file_size_over_gb sean legibles.
const GB = 1024 ** 3;

function setRadarrSettings() {
  setRawSetting('eliminarr_radarr_url', 'http://radarr.test');
  setRawSetting('eliminarr_radarr_api_key', 'radarr-key');
}

function setTautulliSettings() {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('tautulli_url', 'http://tautulli.test'), ('tautulli_api_key', 'test-key')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run();
}

const RADARR_MOVIES = [
  // Nunca vista, añadida hace años: matches not_watched_days (nunca vista = "desde siempre")
  // y never_watched_added_days.
  { id: 1, title: 'Old Never Watched', tmdbId: 100, added: '2020-01-01T00:00:00Z', sizeOnDisk: 2 * GB, tags: [], images: [] },
  // Vista ayer: NO matches not_watched_days(30), NO matches never_watched_added_days (sí se vio).
  { id: 2, title: 'Recently Watched', tmdbId: 200, added: '2020-01-01T00:00:00Z', sizeOnDisk: 2 * GB, tags: [], images: [] },
  // Añadida hoy, fichero grande: solo matches file_size_over_gb.
  { id: 3, title: 'Big File New', tmdbId: 300, added: new Date().toISOString(), sizeOnDisk: 20 * GB, tags: [], images: [] },
];

const RATING_KEYS = { 100: 501, 200: 502, 300: 503 };

async function mockFetch(input) {
  const url = String(input);

  if (url === 'http://radarr.test/api/v3/movie') {
    return new Response(JSON.stringify(RADARR_MOVIES), { status: 200 });
  }
  if (url === 'http://radarr.test/api/v3/tag') {
    return new Response(JSON.stringify([]), { status: 200 });
  }
  if (url === 'http://radarr.test/api/v3/system/status') {
    return new Response(JSON.stringify({ version: '5.0.0' }), { status: 200 });
  }

  if (url.startsWith('http://tautulli.test/api/v2')) {
    const params = new URL(url).searchParams;
    const cmd = params.get('cmd');
    if (cmd === 'search') {
      const query = params.get('query');
      const movie = RADARR_MOVIES.find((m) => m.title === query);
      const ratingKey = movie ? RATING_KEYS[movie.tmdbId] : null;
      const results = movie
        ? [{ rating_key: ratingKey, title: movie.title, guids: [`tmdb://${movie.tmdbId}`] }]
        : [];
      return new Response(JSON.stringify({
        response: { result: 'success', data: { results_list: { movie: results, show: [], season: [] } } },
      }), { status: 200 });
    }
    if (cmd === 'get_history') {
      const ratingKey = Number(params.get('rating_key'));
      // Solo la película 502 (Recently Watched) tiene una reproducción, y fue ayer.
      const rows = ratingKey === 502
        ? [{ user_id: '1', friendly_name: 'edu', date: String(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)), percent_complete: 100 }]
        : [];
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: rows } } }), { status: 200 });
    }
  }

  throw new Error(`unexpected fetch ${url}`);
}

let originalFetch;
before(() => {
  originalFetch = global.fetch;
  global.fetch = mockFetch;
  setRadarrSettings();
  setTautulliSettings();
});
after(() => {
  global.fetch = originalFetch;
});

test('file_size_over_gb: no toca Tautulli (regla solo de tamaño con Tautulli sin configurar)', async () => {
  db.prepare("DELETE FROM settings WHERE key IN ('tautulli_url', 'tautulli_api_key')").run();
  try {
    const rule = {
      media_type: 'movie',
      tag_ids: [],
      condition_logic: 'all',
      conditions: [{ type: 'file_size_over_gb', gb: 10 }],
    };
    const { matches } = await evaluateRule(rule, { dryRun: true });
    assert.deepEqual(matches.map((m) => m.title), ['Big File New']);
  } finally {
    setTautulliSettings();
  }
});

test('not_watched_days: nunca vista cuenta como "desde siempre", vista ayer no matchea con umbral 30', async () => {
  const rule = {
    media_type: 'movie',
    tag_ids: [],
    condition_logic: 'all',
    conditions: [{ type: 'not_watched_days', days: 30 }],
  };
  const { matches } = await evaluateRule(rule, { dryRun: true });
  const titles = matches.map((m) => m.title).sort();
  assert.deepEqual(titles, ['Big File New', 'Old Never Watched']);
});

test('never_watched_added_days: exige cero reproducciones jamás, no solo "hace tiempo"', async () => {
  const rule = {
    media_type: 'movie',
    tag_ids: [],
    condition_logic: 'all',
    conditions: [{ type: 'never_watched_added_days', days: 365 }],
  };
  const { matches } = await evaluateRule(rule, { dryRun: true });
  // "Recently Watched" fue añadida hace años pero SÍ se vio -> no matchea.
  // "Big File New" se añadió hoy -> no supera el umbral de días.
  assert.deepEqual(matches.map((m) => m.title), ['Old Never Watched']);
});

test('condition_logic "any" vs "all"', async () => {
  const conditions = [
    { type: 'file_size_over_gb', gb: 10 },       // solo "Big File New"
    { type: 'never_watched_added_days', days: 365 }, // solo "Old Never Watched"
  ];
  const any = await evaluateRule({ media_type: 'movie', tag_ids: [], condition_logic: 'any', conditions }, { dryRun: true });
  assert.deepEqual(any.matches.map((m) => m.title).sort(), ['Big File New', 'Old Never Watched']);

  const all = await evaluateRule({ media_type: 'movie', tag_ids: [], condition_logic: 'all', conditions }, { dryRun: true });
  assert.deepEqual(all.matches, []); // ningún ítem cumple ambas condiciones a la vez
});

test('dryRun:true nunca escribe en eliminarr_executions', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM eliminarr_executions').get().n;
  await evaluateRule({ media_type: 'movie', tag_ids: [], condition_logic: 'all', conditions: [{ type: 'file_size_over_gb', gb: 10 }] }, { dryRun: true });
  const after = db.prepare('SELECT COUNT(*) AS n FROM eliminarr_executions').get().n;
  assert.equal(after, before);
});

// --- Candados contra el borrado accidental, a nivel de rutas ---

const app = createApp();
const agent = request.agent(app);

before(async () => {
  await agent.post('/api/auth/setup').send({ password: 'secreto-de-test' }).expect(200);
});

test('POST /rules ignora cualquier "enabled" del body: ninguna regla nace armada', async () => {
  const res = await agent.post('/api/eliminarr/rules').send({
    name: 'Regla de prueba',
    media_type: 'movie',
    enabled: true, // intento de colar una regla ya armada
    conditions: [{ type: 'file_size_over_gb', gb: 10 }],
    action: 'delete',
  }).expect(201);
  assert.equal(res.body.enabled, false);

  const runNow = await agent.post(`/api/eliminarr/rules/${res.body.id}/run-now`).expect(409);
  assert.equal(runNow.body.error, 'rule_not_armed');

  await agent.put(`/api/eliminarr/rules/${res.body.id}`).send({ enabled: true }).expect(200);
  const row = db.prepare('SELECT enabled FROM eliminarr_rules WHERE id = ?').get(res.body.id);
  assert.equal(row.enabled, 1);

  db.prepare('DELETE FROM eliminarr_rules WHERE id = ?').run(res.body.id);
});

test('sin sesión, las rutas de eliminarr devuelven 401', async () => {
  await request(app).get('/api/eliminarr/rules').expect(401);
});
