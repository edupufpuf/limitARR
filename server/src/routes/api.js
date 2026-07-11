import { Router } from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { needsSetup, setPassword, checkPassword, getWebhookSecret } from '../auth.js';
import { getUsers, getLibraries } from '../services/tautulli.js';
import { listPendingRequests, getSeerrUsers, configureWebhook } from '../services/seerr.js';
import { getSettingsForDisplay, updateSettings } from '../settings.js';
import { resetQuota, importSeerrHistory, refreshQuotaCache, dismissPendingItem } from '../quota.js';
import { matchByEmailOrUsername } from '../userMatch.js';
import { runPollCycle } from '../scheduler.js';
import { getVersionInfo } from '../services/version.js';
import {
  getBotTokenForDisplay,
  setBotToken,
  sendMessage,
  getInboxMessages,
  getNotifyTarget,
  setNotifyTarget,
} from '../services/telegram.js';

export const router = Router();

// Express 4 no captura rechazos de promesas en handlers async: uno sin try/catch
// (p.ej. Seerr/Tautulli devolviendo un error) tumba el proceso entero (Node 20
// termina el proceso ante un unhandledRejection). Este wrapper lo reenvía al
// error handler de index.js en vez de dejarlo escapar.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// --- Auth ---

const authRateLimit = rateLimit({ max: 5, windowMs: 15 * 60 * 1000 });

router.post('/auth/setup', authRateLimit, (req, res) => {
  if (!needsSetup()) return res.status(409).json({ error: 'already_configured' });
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  setPassword(password);
  req.session.authed = true;
  res.json({ ok: true });
});

router.post('/auth/login', authRateLimit, (req, res) => {
  if (needsSetup()) return res.status(409).json({ error: 'needs_setup' });
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  req.session.authed = true;
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  res.json({ authed: Boolean(req.session?.authed), needsSetup: needsSetup() });
});

// Webhook público de Seerr (sin auth de sesión — lo llama Seerr, no un admin
// logueado). El secreto en la URL es la única protección, ver auth.js. Dispara
// el ciclo de sondeo al momento en vez de esperar hasta 60s; no bloquea la
// respuesta a Seerr ni falla si el ciclo revienta.
router.post('/webhook/seerr/:secret', (req, res) => {
  if (req.params.secret !== getWebhookSecret()) return res.status(404).end();
  res.status(200).end();
  runPollCycle().catch((err) => console.error('[webhook] poll cycle failed:', err));
});

router.use(requireAuth);

router.get('/version', ah(async (req, res) => {
  res.json(await getVersionInfo());
}));

