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
import {
  listPendingRequests,
  getSeerrUsers,
  configureWebhook,
  approveRequest,
  declineRequest,
  getRequest,
  getMediaDetails,
} from '../services/seerr.js';
import { getSettings, getSettingsForDisplay, updateSettings } from '../settings.js';
import { resetQuota, importSeerrHistory, refreshQuotaCache, dismissPendingItem, getPendingItemDetail, quotaIdentity, getBalance } from '../quota.js';
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
  normalizeGroupTarget,
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
  const { seerr_url, seerr_api_key, seerr_public_url, tautulli_url, tautulli_api_key, tautulli_public_url } = req.body || {};
  updateSettings({ seerr_url, seerr_api_key, seerr_public_url, tautulli_url, tautulli_api_key, tautulli_public_url });
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
  const { kind, enabled, defaultLimit, expiryDays } = req.body || {};
  const result = db
    .prepare('UPDATE libraries SET kind = ?, enabled = ?, default_limit = ?, expiry_days = ? WHERE id = ?')
    .run(kind, enabled ? 1 : 0, defaultLimit, expiryDays ?? null, req.params.id);
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
  const { limitOverride, note, expiryOverride } = req.body || {};
  db.prepare(`
    INSERT INTO overrides (user_id, library_id, limit_override, note, expiry_override, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (user_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override,
      note = excluded.note,
      expiry_override = excluded.expiry_override,
      updated_at = excluded.updated_at
  `).run(userId, libraryId, limitOverride, note || null, expiryOverride ?? null);
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
  // Miembros de un grupo agregado comparten fila de caché: se dedupe por
  // identidad para no recalcular el mismo grupo una vez por miembro.
  const cacheIds = [...new Set(userIds.map((id) => quotaIdentity(id).cacheId))];
  for (const cacheId of cacheIds) {
    for (const libraryId of libraryIds) {
      await refreshQuotaCache(cacheId, libraryId);
    }
  }
}

const enabledLibraryIds = () =>
  db.prepare('SELECT id FROM libraries WHERE enabled = 1').all().map((l) => l.id);

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
  const aggregated = req.body?.aggregated ? 1 : 0;
  try {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO groups (name, aggregated) VALUES (?, ?)')
      .run(name, aggregated);
    res.json({ ok: true, id: lastInsertRowid });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'name_taken' });
    throw err;
  }
});

// Activa/desactiva el cupo grupal agregado (issue #4). Al activar, la caché de
// los miembros se sustituye por una única fila del grupo (user_id = -id); al
// desactivar, se borra esa fila y cada miembro recupera la suya.
router.put('/groups/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (!groupExists.get(id)) return res.status(404).json({ error: 'group_not_found' });
  const { aggregated } = req.body || {};
  if (aggregated === undefined) return res.status(400).json({ error: 'aggregated_required' });
  db.prepare('UPDATE groups SET aggregated = ? WHERE id = ?').run(aggregated ? 1 : 0, id);

  const libraryIds = enabledLibraryIds();
  if (aggregated) {
    // refreshQuotaCache(-id) recalcula el grupo y borra las filas individuales.
    for (const libraryId of libraryIds) await refreshQuotaCache(-id, libraryId);
  } else {
    db.prepare('DELETE FROM quota_cache WHERE user_id = ?').run(-id);
    await refreshAffected(groupMemberIds.all(id).map((r) => r.user_id), libraryIds);
  }
  res.json({ ok: true });
}));