router.post('/auth/change-password', (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!checkPassword(currentPassword)) {
    return res.status(401).json({ error: 'invalid_current_password' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  setPassword(newPassword);
  res.json({ ok: true });
});

// --- Settings (Seerr/Tautulli connection) ---

router.get('/settings', (req, res) => {
  res.json(getSettingsForDisplay());
});

router.put('/settings', (req, res) => {
  const { seerr_url, seerr_api_key, tautulli_url, tautulli_api_key, tautulli_public_url } = req.body || {};
  updateSettings({ seerr_url, seerr_api_key, tautulli_url, tautulli_api_key, tautulli_public_url });
  res.json(getSettingsForDisplay());
});

router.post('/settings/test', async (req, res) => {
  const result = {};
  try {
    await getUsers();
    result.tautulli = { ok: true };
  } catch (err) {
    result.tautulli = { ok: false, error: err.message };
  }
  try {
    await listPendingRequests();
    result.seerr = { ok: true };
  } catch (err) {
    result.seerr = { ok: false, error: err.message };
  }
  res.json(result);
});

// URL que hay que dar de alta en Seerr (Settings > Notifications > Webhook) para
// que avise a limitARR al instante. Asume que el contenedor se llama "limitarr"
// en la misma red docker que seerr — si no, hay que pegarla a mano con el
// hostname/puerto correctos.
router.get('/webhook/info', (req, res) => {
  res.json({ url: `http://limitarr:${config.port}/api/webhook/seerr/${getWebhookSecret()}` });
});

router.post('/webhook/configure', ah(async (req, res) => {
  const url = `http://limitarr:${config.port}/api/webhook/seerr/${getWebhookSecret()}`;
  await configureWebhook(url);
  res.json({ ok: true, url });
}));

// Backup consistente de la DB (API de backup online de SQLite, no una simple
// copia de fichero — segura aunque haya escrituras en curso en WAL).
router.get('/backup', ah(async (req, res) => {
  const tmpPath = path.join(os.tmpdir(), `limitarr-backup-${Date.now()}.db`);
  await db.backup(tmpPath);
  const filename = `limitarr-backup-${new Date().toISOString().slice(0, 10)}.db`;
  res.download(tmpPath, filename, (err) => {
    fs.unlink(tmpPath, () => {});
    if (err) console.error('[backup] download failed:', err);
  });
}));

// --- Libraries ---

router.get('/libraries', (req, res) => {
  res.json(db.prepare('SELECT * FROM libraries ORDER BY name').all());
});

// Pull movie/show libraries from Tautulli and insert any not yet configured, with sane defaults.
router.post('/libraries/sync', ah(async (req, res) => {
  const discovered = await getLibraries();
  const existingIds = new Set(db.prepare('SELECT id FROM libraries').all().map((r) => r.id));

  const insert = db.prepare(`
    INSERT INTO libraries (id, name, section_type, kind, enabled, default_limit)
    VALUES (?, ?, ?, ?, 1, ?)
  `);

  let inserted = 0;
  for (const lib of discovered) {
    if (existingIds.has(lib.id)) continue;
    const kind = /4k/i.test(lib.name) ? '4k' : 'standard';
    const defaultLimit = lib.sectionType === 'show' ? 2 : 4;
    insert.run(lib.id, lib.name, lib.sectionType, kind, defaultLimit);
    inserted += 1;
  }
  res.json({ discovered: discovered.length, inserted });
}));

router.put('/libraries/:id', ah(async (req, res) => {
  const { kind, enabled, defaultLimit } = req.body || {};
  const result = db
    .prepare('UPDATE libraries SET kind = ?, enabled = ?, default_limit = ? WHERE id = ?')
    .run(kind, enabled ? 1 : 0, defaultLimit, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });

  if (enabled) {
    const users = await getUsers();
    for (const user of users) await refreshQuotaCache(user.id, req.params.id);
  } else {
    db.prepare('DELETE FROM quota_cache WHERE library_id = ?').run(req.params.id);
  }

  res.json({ ok: true });
}));

// --- Users (passthrough from Tautulli, for admin dropdowns) ---

router.get('/users', ah(async (req, res) => {
  res.json(await getUsers());
}));

// --- Overrides ---

router.get('/overrides', (req, res) => {
  res.json(db.prepare('SELECT * FROM overrides').all());
});

router.put('/overrides/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const { limitOverride, note } = req.body || {};
  db.prepare(`
    INSERT INTO overrides (user_id, library_id, limit_override, note, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override,
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(userId, libraryId, limitOverride, note || null);
  await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true });
}));

router.delete('/overrides/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  db.prepare('DELETE FROM overrides WHERE user_id = ? AND library_id = ?').run(userId, libraryId);
  await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true });
}));

// Fija el mismo límite a todos los usuarios de Tautulli para una biblioteca de golpe.
router.post('/overrides/bulk', ah(async (req, res) => {
  const { libraryId, limitOverride, note } = req.body || {};
  if (!libraryId || limitOverride === undefined) {
    return res.status(400).json({ error: 'libraryId_and_limitOverride_required' });
  }

  const users = await getUsers();
  const upsert = db.prepare(`
    INSERT INTO overrides (user_id, library_id, limit_override, note, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override,
      note = excluded.note,
      updated_at = excluded.updated_at
  `);
  for (const user of users) {
    upsert.run(user.id, libraryId, limitOverride, note || null);
    await refreshQuotaCache(user.id, libraryId);
  }
  res.json({ ok: true, applied: users.length });
}));

// --- Grupos ---
// Un usuario pertenece como mucho a un grupo (PK user_id en group_members);
// asignarlo a otro grupo lo mueve. Cualquier mutación refresca quota_cache de
// los usuarios afectados en las bibliotecas con override de grupo, porque el
// límite efectivo puede cambiar al momento.

const groupExists = db.prepare('SELECT id FROM groups WHERE id = ?');
const groupMemberIds = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?');
const groupOverrideLibs = db.prepare('SELECT library_id FROM group_overrides WHERE group_id = ?');

async function refreshAffected(userIds, libraryIds) {
  for (const userId of userIds) {
    for (const libraryId of libraryIds) {
      await refreshQuotaCache(userId, libraryId);
    }
  }
}

router.get('/groups', (req, res) => {
  const groups = db.prepare('SELECT * FROM groups ORDER BY name').all();
  const members = db.prepare('SELECT * FROM group_members').all();
  const overrides = db.prepare('SELECT * FROM group_overrides').all();
  res.json(
    groups.map((g) => ({
      ...g,
      members: members.filter((m) => m.group_id === g.id).map((m) => m.user_id),
      overrides: overrides.filter((o) => o.group_id === g.id),
    }))
  );
});

router.post('/groups', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO groups (name) VALUES (?)').run(name);
    res.json({ ok: true, id: lastInsertRowid });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'name_taken' });
    throw err;
  }
});

router.delete('/groups/:id', ah(async (req, res) => {
  const { id } = req.params;
  const userIds = groupMemberIds.all(id).map((r) => r.user_id);
  const libraryIds = groupOverrideLibs.all(id).map((r) => r.library_id);
  db.transaction(() => {
    db.prepare('DELETE FROM group_overrides WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  })();
  await refreshAffected(userIds, libraryIds);
  res.json({ ok: true });
}));

// Reemplaza la lista completa de miembros del grupo.
router.put('/groups/:id/members', ah(async (req, res) => {
  const { id } = req.params;
  if (!groupExists.get(id)) return res.status(404).json({ error: 'group_not_found' });
  if (!Array.isArray(req.body?.userIds)) return res.status(400).json({ error: 'userIds_required' });
  const userIds = req.body.userIds.map(Number);

  const before = groupMemberIds.all(id).map((r) => r.user_id);
  db.transaction(() => {
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    const insert = db.prepare(
      'INSERT INTO group_members (user_id, group_id) VALUES (?, ?) ' +
        'ON CONFLICT (user_id) DO UPDATE SET group_id = excluded.group_id'
    );
    for (const userId of userIds) insert.run(userId, id);
  })();

  // Solo cambia el límite de quien entra o sale, y solo en bibliotecas donde
  // el grupo tiene override.
  const changed = [
    ...userIds.filter((u) => !before.includes(u)),
    ...before.filter((u) => !userIds.includes(u)),
  ];
  const libraryIds = groupOverrideLibs.all(id).map((r) => r.library_id);
  await refreshAffected(changed, libraryIds);
  res.json({ ok: true });
}));

router.put('/groups/:id/overrides/:libraryId', ah(async (req, res) => {
  const { id, libraryId } = req.params;
  if (!groupExists.get(id)) return res.status(404).json({ error: 'group_not_found' });
  const { limitOverride } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  db.prepare(`
    INSERT INTO group_overrides (group_id, library_id, limit_override, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (group_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override,
      updated_at = excluded.updated_at
  `).run(id, libraryId, limitOverride);
  await refreshAffected(groupMemberIds.all(id).map((r) => r.user_id), [libraryId]);
  res.json({ ok: true });
}));

router.delete('/groups/:id/overrides/:libraryId', ah(async (req, res) => {
  const { id, libraryId } = req.params;
  db.prepare('DELETE FROM group_overrides WHERE group_id = ? AND library_id = ?').run(id, libraryId);
  await refreshAffected(groupMemberIds.all(id).map((r) => r.user_id), [libraryId]);
  res.json({ ok: true });
}));

// --- Quota ---

// Agrupado por usuario, con avatar de Seerr, para las tarjetas del panel.
async function buildQuotaByUser() {
  const rows = db.prepare(`
    SELECT qc.*
    FROM quota_cache qc
    JOIN libraries l ON l.id = qc.library_id
    WHERE l.enabled = 1
  `).all();
  const [tautulliUsers, seerrUsers] = await Promise.all([getUsers(), getSeerrUsers()]);
  const tautulliUserMap = new Map(tautulliUsers.map((u) => [u.id, u]));
  const libraries = db.prepare('SELECT id, name FROM libraries WHERE enabled = 1').all();
  const libraryMap = new Map(libraries.map((l) => [l.id, l.name]));
  const recentRows = db.prepare(`
    SELECT user_id,
           SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved7d,
           SUM(CASE WHEN decision = 'no_quota' THEN 1 ELSE 0 END) AS blocked7d
    FROM decisions_log
    JOIN libraries l ON l.id = decisions_log.library_id
    WHERE created_at > datetime('now', '-7 days') AND user_id IS NOT NULL
      AND l.enabled = 1
    GROUP BY user_id
  `).all();
  const recentMap = new Map(recentRows.map((r) => [r.user_id, r]));

  function findAvatar(tautulliUser) {
    if (!tautulliUser) return null;
    return matchByEmailOrUsername(seerrUsers, tautulliUser)?.avatar ?? null;
  }

  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) {
      const tautulliUser = tautulliUserMap.get(row.user_id);
      byUser.set(row.user_id, {
        userId: row.user_id,
        username: tautulliUser?.username ?? `user#${row.user_id}`,
        avatar: findAvatar(tautulliUser),
        approved7d: recentMap.get(row.user_id)?.approved7d ?? 0,
        blocked7d: recentMap.get(row.user_id)?.blocked7d ?? 0,
        libraries: [],
      });
    }
    let pendingItems = [];
    try {
      pendingItems = JSON.parse(row.pending_items || '[]');
    } catch { /* caché de una versión anterior sin pending_items válido */ }
    byUser.get(row.user_id).libraries.push({
      libraryId: row.library_id,
      libraryName: libraryMap.get(row.library_id) ?? `#${row.library_id}`,
      balance: row.balance,
      limitApplied: row.limit_applied,
      outstanding: row.outstanding,
      pendingItems,
      computedAt: row.computed_at,
    });
  }
  return [...byUser.values()];
}

router.get('/quota', ah(async (req, res) => {
  res.json(await buildQuotaByUser());
}));

// Rellena decisions_log con solicitudes aprobadas en Seerr que limitARR no vio
// (de antes de instalarlo, o aprobadas a mano en Seerr). Idempotente.
router.post('/quota/import-seerr-history', ah(async (req, res) => {
  const imported = await importSeerrHistory();
  res.json({ ok: true, imported });
}));

// Force-compute quota for every user x enabled library, so the panel shows
// something even before anyone has made a request through Seerr.
router.post('/quota/recalculate', ah(async (req, res) => {
  const users = await getUsers();
  const libraries = db.prepare('SELECT * FROM libraries WHERE enabled = 1').all();

  for (const user of users) {
    for (const library of libraries) {
      await refreshQuotaCache(user.id, library.id);
    }
  }
  res.json({ ok: true, users: users.length, libraries: libraries.length });
}));

// Marca como "resueltas" las pendientes actuales de un usuario+biblioteca (no
// cuentan más contra su cupo), y refresca la caché al momento para el panel.
router.post('/quota/reset/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  resetQuota(userId, libraryId);
  const result = await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true, ...result });
}));

// Quita UN pendiente concreto (película o temporada) del cupo de un usuario
// (sin resetear el resto), identificado por tmdbId+temporada o título.
// Refresca la caché para que el panel lo refleje al momento.
router.post('/quota/dismiss/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const { tmdbId, seasonNumber, title } = req.body || {};
  if (tmdbId == null && !title) {
    return res.status(400).json({ error: 'tmdbId_or_title_required' });
  }
  const dismissed = dismissPendingItem(userId, libraryId, { tmdbId, seasonNumber, title });
  const result = await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true, dismissed, ...result });
}));

// --- Stats (KPIs para la cabecera de la pestaña Cupo) ---

router.get('/stats', (req, res) => {
  const cache = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS users,
           COALESCE(SUM(outstanding), 0) AS outstanding,
           COUNT(DISTINCT CASE WHEN balance <= 0 THEN user_id END) AS usersBlocked
    FROM quota_cache qc
    JOIN libraries l ON l.id = qc.library_id
    WHERE l.enabled = 1
  `).get();
  const last7d = db.prepare(`
    SELECT
      SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END) AS approved7d,
      SUM(CASE WHEN decision = 'no_quota' THEN 1 ELSE 0 END) AS blocked7d
    FROM decisions_log
    JOIN libraries l ON l.id = decisions_log.library_id
    WHERE created_at > datetime('now', '-7 days')
      AND l.enabled = 1
  `).get();
  res.json({
    users: cache.users,
    outstanding: cache.outstanding,
    usersBlocked: cache.usersBlocked,
    approved7d: last7d.approved7d ?? 0,
    blocked7d: last7d.blocked7d ?? 0,
  });
});

// --- Decisions log ---

// Filtrable y paginado: ?decision=approved&q=texto&limit=50&offset=0.
// `q` busca por usuario o título; devuelve total para el "cargar más" del panel.
router.get('/decisions', (req, res) => {
  const { decision, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = [];
  const params = [];
  if (decision) {
    where.push('decision = ?');
    params.push(decision);
  }
  if (q) {
    where.push('(username LIKE ? OR media_title LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM decisions_log ${whereSql}`)
    .get(...params);
  const rows = db
    .prepare(`SELECT * FROM decisions_log ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  res.json({ rows, total });
});

// --- Telegram notifications ---

router.get('/notifications/settings', (req, res) => {
  res.json({ ...getBotTokenForDisplay(), ...getNotifyTarget() });
});

router.put('/notifications/settings', (req, res) => {
  const { botToken, mode, groupChatId, groupTopicId, noQuotaMessage } = req.body || {};
  if (typeof botToken === 'string' && botToken.trim() !== '') setBotToken(botToken);
  if (mode || groupChatId !== undefined || groupTopicId !== undefined || noQuotaMessage !== undefined) {
    setNotifyTarget({ mode, groupChatId, groupTopicId, noQuotaMessage });
  }
  res.json({ ...getBotTokenForDisplay(), ...getNotifyTarget() });
});

router.get('/notifications/links', ah(async (req, res) => {
  const rows = db.prepare('SELECT * FROM telegram_links').all();
  const users = await getUsers();
  const userMap = new Map(users.map((u) => [u.id, u]));
  res.json(
    rows.map((r) => ({ ...r, username: userMap.get(r.user_id)?.username ?? `user#${r.user_id}` }))
  );
}));