router.delete('/groups/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const wasAggregated = Boolean(db.prepare('SELECT aggregated FROM groups WHERE id = ?').get(id)?.aggregated);
  const userIds = groupMemberIds.all(id).map((r) => r.user_id);
  // Un grupo agregado afecta a todas las bibliotecas activas, no solo a las
  // que tenían override: sus miembros recuperan cupo individual en todas.
  const libraryIds = wasAggregated
    ? enabledLibraryIds()
    : groupOverrideLibs.all(id).map((r) => r.library_id);
  db.transaction(() => {
    db.prepare('DELETE FROM group_overrides WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    db.prepare('DELETE FROM quota_cache WHERE user_id = ?').run(-id);
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

  const removed = before.filter((u) => !userIds.includes(u));
  const added = userIds.filter((u) => !before.includes(u));
  const aggregated = Boolean(db.prepare('SELECT aggregated FROM groups WHERE id = ?').get(id)?.aggregated);
  if (aggregated) {
    // El cupo compartido cambia con cualquier alta/baja, en todas las
    // bibliotecas activas: se recalcula la fila del grupo (que además borra las
    // filas individuales de los que entran) y quien sale recupera la suya.
    const libraryIds = enabledLibraryIds();
    for (const libraryId of libraryIds) await refreshQuotaCache(-Number(id), libraryId);
    await refreshAffected(removed, libraryIds);
  } else {
    // Solo cambia el límite de quien entra o sale, y solo en bibliotecas donde
    // el grupo tiene override.
    const libraryIds = groupOverrideLibs.all(id).map((r) => r.library_id);
    await refreshAffected([...added, ...removed], libraryIds);
  }
  res.json({ ok: true });
}));

router.put('/groups/:id/overrides/:libraryId', ah(async (req, res) => {
  const { id, libraryId } = req.params;
  if (!groupExists.get(id)) return res.status(404).json({ error: 'group_not_found' });
  const { limitOverride, expiryOverride } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  db.prepare(`
    INSERT INTO group_overrides (group_id, library_id, limit_override, expiry_override, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (group_id, library_id) DO UPDATE SET
      limit_override = excluded.limit_override,
      expiry_override = excluded.expiry_override,
      updated_at = excluded.updated_at
  `).run(id, libraryId, limitOverride, expiryOverride ?? null);
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
  const groupMap = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.id, g]));
  const membersByGroup = new Map();
  for (const m of db.prepare('SELECT user_id, group_id FROM group_members').all()) {
    if (!membersByGroup.has(m.group_id)) membersByGroup.set(m.group_id, []);
    membersByGroup.get(m.group_id).push(m.user_id);
  }

  function findAvatar(tautulliUser) {
    if (!tautulliUser) return null;
    return matchByEmailOrUsername(seerrUsers, tautulliUser)?.avatar ?? null;
  }

  const byUser = new Map();
  for (const row of rows) {
    if (!byUser.has(row.user_id)) {
      // Issue #4: user_id negativo = grupo agregado. Sale como una tarjeta
      // única con el nombre del grupo; los miembros no tienen fila propia.
      if (row.user_id < 0) {
        const groupId = -row.user_id;
        const memberIds = membersByGroup.get(groupId) ?? [];
        byUser.set(row.user_id, {
          userId: row.user_id,
          username: groupMap.get(groupId)?.name ?? `grupo#${groupId}`,
          avatar: null,
          isGroup: true,
          members: memberIds.map((uid) => tautulliUserMap.get(uid)?.username ?? `user#${uid}`),
          approved7d: memberIds.reduce((sum, uid) => sum + (recentMap.get(uid)?.approved7d ?? 0), 0),
          blocked7d: memberIds.reduce((sum, uid) => sum + (recentMap.get(uid)?.blocked7d ?? 0), 0),
          libraries: [],
        });
      } else {
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

// Detalle de un pendiente para la ventana de detalle (issue #6): fecha de
// solicitud/aprobación y visualizaciones agregadas por usuario (todas las
// cuentas, no solo el solicitante), más el enlace a la ficha en Seerr.
router.get('/quota/pending-detail/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const { tmdbId, seasonNumber, title, ratingKey, mediaType, episodesTotal } = req.query;
  const detail = await getPendingItemDetail(Number(userId), Number(libraryId), {
    tmdbId: tmdbId ? Number(tmdbId) : null,
    seasonNumber: seasonNumber ? Number(seasonNumber) : null,
    title: title || '',
    ratingKey: ratingKey || null,
    mediaType: mediaType || 'movie',
    episodesTotal: episodesTotal ? Number(episodesTotal) : null,
  });
  const settings = getSettings();
  const seerrBase = settings.seerr_public_url || settings.seerr_url;
  const seerrUrl = seerrBase && tmdbId
    ? `${seerrBase}/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}`
    : null;
  res.json({ ...detail, seerrUrl });
}));

// --- Issue #11: solicitudes fuera de cupo, pendientes de aprobación en Seerr ---

const getLibraryForRequestStmt = db.prepare(`
  SELECT * FROM libraries WHERE section_type = ? AND kind = ? AND enabled = 1 LIMIT 1
`);
const getCachedBalance = db.prepare(
  'SELECT balance, limit_applied FROM quota_cache WHERE user_id = ? AND library_id = ?'
);
const insertManualDecision = db.prepare(`
  INSERT INTO decisions_log
    (request_id, user_id, username, library_id, media_title, media_type, tmdb_id, season_number, poster_url, balance_before, limit_applied, decision)
  VALUES
    (@requestId, @userId, @username, @libraryId, @mediaTitle, @mediaType, @tmdbId, @seasonNumber, @posterUrl, @balanceBefore, @limitApplied, @decision)
`);
const approvedAlreadyLogged = db.prepare(`
  SELECT 1 FROM decisions_log
  WHERE request_id = ? AND decision = 'approved' AND voided_at IS NULL
    AND COALESCE(season_number, -1) = COALESCE(?, -1)
`);
const approvedPairsForRequest = db.prepare(`
  SELECT DISTINCT user_id, library_id FROM decisions_log
  WHERE request_id = ? AND decision = 'approved' AND voided_at IS NULL
`);
const voidApprovedByRequest = db.prepare(`
  UPDATE decisions_log SET voided_at = datetime('now')
  WHERE request_id = ? AND decision = 'approved' AND voided_at IS NULL
`);
const lastRowForRequest = db.prepare(
  'SELECT * FROM decisions_log WHERE request_id = ? ORDER BY id DESC LIMIT 1'
);

function formatRequestTitle(mediaType, title, seasonNumber = null) {
  if (mediaType !== 'tv' || !seasonNumber) return title;
  return `${title ?? 'Serie'} - Temporada ${seasonNumber}`;
}

// Lo que sigue sin aprobar en Seerr (el sondeo solo auto-aprueba dentro de
// cupo, así que esto es en la práctica lo bloqueado por cupo o sin match),
// con contexto para decidir: biblioteca, usuario y su saldo cacheado.
router.get('/requests/pending-approval', ah(async (req, res) => {
  const [pending, tautulliUsers] = await Promise.all([listPendingRequests(), getUsers()]);
  const items = [];
  for (const request of pending) {
    const sectionType = request.mediaType === 'tv' ? 'show' : 'movie';
    const library = getLibraryForRequestStmt.get(sectionType, request.is4k ? '4k' : 'standard');
    const tautulliUser = matchByEmailOrUsername(tautulliUsers, request.requestedBy || {});
    const seasonNumber = request.seasons[0] ?? null;
    const details = await getMediaDetails(request.mediaType, request.tmdbId, seasonNumber);
    const cached = library && tautulliUser
      ? getCachedBalance.get(quotaIdentity(tautulliUser.id).cacheId, library.id)
      : null;
    items.push({
      requestId: request.id,
      mediaType: request.mediaType,
      tmdbId: request.tmdbId ?? null,
      seasons: request.seasons,
      title: formatRequestTitle(request.mediaType, details.title, seasonNumber),
      posterUrl: details.posterUrl ?? null,
      libraryId: library?.id ?? null,
      libraryName: library?.name ?? null,
      userId: tautulliUser?.id ?? null,
      username: tautulliUser?.username ?? request.requestedBy?.username ?? 'unknown',
      balance: cached?.balance ?? null,
      limit: cached?.limit_applied ?? null,
    });
  }
  res.json(items);
}));

// Aprueba en Seerr Y lo registra como aprobada (si no, el cupo no lo contaría:
// el sondeo solo loguea solicitudes que siguen pendientes).
router.post('/requests/:id/approve', ah(async (req, res) => {
  const requestId = Number(req.params.id);
  const [request, tautulliUsers] = await Promise.all([getRequest(requestId), getUsers()]);
  const sectionType = request.mediaType === 'tv' ? 'show' : 'movie';
  const library = getLibraryForRequestStmt.get(sectionType, request.is4k ? '4k' : 'standard');
  const tautulliUser = matchByEmailOrUsername(tautulliUsers, request.requestedBy || {});

  await approveRequest(requestId);

  let balanceBefore = null;
  let limitApplied = null;
  if (library && tautulliUser) {
    try {
      const b = await getBalance(tautulliUser.id, library.id);
      balanceBefore = b.balance;
      limitApplied = b.limit;
    } catch { /* sin saldo no se bloquea la aprobación manual */ }
  }
  const seasons = request.mediaType === 'tv' && request.seasons.length > 0 ? request.seasons : [null];
  for (const seasonNumber of seasons) {
    if (approvedAlreadyLogged.get(requestId, seasonNumber ?? null)) continue;
    const details = await getMediaDetails(request.mediaType, request.tmdbId, seasonNumber);
    insertManualDecision.run({
      requestId,
      userId: tautulliUser?.id ?? null,
      username: tautulliUser?.username ?? request.requestedBy?.username ?? 'unknown',
      libraryId: library?.id ?? null,
      mediaTitle: formatRequestTitle(request.mediaType, details.title, seasonNumber),
      mediaType: request.mediaType,
      tmdbId: request.tmdbId ?? null,
      seasonNumber,
      posterUrl: details.posterUrl ?? null,
      balanceBefore,
      limitApplied,
      decision: 'approved',
    });
  }
  if (library && tautulliUser) await refreshQuotaCache(tautulliUser.id, library.id);
  res.json({ ok: true });
}));

// Rechaza en Seerr. Si la solicitud estaba aprobada y contando (caso "aún no
// disponible" del detalle), sus filas se anulan y el cupo se libera al momento.
router.post('/requests/:id/decline', ah(async (req, res) => {
  const requestId = Number(req.params.id);
  await declineRequest(requestId);

  const affected = approvedPairsForRequest.all(requestId);
  voidApprovedByRequest.run(requestId);

  const lastRow = lastRowForRequest.get(requestId);
  insertManualDecision.run({
    requestId,
    userId: lastRow?.user_id ?? null,
    username: lastRow?.username ?? 'unknown',
    libraryId: lastRow?.library_id ?? null,
    mediaTitle: lastRow?.media_title ?? null,
    mediaType: lastRow?.media_type ?? 'movie',
    tmdbId: lastRow?.tmdb_id ?? null,
    seasonNumber: lastRow?.season_number ?? null,
    posterUrl: lastRow?.poster_url ?? null,
    balanceBefore: null,
    limitApplied: null,
    decision: 'declined',
  });

  for (const pair of affected) {
    if (pair.user_id != null && pair.library_id != null) {
      await refreshQuotaCache(pair.user_id, pair.library_id);
    }
  }
  res.json({ ok: true, freed: affected.length });
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
  const { botToken, mode, groupChatId, groupTopicId, noQuotaMessage, notifyApproved, notifyFreed } = req.body || {};
  if (typeof botToken === 'string' && botToken.trim() !== '') setBotToken(botToken);
  if (
    mode || groupChatId !== undefined || groupTopicId !== undefined || noQuotaMessage !== undefined ||
    notifyApproved !== undefined || notifyFreed !== undefined
  ) {
    setNotifyTarget({ mode, groupChatId, groupTopicId, noQuotaMessage, notifyApproved, notifyFreed });
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
  const groupMap = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.id, g.name]));
  return summaries.map((summary) => ({
    ...summary,
    username: summary.userId < 0
      ? groupMap.get(-summary.userId) ?? `grupo#${-summary.userId}`
      : userMap.get(summary.userId)?.username ?? summary.link?.label ?? `user#${summary.userId}`,
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

// El body puede traer { target: 'group' | 'dm' } para forzar el destino;
// sin él se usa el modo guardado en ajustes.
router.post('/notifications/pending-summary', ah(async (req, res) => {
  const target = getNotifyTarget();
  const mode = ['group', 'dm'].includes(req.body?.target) ? req.body.target : target.mode;
  const rows = buildPendingSummaryRows();
  // Sin filas no hace falta hidratar (getUsers llama a Tautulli).
  const summaries = rows.length > 0 ? await hydratePendingSummaryUsers(rows) : [];
  const withPending = summaries.filter((s) => s.libraries.length > 0);

  if (mode === 'group') {
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

// Prueba con lo que haya en el formulario (si el body trae chat/topic) para no
// obligar a guardar antes de probar; sin body usa lo guardado.
router.post('/notifications/test-group', async (req, res) => {
  const saved = getNotifyTarget();
  const { groupChatId, groupTopicId } = normalizeGroupTarget(
    req.body?.groupChatId !== undefined ? req.body.groupChatId : saved.groupChatId,
    req.body?.groupTopicId !== undefined ? req.body.groupTopicId : saved.groupTopicId
  );
  if (!groupChatId) return res.status(404).json({ error: 'group_not_configured' });
  try {
    await sendMessage(groupChatId, '✅ limitARR: notificaciones de grupo conectadas correctamente.', { messageThreadId: groupTopicId });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