router.put('/notifications/links/:userId', (req, res) => {
  const { chatId, label } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId_required' });
  db.prepare(`
    INSERT INTO telegram_links (user_id, chat_id, label, linked_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (user_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      label = excluded.label,
      linked_at = excluded.linked_at
  `).run(req.params.userId, String(chatId), label || null);
  res.json({ ok: true });
});

router.delete('/notifications/links/:userId', (req, res) => {
  db.prepare('DELETE FROM telegram_links WHERE user_id = ?').run(req.params.userId);
  res.json({ ok: true });
});

// Lee los últimos mensajes que le han llegado al bot (capturados en background
// por el poller), excluyendo chat_ids ya vinculados, para que el admin pueda
// elegir quién es quién sin llamar a Telegram en vivo desde el panel.
router.get('/notifications/discover', (req, res) => {
  const linkedChatIds = new Set(
    db.prepare('SELECT chat_id FROM telegram_links').all().map((r) => r.chat_id)
  );
  const messages = getInboxMessages()
    .filter((m) => !linkedChatIds.has(m.chat_id))
    .map((m) => ({
      chatId: m.chat_id,
      chatType: m.chat_type,
      chatTitle: m.chat_title,
      messageThreadId: m.message_thread_id,
      username: m.username,
      firstName: m.first_name,
      text: m.text,
    }));
  res.json(messages);
});

function pendingTitle(item) {
  if (!item?.title) return null;
  return item.title;
}

function buildPendingSummaryRows() {
  const rows = db.prepare(`
    SELECT qc.user_id, qc.library_id, qc.outstanding, qc.pending_items, l.name AS library_name
    FROM quota_cache qc
    JOIN libraries l ON l.id = qc.library_id
    WHERE l.enabled = 1 AND qc.outstanding > 0
    ORDER BY qc.user_id, l.name
  `).all();
  const users = db.prepare('SELECT user_id, chat_id, label FROM telegram_links').all();
  const linkMap = new Map(users.map((u) => [u.user_id, u]));

  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) {
      byUser.set(row.user_id, {
        userId: row.user_id,
        username: row.username,
        link: linkMap.get(row.user_id) ?? null,
        libraries: [],
      });
    }
    let items = [];
    try {
      items = JSON.parse(row.pending_items || '[]').map(pendingTitle).filter(Boolean);
    } catch {
      items = [];
    }
    byUser.get(row.user_id).libraries.push({
      libraryName: row.library_name,
      outstanding: row.outstanding,
      items,
    });
  }
  return [...byUser.values()];
}

async function hydratePendingSummaryUsers(summaries) {
  const users = await getUsers();
  const userMap = new Map(users.map((u) => [u.id, u]));
  return summaries.map((summary) => ({
    ...summary,
    username: userMap.get(summary.userId)?.username ?? summary.link?.label ?? `user#${summary.userId}`,
  }));
}

function formatPendingSummaryForUser(summary, { personal = false } = {}) {
  const lines = [personal ? '📋 Te queda por ver:' : `👤 ${summary.username}`];
  for (const lib of summary.libraries) {
    lines.push(`• ${lib.libraryName} (${lib.outstanding})`);
    const items = lib.items.length > 0 ? lib.items : ['Sin título guardado'];
    for (const title of items) lines.push(`  - ${title}`);
  }
  return lines.join('\n');
}

function chunkTelegramText(text) {
  const chunks = [];
  let current = '';
  for (const block of text.split('\n\n')) {
    const next = current ? `${current}\n\n${block}` : block;
    if (next.length > 3600 && current) {
      chunks.push(current);
      current = block;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

router.post('/notifications/pending-summary', ah(async (req, res) => {
  const target = getNotifyTarget();
  const summaries = await hydratePendingSummaryUsers(buildPendingSummaryRows());
  const withPending = summaries.filter((s) => s.libraries.length > 0);

  if (target.mode === 'group') {
    if (!target.groupChatId) return res.status(404).json({ error: 'group_not_configured' });
    const body = withPending.length > 0
      ? `📋 Pendientes por ver\n\n${withPending.map((s) => formatPendingSummaryForUser(s)).join('\n\n')}`
      : '📋 No hay nada pendiente de ver ahora mismo.';
    let sent = 0;
    for (const chunk of chunkTelegramText(body)) {
      await sendMessage(target.groupChatId, chunk, { messageThreadId: target.groupTopicId });
      sent += 1;
    }
    return res.json({ ok: true, mode: 'group', users: withPending.length, messages: sent });
  }

  let messages = 0;
  let sent = 0;
  let skipped = 0;
  for (const summary of withPending) {
    if (!summary.link?.chat_id) {
      skipped += 1;
      continue;
    }
    for (const chunk of chunkTelegramText(formatPendingSummaryForUser(summary, { personal: true }))) {
      await sendMessage(summary.link.chat_id, chunk);
      messages += 1;
    }
    sent += 1;
  }
  res.json({ ok: true, mode: 'dm', users: withPending.length, sent, skipped, messages });
}));

router.post('/notifications/test/:userId', async (req, res) => {
  const link = db.prepare('SELECT chat_id FROM telegram_links WHERE user_id = ?').get(req.params.userId);
  if (!link) return res.status(404).json({ error: 'not_linked' });
  try {
    await sendMessage(link.chat_id, '✅ limitARR: notificaciones conectadas correctamente.');
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/notifications/test-group', async (req, res) => {
  const { groupChatId, groupTopicId } = getNotifyTarget();
  if (!groupChatId) return res.status(404).json({ error: 'group_not_configured' });
  try {
    await sendMessage(groupChatId, '✅ limitARR: notificaciones de grupo conectadas correctamente.', { messageThreadId: groupTopicId });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
