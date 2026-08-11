import { Router } from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { needsSetup, setPassword, checkPassword, getWebhookSecret } from '../auth.js';
import { getUsers, getLibraries, searchMedia, getActiveSessions, terminateSession } from '../services/tautulli.js';
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
import {
  resetQuota, importSeerrHistory, backfillWatchedHistory, refreshQuotaCache, dismissPendingItem, undoQuotaAction, addManualCharge, addPenalty,
  getPendingItemDetail, quotaIdentity, getBalance, getRequestHold, setRequestHold, clearRequestHold,
  pruneStaleQuotaCache, setOverride, deleteOverride, setGroupOverride, deleteGroupOverride, setRoleOverride,
  deleteRoleOverride, getMonthlyTotalSettings, setMonthlyTotalSettings, getMonthlyTotalQuota,
  getMonthlyQuotaMode, setMonthlyQuotaMode, getMonthlyHistoryRows, getMonthlyHistoryRowsTotal,
  setMonthlyTotalOverride, deleteMonthlyTotalOverride, setGroupMonthlyTotalOverride, deleteGroupMonthlyTotalOverride,
  setRoleMonthlyTotalOverride, deleteRoleMonthlyTotalOverride,
} from '../quota.js';
import { matchByEmailOrUsername } from '../userMatch.js';
import { runPollCycle } from '../scheduler.js';
import { isSessionGuardEnabled, setSessionGuardEnabled } from '../sessionGuard.js';
import { getVersionInfo } from '../services/version.js';
import { createPlexPin, claimPlexPin, getPlexAccount, testPlexServer } from '../services/plex.js';
import { testRadarrServer } from '../services/radarr.js';
import { testSonarrServer } from '../services/sonarr.js';
import {
  getBotTokenForDisplay,
  setBotToken,
  sendMessage,
  getInboxMessages,
  getNotifyTarget,
  setNotifyTarget,
  normalizeGroupTarget,
  getBotUsername,
  createLinkToken,
  handlePlexNotifyWebhook,
  getAllNotificationTypes,
  getNotificationType,
  setNotificationType,
} from '../services/telegram.js';
import {
  handleMaintainerrWebhook,
  getMaintainerrSettingsForDisplay,
  updateMaintainerrSettings,
  listCollections as listMaintainerrCollections,
  getSalvadosByUser,
  getAllSalvados,
  getSalvadosHistory,
} from '../services/maintainerr.js';
import { getBroadcastSettings, setBroadcastSettings, seenCountFor } from '../services/broadcast.js';

export const router = Router();

// Express 4 no captura rechazos de promesas en handlers async: uno sin try/catch
// (p.ej. Seerr/Tautulli devolviendo un error) tumba el proceso entero (Node 20
// termina el proceso ante un unhandledRejection). Este wrapper lo reenvía al
// error handler de index.js en vez de dejarlo escapar.
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// --- Auth ---

const authRateLimit = rateLimit({ max: 5, windowMs: 15 * 60 * 1000 });
const plexPollRateLimit = rateLimit({ max: 90, windowMs: 5 * 60 * 1000 });

router.post('/auth/setup', authRateLimit, (req, res) => {
  if (!needsSetup()) return res.status(409).json({ error: 'already_configured' });
  const { password } = req.body || {};
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'password_too_short' });
  }
  setPassword(password);
  req.session.authed = true;
  req.session.role = 'admin';
  req.session.user = null;
  res.json({ ok: true });
});

router.post('/auth/login', authRateLimit, (req, res) => {
  if (needsSetup()) return res.status(409).json({ error: 'needs_setup' });
  const { password } = req.body || {};
  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'invalid_password' });
  }
  req.session.authed = true;
  req.session.role = 'admin';
  req.session.user = null;
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

router.get('/auth/me', (req, res) => {
  res.json({
    authed: Boolean(req.session?.authed),
    needsSetup: needsSetup(),
    role: req.session?.authed ? (req.session?.role ?? 'admin') : null,
    user: req.session?.user ?? null,
    impersonating: Boolean(req.session?.impersonating),
  });
});

router.post('/auth/plex/start', authRateLimit, ah(async (req, res) => {
  if (needsSetup()) return res.status(409).json({ error: 'needs_setup' });
  const forwardUrl = `${req.protocol}://${req.get('host')}/?plex=done`;
  const pin = await createPlexPin(forwardUrl);
  req.session.plexPinId = pin.id;
  res.json({ authUrl: pin.authUrl });
}));

router.post('/auth/plex/check', plexPollRateLimit, ah(async (req, res) => {
  const pinId = req.session?.plexPinId;
  if (!pinId) return res.status(400).json({ error: 'plex_flow_missing' });
  const token = await claimPlexPin(pinId);
  if (!token) return res.status(202).json({ pending: true });

  const [account, users] = await Promise.all([getPlexAccount(token), getUsers()]);
  const user = matchByEmailOrUsername(users, account);
  if (!user) {
    req.session.plexPinId = null;
    return res.status(403).json({ error: 'plex_user_not_allowed' });
  }

  const ownerToken = getSettings().plex_token;
  let isAdmin = user.isAdmin;
  if (ownerToken) {
    const owner = await getPlexAccount(ownerToken);
    isAdmin = String(owner.id ?? owner.uuid) === String(account.id ?? account.uuid);
  }

  req.session.authed = true;
  req.session.role = isAdmin ? 'admin' : 'user';
  req.session.user = { id: user.id, username: user.friendlyName || user.username };
  req.session.plexPinId = null;
  res.json({ ok: true, role: req.session.role, user: req.session.user });
}));

// Webhook público de Seerr (sin auth de sesión — lo llama Seerr, no un admin
// logueado). El secreto en la URL es la única protección, ver auth.js. Dispara
// el ciclo de sondeo al momento en vez de esperar hasta 60s; no bloquea la
// respuesta a Seerr ni falla si el ciclo revienta.
router.post('/webhook/seerr/:secret', (req, res) => {
  if (req.params.secret !== getWebhookSecret()) return res.status(404).end();
  res.status(200).end();
  runPollCycle().catch((err) => console.error('[webhook] poll cycle failed:', err));
});

// Webhook público de Maintainerr (mismo esquema que el de Seerr: secreto en URL).
// Se responde al momento; el trabajo (resolver colecciones, avisar por Telegram)
// sigue en background para no hacer esperar a Maintainerr.
router.post('/webhook/maintainerr/:secret', (req, res) => {
  if (req.params.secret !== getWebhookSecret()) return res.status(404).end();
  res.status(200).end();
  handleMaintainerrWebhook(req.body || {}).catch((err) =>
    console.error('[maintainerr] webhook failed:', err)
  );
});

// Webhook público de Tautulli (mismo esquema que Seerr/Maintainerr: secreto en
// la URL, sin auth de sesión). Reenvía el aviso SOLO al chat de Telegram
// vinculado a ese user_id de Plex/Tautulli (ver handlePlexNotifyWebhook) — si
// ese usuario no tiene Telegram vinculado, el aviso se descarta sin caer a
// ningún grupo ni a ningún otro usuario. Se responde al momento; el envío
// sigue en background para no hacer esperar a Tautulli.
router.post('/webhook/tautulli/:secret', (req, res) => {
  if (req.params.secret !== getWebhookSecret()) return res.status(404).end();
  res.status(200).end();
  handlePlexNotifyWebhook(req.body || {}).catch((err) =>
    console.error('[tautulli] webhook failed:', err)
  );
});

router.use(requireAuth);

router.get('/version', ah(async (req, res) => {
  res.json(await getVersionInfo());
}));

// Vista y configuración estrictamente propias para cuentas Plex normales.
router.get('/me/quota', ah(async (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const cacheId = quotaIdentity(req.session.user.id).cacheId;
  const [quotaCards, pendingApprovals] = await Promise.all([
    buildQuotaByUser(),
    buildPendingApprovalItems(),
  ]);
  const card = quotaCards.find((item) => item.userId === cacheId)
    ?? { userId: cacheId, username: req.session.user.username, monthlyTotal: await getMonthlyTotalQuota(cacheId), libraries: [] };
  const ownPending = pendingApprovals.filter((item) => item.userId === Number(req.session.user.id));
  const byLibrary = new Map();
  for (const item of ownPending) {
    if (item.libraryId == null) continue;
    if (!byLibrary.has(item.libraryId)) byLibrary.set(item.libraryId, []);
    byLibrary.get(item.libraryId).push({
      title: item.title,
      mediaType: item.mediaType,
      tmdbId: item.tmdbId,
      seasonNumber: item.seasons?.[0] ?? null,
      posterUrl: item.posterUrl,
      pendingApproval: true,
      requestId: item.requestId,
      requestedAt: item.requestedAt,
    });
  }
  res.json({
    ...card,
    libraries: card.libraries.map((library) => ({
      ...library,
      pendingItems: [...(library.pendingItems ?? []), ...(byLibrary.get(library.libraryId) ?? [])],
    })),
  });
}));

// El usuario puede abrir el mismo detalle visual que el administrador, pero
// solo para una carátula presente en su propia caché de cupo. Los parámetros
// sensibles (ratingKey, tipo, título...) se toman de esa caché, no de la URL.
router.get('/me/quota/pending-detail/:libraryId', ah(async (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const libraryId = Number(req.params.libraryId);
  const cacheId = quotaIdentity(req.session.user.id).cacheId;
  const cached = db.prepare(
    'SELECT pending_items FROM quota_cache WHERE user_id = ? AND library_id = ?'
  ).get(cacheId, libraryId);
  if (!cached) return res.status(404).json({ error: 'pending_not_found' });

  let pendingItems = [];
  try {
    pendingItems = JSON.parse(cached.pending_items || '[]');
  } catch { /* una caché inválida no concede acceso al detalle */ }
  const requestedTmdbId = req.query.tmdbId != null ? Number(req.query.tmdbId) : null;
  const requestedSeason = req.query.seasonNumber != null ? Number(req.query.seasonNumber) : null;
  const requestedTitle = String(req.query.title || '').trim().toLocaleLowerCase('es');
  const item = pendingItems.find((candidate) => {
    if (candidate.pendingApproval) return false;
    const sameSeason = Number(candidate.seasonNumber ?? 0) === Number(requestedSeason ?? 0);
    if (!sameSeason) return false;
    if (requestedTmdbId != null) return Number(candidate.tmdbId) === requestedTmdbId;
    return requestedTitle && String(candidate.title || '').trim().toLocaleLowerCase('es') === requestedTitle;
  });
  if (!item) return res.status(404).json({ error: 'pending_not_found' });

  const detail = await getPendingItemDetail(cacheId, libraryId, {
    tmdbId: item.tmdbId ?? null,
    seasonNumber: item.seasonNumber ?? null,
    title: item.title || '',
    ratingKey: item.ratingKey ?? null,
    mediaType: item.mediaType || 'movie',
    episodesTotal: item.episodesTotal ?? null,
  });
  const settings = getSettings();
  const seerrBase = settings.seerr_public_url || settings.seerr_url;
  const tautulliBase = settings.tautulli_public_url || settings.tautulli_url;
  const seerrUrl = seerrBase && item.tmdbId != null
    ? `${seerrBase}/${item.mediaType === 'tv' ? 'tv' : 'movie'}/${item.tmdbId}`
    : null;
  const tautulliUrl = tautulliBase && item.ratingKey
    ? `${tautulliBase}/info?rating_key=${item.ratingKey}`
    : null;
  // Una cuenta Plex normal ve su propio historial; los visionados de las demás
  // cuentas siguen reservados al panel administrativo.
  const ownUserId = Number(req.session.user.id);
  res.json({
    ...detail,
    watchers: detail.watchers.filter((watcher) => Number(watcher.userId) === ownUserId),
    seerrUrl,
    tautulliUrl,
  });
}));

// Historial de cupo mensual, versión "propia" (panel de usuario no admin) —
// mismo dato que /quota/monthly-history(-total) pero derivando el userId de la
// sesión en vez de la URL, para que no pueda pedir el historial de otro.
router.get('/me/quota/monthly-history/:libraryId', ah(async (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const cacheId = quotaIdentity(req.session.user.id).cacheId;
  res.json(await getMonthlyHistoryRows(cacheId, Number(req.params.libraryId)));
}));

router.get('/me/quota/monthly-history-total', ah(async (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const cacheId = quotaIdentity(req.session.user.id).cacheId;
  res.json(await getMonthlyHistoryRowsTotal(cacheId));
}));

// Películas que este usuario salvó con el botón de Telegram y siguen a tiempo de ver.
router.get('/me/salvados', ah(async (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  res.json(await getSalvadosByUser(Number(req.session.user.id)));
}));

router.get('/me/notifications', (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const link = db.prepare('SELECT chat_id, label, linked_at FROM telegram_links WHERE user_id = ?').get(req.session.user.id);
  res.json(link ?? null);
});


// Vinculación con un click: token de un solo uso que el bot resuelve al
// recibir /start desde el deep link, sin que el usuario copie ningún ID.
router.post('/me/notifications/link-token', ah(async (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const botUsername = await getBotUsername();
  const token = createLinkToken(req.session.user.id);
  res.json({ token, botUsername });
}));

router.put('/me/notifications', (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  const { chatId, label } = req.body || {};
  if (!chatId) return res.status(400).json({ error: 'chatId_required' });
  db.prepare(`
    INSERT INTO telegram_links (user_id, chat_id, label, linked_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (user_id) DO UPDATE SET chat_id=excluded.chat_id, label=excluded.label, linked_at=excluded.linked_at
  `).run(req.session.user.id, String(chatId), label || null);
  res.json({ ok: true });
});

router.delete('/me/notifications', (req, res) => {
  if (!req.session.user?.id) return res.status(403).json({ error: 'plex_user_required' });
  db.prepare('DELETE FROM telegram_links WHERE user_id = ?').run(req.session.user.id);
  res.status(204).end();
});

// Suplantación: el admin ve el panel "Mi cupo" de otro usuario tal cual lo
// vería él, sin necesitar su contraseña de Plex. Ambas viven antes de
// requireAdmin porque, mientras se suplanta, la sesión pasa a role='user'.
// OJO: 'stop' va antes que ':userId' — si no, Express la trataría como un
// userId="stop" (NaN) y nunca se resolvería (fue un bug real en producción).
router.post('/admin/impersonate/stop', (req, res) => {
  if (!req.session.impersonating) return res.status(400).json({ error: 'not_impersonating' });
  req.session.impersonating = false;
  req.session.role = 'admin';
  req.session.user = null;
  res.json({ ok: true });
});

router.post('/admin/impersonate/:userId', ah(async (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'admin_required' });
  const userId = Number(req.params.userId);
  const users = await getUsers();
  const user = users.find((u) => u.id === userId);
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  req.session.impersonating = true;
  req.session.role = 'user';
  req.session.user = { id: user.id, username: user.friendlyName || user.username };
  res.json({ ok: true, role: 'user', user: req.session.user });
}));

router.use(requireAdmin);

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
  const { seerr_url, seerr_api_key, seerr_public_url, tautulli_url, tautulli_api_key, tautulli_public_url, plex_url, plex_token, radarr_url, radarr_api_key, sonarr_url, sonarr_api_key } = req.body || {};
  updateSettings({ seerr_url, seerr_api_key, seerr_public_url, tautulli_url, tautulli_api_key, tautulli_public_url, plex_url, plex_token, radarr_url, radarr_api_key, sonarr_url, sonarr_api_key });
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
    const settings = getSettings();
    await testPlexServer(settings.plex_url, settings.plex_token);
    result.plex = { ok: true };
  } catch (err) {
    result.plex = { ok: false, error: err.message };
  }
  try {
    await listPendingRequests();
    result.seerr = { ok: true };
  } catch (err) {
    result.seerr = { ok: false, error: err.message };
  }
  // Opcional: solo se comprueba si hay algo configurado, para no mostrar un
  // "no configurado" en rojo a quien no usa esta función (radarrLabel en
  // las etiquetas de descarga, ver services/radarr.js).
  if (getSettings().radarr_url) {
    try {
      await testRadarrServer();
      result.radarr = { ok: true };
    } catch (err) {
      result.radarr = { ok: false, error: err.message };
    }
  }
  if (getSettings().sonarr_url) {
    try {
      await testSonarrServer();
      result.sonarr = { ok: true };
    } catch (err) {
      result.sonarr = { ok: false, error: err.message };
    }
  }
  res.json(result);
});

// --- v3: Cupo mensual total (global, todas las bibliotecas combinadas) ---

router.get('/monthly-total-quota/settings', (req, res) => {
  res.json({ mode: getMonthlyQuotaMode(), ...getMonthlyTotalSettings() });
});

router.put('/monthly-total-quota/settings', (req, res) => {
  const { mode, limit } = req.body || {};
  if (mode !== undefined) setMonthlyQuotaMode(mode);
  setMonthlyTotalSettings({ limit });
  res.json({ mode: getMonthlyQuotaMode(), ...getMonthlyTotalSettings() });
});

router.get('/monthly-total-quota/overrides', (req, res) => {
  res.json({
    users: db.prepare('SELECT * FROM monthly_total_overrides').all(),
    groups: db.prepare('SELECT * FROM group_monthly_total_overrides').all(),
    roles: db.prepare('SELECT * FROM role_monthly_total_overrides').all(),
  });
});

router.put('/monthly-total-quota/overrides/user/:userId', (req, res) => {
  const { userId } = req.params;
  const { limitOverride, username } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  setMonthlyTotalOverride(userId, limitOverride, username || null);
  res.json({ ok: true });
});

router.delete('/monthly-total-quota/overrides/user/:userId', (req, res) => {
  deleteMonthlyTotalOverride(req.params.userId, (req.body?.username || '').trim() || null);
  res.json({ ok: true });
});

router.put('/monthly-total-quota/overrides/group/:groupId', (req, res) => {
  const { groupId } = req.params;
  const { limitOverride, groupName } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  setGroupMonthlyTotalOverride(groupId, limitOverride, groupName || null);
  res.json({ ok: true });
});

router.delete('/monthly-total-quota/overrides/group/:groupId', (req, res) => {
  deleteGroupMonthlyTotalOverride(req.params.groupId, (req.body?.groupName || '').trim() || null);
  res.json({ ok: true });
});

router.put('/monthly-total-quota/overrides/role/:roleId', (req, res) => {
  const { roleId } = req.params;
  const { limitOverride, roleName } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  setRoleMonthlyTotalOverride(roleId, limitOverride, roleName || null);
  res.json({ ok: true });
});

router.delete('/monthly-total-quota/overrides/role/:roleId', (req, res) => {
  deleteRoleMonthlyTotalOverride(req.params.roleId, (req.body?.roleName || '').trim() || null);
  res.json({ ok: true });
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

// URL que hay que pegar en Tautulli (Settings > Notification Agents > Add >
// Webhook) para los avisos de eventos de Plex (reproducción, recién
// añadido...) enrutados por usuario. Ver README para el JSON de cada disparador.
router.get('/webhook/tautulli/info', (req, res) => {
  res.json({ url: `http://limitarr:${config.port}/api/webhook/tautulli/${getWebhookSecret()}` });
});

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

// Actualización parcial: dos pestañas distintas tocan esta biblioteca (Bibliotecas
// edita kind/límite/caducidad/series; Cupo solo activa el cupo mensual), así que
// un campo ausente del body conserva el valor ya guardado en vez de borrarse.
router.put('/libraries/:id', ah(async (req, res) => {
  const current = db.prepare('SELECT * FROM libraries WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'not_found' });
  const {
    kind, enabled, defaultLimit, expiryDays, oneSeasonPerRequest, sequentialSeasons,
    monthlyQuotaEnabled, monthlyLimit, salvadoGraceDays,
  } = req.body || {};
  const next = {
    kind: kind ?? current.kind,
    enabled: enabled !== undefined ? (enabled ? 1 : 0) : current.enabled,
    defaultLimit: defaultLimit ?? current.default_limit,
    expiryDays: expiryDays !== undefined ? expiryDays : current.expiry_days,
    oneSeasonPerRequest: oneSeasonPerRequest !== undefined ? (oneSeasonPerRequest ? 1 : 0) : current.one_season_per_request,
    sequentialSeasons: sequentialSeasons !== undefined ? (sequentialSeasons ? 1 : 0) : current.sequential_seasons,
    monthlyQuotaEnabled: monthlyQuotaEnabled !== undefined ? (monthlyQuotaEnabled ? 1 : 0) : current.monthly_quota_enabled,
    monthlyLimit: monthlyLimit ?? current.monthly_limit,
    // NULL = usar el global de la pestaña Salvadas (ver getSalvadoGraceDays en maintainerr.js).
    salvadoGraceDays: salvadoGraceDays !== undefined ? salvadoGraceDays : current.salvado_grace_days,
  };
  const result = db
    .prepare(`
      UPDATE libraries SET kind = ?, enabled = ?, default_limit = ?, expiry_days = ?, one_season_per_request = ?,
        sequential_seasons = ?, monthly_quota_enabled = ?, monthly_limit = ?, salvado_grace_days = ?
      WHERE id = ?
    `)
    .run(
      next.kind, next.enabled, next.defaultLimit, next.expiryDays, next.oneSeasonPerRequest,
      next.sequentialSeasons, next.monthlyQuotaEnabled, next.monthlyLimit, next.salvadoGraceDays, req.params.id
    );
  if (result.changes === 0) return res.status(404).json({ error: 'not_found' });

  if (next.enabled) {
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

// Pedido de Edu (2 ago 2026): solo el admin decide si a un usuario se le
// corta la sesión de Plex duplicada (activado por defecto, ver
// sessionGuard.js) — no es un ajuste que el propio usuario controle.
router.get('/users/:userId/session-guard', (req, res) => {
  res.json({ enabled: isSessionGuardEnabled(Number(req.params.userId)) });
});

router.put('/users/:userId/session-guard', (req, res) => {
  setSessionGuardEnabled(Number(req.params.userId), Boolean(req.body?.enabled));
  res.json({ enabled: isSessionGuardEnabled(Number(req.params.userId)) });
});

// --- Overrides ---

router.get('/overrides', (req, res) => {
  res.json(db.prepare('SELECT * FROM overrides').all());
});

router.put('/overrides/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const { limitOverride, note, expiryOverride, monthlyLimitOverride, username } = req.body || {};
  setOverride(userId, libraryId, { limitOverride, note, expiryOverride, monthlyLimitOverride }, username || null);
  await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true });
}));

router.delete('/overrides/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  deleteOverride(userId, libraryId, (req.body?.username || '').trim() || null);
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
  const monthlyTotalOverrides = db.prepare('SELECT * FROM group_monthly_total_overrides').all();
  res.json(
    groups.map((g) => ({
      ...g,
      members: members.filter((m) => m.group_id === g.id).map((m) => m.user_id),
      overrides: overrides.filter((o) => o.group_id === g.id),
      monthlyTotalOverride: monthlyTotalOverrides.find((o) => o.group_id === g.id) ?? null,
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
  const { limitOverride, expiryOverride, monthlyLimitOverride, groupName } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  setGroupOverride(id, libraryId, { limitOverride, expiryOverride, monthlyLimitOverride }, groupName || null);
  await refreshAffected(groupMemberIds.all(id).map((r) => r.user_id), [libraryId]);
  res.json({ ok: true });
}));

router.delete('/groups/:id/overrides/:libraryId', ah(async (req, res) => {
  const { id, libraryId } = req.params;
  deleteGroupOverride(id, libraryId, (req.body?.groupName || '').trim() || null);
  await refreshAffected(groupMemberIds.all(id).map((r) => r.user_id), [libraryId]);
  res.json({ ok: true });
}));

// --- v2: Roles ---
// Igual patrón que Grupos: un usuario tiene como mucho un rol (user_roles.user_id
// es PK), y el rol da valores de límite/caducidad/cupo mensual por biblioteca que
// se usan como el escalón justo antes del límite de biblioteca (ver quota.js).

const roleExists = db.prepare('SELECT id FROM roles WHERE id = ?');
const roleMemberIds = db.prepare('SELECT user_id FROM user_roles WHERE role_id = ?');
const roleOverrideLibs = db.prepare('SELECT library_id FROM role_overrides WHERE role_id = ?');

router.get('/roles', (req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY name').all();
  const members = db.prepare('SELECT * FROM user_roles').all();
  const overrides = db.prepare('SELECT * FROM role_overrides').all();
  const monthlyTotalOverrides = db.prepare('SELECT * FROM role_monthly_total_overrides').all();
  res.json(
    roles.map((r) => ({
      ...r,
      members: members.filter((m) => m.role_id === r.id).map((m) => m.user_id),
      overrides: overrides.filter((o) => o.role_id === r.id),
      monthlyTotalOverride: monthlyTotalOverrides.find((o) => o.role_id === r.id) ?? null,
    }))
  );
});

router.post('/roles', (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  try {
    const { lastInsertRowid } = db.prepare('INSERT INTO roles (name) VALUES (?)').run(name);
    res.json({ ok: true, id: lastInsertRowid });
  } catch (err) {
    if (/UNIQUE/.test(err.message)) return res.status(409).json({ error: 'name_taken' });
    throw err;
  }
});

router.delete('/roles/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const userIds = roleMemberIds.all(id).map((r) => r.user_id);
  const libraryIds = roleOverrideLibs.all(id).map((r) => r.library_id);
  db.transaction(() => {
    db.prepare('DELETE FROM role_overrides WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(id);
    db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  })();
  await refreshAffected(userIds, libraryIds);
  res.json({ ok: true });
}));

// Reemplaza la lista completa de miembros del rol (como en grupos, asignar a
// otro rol mueve — user_roles.user_id es la PK).
router.put('/roles/:id/members', ah(async (req, res) => {
  const { id } = req.params;
  if (!roleExists.get(id)) return res.status(404).json({ error: 'role_not_found' });
  if (!Array.isArray(req.body?.userIds)) return res.status(400).json({ error: 'userIds_required' });
  const userIds = req.body.userIds.map(Number);

  const before = roleMemberIds.all(id).map((r) => r.user_id);
  db.transaction(() => {
    db.prepare('DELETE FROM user_roles WHERE role_id = ?').run(id);
    const insert = db.prepare(
      'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?) ' +
        'ON CONFLICT (user_id) DO UPDATE SET role_id = excluded.role_id'
    );
    for (const userId of userIds) insert.run(userId, id);
  })();

  const removed = before.filter((u) => !userIds.includes(u));
  const added = userIds.filter((u) => !before.includes(u));
  const libraryIds = roleOverrideLibs.all(id).map((r) => r.library_id);
  await refreshAffected([...added, ...removed], libraryIds);
  res.json({ ok: true });
}));

router.put('/roles/:id/overrides/:libraryId', ah(async (req, res) => {
  const { id, libraryId } = req.params;
  if (!roleExists.get(id)) return res.status(404).json({ error: 'role_not_found' });
  const { limitOverride, expiryOverride, monthlyLimitOverride, roleName } = req.body || {};
  if (limitOverride === undefined) return res.status(400).json({ error: 'limitOverride_required' });
  setRoleOverride(id, libraryId, { limitOverride, expiryOverride, monthlyLimitOverride }, roleName || null);
  await refreshAffected(roleMemberIds.all(id).map((r) => r.user_id), [libraryId]);
  res.json({ ok: true });
}));

router.delete('/roles/:id/overrides/:libraryId', ah(async (req, res) => {
  const { id, libraryId } = req.params;
  deleteRoleOverride(id, libraryId, (req.body?.roleName || '').trim() || null);
  await refreshAffected(roleMemberIds.all(id).map((r) => r.user_id), [libraryId]);
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

  const libraries = db.prepare('SELECT id, name, section_type FROM libraries WHERE enabled = 1').all();
  const libraryMap = new Map(libraries.map((l) => [l.id, l]));
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
  // Total histórico de solicitudes aprobadas por usuario — denominador del
  // "déficit" del círculo destacado del panel (pendiente de ver / pedido).
  const requestedRows = db.prepare(`
    SELECT user_id, COUNT(*) AS requested
    FROM decisions_log
    JOIN libraries l ON l.id = decisions_log.library_id
    WHERE decision = 'approved' AND user_id IS NOT NULL AND l.enabled = 1
    GROUP BY user_id
  `).all();
  const requestedMap = new Map(requestedRows.map((r) => [r.user_id, r.requested]));
  // Pedidas y ya vistas en los últimos 30 días (grid gris en la pestaña Cupo):
  // mismo criterio de "visto" que ya usa el scheduler para loguear 'watched'
  // (issue del caso Seve/Silo) — no 'expired', eso no es "la vio".
  const watchedRows = db.prepare(`
    SELECT user_id, media_title, media_type, tmdb_id, season_number, poster_url, created_at
    FROM decisions_log
    WHERE decision = 'watched' AND created_at >= datetime('now', '-30 days') AND user_id IS NOT NULL
    ORDER BY created_at DESC
  `).all();
  const watchedByUser = new Map();
  for (const r of watchedRows) {
    if (!watchedByUser.has(r.user_id)) watchedByUser.set(r.user_id, []);
    watchedByUser.get(r.user_id).push(r);
  }
  function recentlyWatchedFor(memberIds) {
    return memberIds
      .flatMap((uid) => watchedByUser.get(uid) ?? [])
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .map((r) => ({
        title: r.media_title,
        mediaType: r.media_type,
        seasonNumber: r.season_number,
        tmdbId: r.tmdb_id,
        posterUrl: r.poster_url,
        watchedAt: r.created_at,
      }));
  }
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
          requestedTotal: memberIds.reduce((sum, uid) => sum + (requestedMap.get(uid) ?? 0), 0),
          monthlyTotal: await getMonthlyTotalQuota(row.user_id),
          recentlyWatched: recentlyWatchedFor(memberIds),
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
          requestedTotal: requestedMap.get(row.user_id) ?? 0,
          monthlyTotal: await getMonthlyTotalQuota(row.user_id),
          recentlyWatched: recentlyWatchedFor([row.user_id]),
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
      libraryName: libraryMap.get(row.library_id)?.name ?? `#${row.library_id}`,
      sectionType: libraryMap.get(row.library_id)?.section_type ?? 'movie',
      balance: row.balance,
      limitApplied: row.limit_applied,
      outstanding: row.outstanding,
      pendingItems,
      computedAt: row.computed_at,
      monthly: {
        enabled: Boolean(row.monthly_enabled),
        limit: row.monthly_limit,
        used: row.monthly_used,
      },
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

// Reconstruye en el Registro lo que ya se vio antes de que el scheduler
// empezara a loguear 'watched'/'expired' (21 jul 2026) — con la fecha real de
// Tautulli, no "ahora". Idempotente, pensado para lanzarse tras importar el
// historial de Seerr (así hay filas 'approved' viejas contra las que buscar).
router.post('/quota/backfill-watched-history', ah(async (req, res) => {
  const backfilled = await backfillWatchedHistory();
  res.json({ ok: true, backfilled });
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
  // Aprovecha el recálculo manual para sincronizar con Tautulli: quien ya no
  // sea usuario activo (compartido quitado en Plex) desaparece de la caché.
  const removed = await pruneStaleQuotaCache();
  res.json({ ok: true, users: users.length, libraries: libraries.length, removed });
}));

// Marca como "resueltas" las pendientes actuales de un usuario+biblioteca (no
// cuentan más contra su cupo), y refresca la caché al momento para el panel.
router.post('/quota/reset/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const username = (req.body?.username || '').trim() || null;
  resetQuota(userId, libraryId, username);
  const result = await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true, ...result });
}));

// Quita UN pendiente concreto (película o temporada) del cupo de un usuario
// (sin resetear el resto), identificado por tmdbId+temporada o título.
// Refresca la caché para que el panel lo refleje al momento.
router.post('/quota/dismiss/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const { tmdbId, seasonNumber, title, username } = req.body || {};
  if (tmdbId == null && !title) {
    return res.status(400).json({ error: 'tmdbId_or_title_required' });
  }
  const dismissed = dismissPendingItem(userId, libraryId, { tmdbId, seasonNumber, title }, username || null);
  const result = await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true, dismissed, ...result });
}));

// Pedido de Edu (2 ago 2026): penalizar tras quitar un pendiente del cupo (no
// lo vio) — resta `holes` durante `months` del límite normal o del cupo
// mensual de esa biblioteca (ver addPenalty). Refresca la caché para que el
// panel lo refleje al momento.
router.post('/quota/penalty/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const { kind, holes, months, username } = req.body || {};
  if (kind !== 'normal' && kind !== 'monthly') return res.status(400).json({ error: 'kind_required' });
  if (!holes || !months) return res.status(400).json({ error: 'holes_and_months_required' });
  addPenalty(userId, libraryId, kind, holes, months, username || null);
  const result = await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true, ...result });
}));

// Deshace un "quitar del cupo" o "resetear" desde el Registro (issue de
// jesusgarrigues, 20 jul 2026). Refresca la caché del usuario+biblioteca
// afectados para que el panel de Cupo lo refleje al momento.
router.post('/decisions/:id/undo', ah(async (req, res) => {
  const result = await undoQuotaAction(req.params.id);
  if (!result) return res.status(404).json({ error: 'not_undoable' });
  // libraryId null = override del cupo mensual TOTAL (v3): no vive en
  // quota_cache (se calcula en vivo), así que no hay nada que refrescar aquí.
  if (result.libraryId == null) {
    res.json({ ok: true });
    return;
  }
  // Los de grupo/rol no tienen un único usuario que refrescar — se recalcula
  // el cupo de todos los miembros afectados (igual que al editar el override).
  if (result.kind === 'group') {
    await refreshAffected(groupMemberIds.all(result.groupId).map((r) => r.user_id), [result.libraryId]);
  } else if (result.kind === 'role') {
    await refreshAffected(roleMemberIds.all(result.roleId).map((r) => r.user_id), [result.libraryId]);
  } else {
    await refreshQuotaCache(result.userId, result.libraryId);
  }
  res.json({ ok: true });
}));

// Buscador para el cargo manual: algo que YA está en Plex (vía Tautulli, tu
// propia biblioteca) sin pasar por el título a mano — así el título coincide
// con el de Tautulli al carácter y el visionado se resuelve solo (issue del
// cargo manual de texto libre: si no coincide letra a letra con Tautulli, nunca
// se detecta como vista). El poster se resuelve aparte por tmdbId (guid de Plex
// "tmdb://<id>") consultando solo el catálogo de TMDB vía Seerr — no dice nada
// sobre si se pidió o no en Seerr, así que no hay riesgo de marcarla como no
// disponible por esto.
// mediaType=tv devuelve TEMPORADAS sueltas (no la serie entera) con el mismo
// título "Serie - Temporada N" que usa el resto de la app (ver formatSeasonTitle
// en scheduler.js/quota.js) — el cupo de series se lleva por temporada.
router.get('/media/plex-search', ah(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });

  if (req.query.mediaType === 'tv') {
    const { seasons } = await searchMedia(q);
    const results = await Promise.all(
      seasons.slice(0, 8).map(async (s) => {
        const tmdbGuid = s.guids.find((g) => g.startsWith('tmdb://'));
        const tmdbId = tmdbGuid ? Number(tmdbGuid.slice('tmdb://'.length)) : null;
        const { posterUrl } = tmdbId != null ? await getMediaDetails('tv', tmdbId, s.seasonNumber) : { posterUrl: null };
        return { title: `${s.parentTitle} - Temporada ${s.seasonNumber}`, posterUrl };
      })
    );
    return res.json({ results });
  }

  const { movies } = await searchMedia(q);
  const results = await Promise.all(
    movies.slice(0, 8).map(async (m) => {
      const tmdbGuid = m.guids.find((g) => g.startsWith('tmdb://'));
      const tmdbId = tmdbGuid ? Number(tmdbGuid.slice('tmdb://'.length)) : null;
      const { posterUrl } = tmdbId != null ? await getMediaDetails('movie', tmdbId) : { posterUrl: null };
      return { title: m.title, posterUrl };
    })
  );
  res.json({ results });
}));

// Cargo manual: algo consumido fuera de Seerr (bajado/visto a mano) que aun
// así debe restar cupo. Sin tmdbId no se resuelve solo por visionado — se
// queda contando hasta que caduque por fecha o se quite con el ✕ normal.
router.post('/quota/manual-charge/:userId/:libraryId', ah(async (req, res) => {
  const { userId, libraryId } = req.params;
  const title = (req.body?.title || '').trim();
  const username = (req.body?.username || '').trim() || null;
  const note = (req.body?.note || '').trim() || null;
  const posterUrl = (req.body?.posterUrl || '').trim() || null;
  if (!title) return res.status(400).json({ error: 'title_required' });
  addManualCharge(userId, libraryId, title, username, note, posterUrl);
  const result = await refreshQuotaCache(userId, libraryId);
  res.json({ ok: true, ...result });
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

// Issue #20: historial del cupo mensual (por biblioteca o total, según el modo
// activo) — las mismas filas que ya cuenta getMonthlyApprovedCount(Total), con
// título/fecha para pintarlas en la pestaña Cupo.
router.get('/quota/monthly-history/:userId/:libraryId', ah(async (req, res) => {
  res.json(await getMonthlyHistoryRows(Number(req.params.userId), Number(req.params.libraryId)));
}));

router.get('/quota/monthly-history-total/:userId', ah(async (req, res) => {
  res.json(await getMonthlyHistoryRowsTotal(Number(req.params.userId)));
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
// Deshacer un aprobar/rechazar admin no es solo local: se rechaza/aprueba
// también en Seerr (declineRequest/approveRequest), para que la descarga
// real se cancele/reactive de verdad, no solo el cupo. undo_data se rellena
// aparte (setUndoDataById) tras insertar, cuando ya se sabe el id o los ids.
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
// Ids concretos que va a anular un rechazo — para poder restaurarlos exactos
// si se deshace (approvedPairsForRequest de arriba solo da user/library, no ids).
const approvedIdsForRequest = db.prepare(`
  SELECT id FROM decisions_log WHERE request_id = ? AND decision = 'approved' AND voided_at IS NULL
`);
const setUndoDataById = db.prepare('UPDATE decisions_log SET undo_data = ? WHERE id = ?');
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
async function buildPendingApprovalItems() {
  const [pending, tautulliUsers] = await Promise.all([listPendingRequests(), getUsers()]);
  const items = [];
  for (const request of pending) {
    const sectionType = request.mediaType === 'tv' ? 'show' : 'movie';
    const library = getLibraryForRequestStmt.get(sectionType, request.is4k ? '4k' : 'standard');
    const tautulliUser = matchByEmailOrUsername(tautulliUsers, request.requestedBy || {});
    const seasonNumber = request.seasons[0] ?? null;
    const details = await getMediaDetails(request.mediaType, request.tmdbId, seasonNumber);
    // Issue #16: cacheUserId es la identidad de cupo (el grupo si es agregado),
    // para colgar el pendiente de la tarjeta de usuario correcta del panel.
    const cacheUserId = tautulliUser ? quotaIdentity(tautulliUser.id).cacheId : null;
    const cached = library && cacheUserId != null
      ? getCachedBalance.get(cacheUserId, library.id)
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
      cacheUserId,
      username: tautulliUser?.username ?? request.requestedBy?.username ?? 'unknown',
      requestedAt: request.createdAt ?? null,
      balance: cached?.balance ?? null,
      limit: cached?.limit_applied ?? null,
      // v2: temporizador de aprobación — si el admin aplazó esta solicitud.
      holdUntil: getRequestHold(request.id)?.holdUntil ?? null,
    });
  }
  return items;
}

router.get('/requests/pending-approval', ah(async (req, res) => {
  res.json(await buildPendingApprovalItems());
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
  const insertedIds = [];
  for (const seasonNumber of seasons) {
    if (approvedAlreadyLogged.get(requestId, seasonNumber ?? null)) continue;
    const details = await getMediaDetails(request.mediaType, request.tmdbId, seasonNumber);
    const info = insertManualDecision.run({
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
    insertedIds.push(info.lastInsertRowid);
  }
  // Solo la primera fila lleva undo_data (deshacer anula TODAS las de este
  // clic, ver undoQuotaAction) — así solo sale un botón "deshacer" en el
  // Registro por cada vez que se pulsa Aprobar, no uno por temporada.
  if (insertedIds.length > 0 && library && tautulliUser) {
    setUndoDataById.run(JSON.stringify({ selfIds: insertedIds, requestId }), insertedIds[0]);
  }
  if (library && tautulliUser) await refreshQuotaCache(tautulliUser.id, library.id);
  res.json({ ok: true });
}));

// Rechaza en Seerr. Si la solicitud estaba aprobada y contando (caso "aún no
// disponible" del detalle), sus filas se anulan y el cupo se libera al momento.
router.post('/requests/:id/decline', ah(async (req, res) => {
  const requestId = Number(req.params.id);
  const voidedIds = approvedIdsForRequest.all(requestId).map((r) => r.id);
  const affected = approvedPairsForRequest.all(requestId);
  await declineRequest(requestId);
  voidApprovedByRequest.run(requestId);

  const lastRow = lastRowForRequest.get(requestId);
  const info = insertManualDecision.run({
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
  setUndoDataById.run(JSON.stringify({ requestId, voidedIds }), info.lastInsertRowid);

  for (const pair of affected) {
    if (pair.user_id != null && pair.library_id != null) {
      await refreshQuotaCache(pair.user_id, pair.library_id);
    }
  }
  res.json({ ok: true, freed: affected.length });
}));

// v2: temporizador de aprobación — aplaza ESTA solicitud concreta (acción
// puntual, no una norma general del usuario) hasta dentro de N días; el ciclo
// de sondeo la respeta y la limpia sola al cumplirse el plazo. El contexto
// (userId/libraryId/username/title/posterUrl) es opcional y lo manda el panel
// cuando lo tiene (detalle de un pendiente) — sin él no sale en el Registro
// (p.ej. desde el banner de solicitudes sin usuario emparejado).
router.post('/requests/:id/hold', (req, res) => {
  const days = Number(req.body?.days);
  if (!Number.isFinite(days) || days <= 0) return res.status(400).json({ error: 'days_required' });
  const { userId, libraryId, username, title, posterUrl } = req.body || {};
  setRequestHold(Number(req.params.id), days, { userId, libraryId, username, title, posterUrl });
  res.json({ ok: true, holdUntil: getRequestHold(Number(req.params.id)).holdUntil });
});

router.delete('/requests/:id/hold', (req, res) => {
  const { userId, libraryId, username, title, posterUrl } = req.body || {};
  clearRequestHold(Number(req.params.id), { userId, libraryId, username, title, posterUrl });
  res.json({ ok: true });
});

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
// 'salvado' es una pseudo-decisión: no vive en decisions_log (no tiene
// request_id de Seerr ni afecta al cupo), sale de la tabla salvados y se
// mezcla aquí para que el registro las enseñe juntas ordenadas por fecha.
router.get('/decisions', (req, res) => {
  const { decision, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const includeDecisions = decision !== 'salvado';
  const includeSalvados = !decision || decision === 'salvado';

  const decisionsWhere = [];
  const decisionsParams = [];
  if (decision && decision !== 'salvado') {
    decisionsWhere.push('decision = ?');
    decisionsParams.push(decision);
  }
  if (q) {
    decisionsWhere.push('(username LIKE ? OR media_title LIKE ?)');
    decisionsParams.push(`%${q}%`, `%${q}%`);
  }
  const decisionsWhereSql = decisionsWhere.length ? `WHERE ${decisionsWhere.join(' AND ')}` : '';

  const salvadosWhere = [];
  const salvadosParams = [];
  if (q) {
    salvadosWhere.push('(telegram_name LIKE ? OR title LIKE ?)');
    salvadosParams.push(`%${q}%`, `%${q}%`);
  }
  const salvadosWhereSql = salvadosWhere.length ? `WHERE ${salvadosWhere.join(' AND ')}` : '';

  // undoable: tiene undo_data guardado, no el propio decision (p.ej. 'approved'
  // vale tanto para una aprobación normal de Seerr -sin undo_data- como para un
  // cargo manual o una aprobación admin -con undo_data-, ver undoQuotaAction).
  const decisionsSelect = `SELECT id, created_at, username, media_title, poster_url, balance_before, limit_applied, decision, note, undone_at, (undo_data IS NOT NULL) AS undoable FROM decisions_log ${decisionsWhereSql}`;
  const salvadosSelect = `SELECT id, saved_at AS created_at, telegram_name AS username, title AS media_title, poster_url, NULL AS balance_before, NULL AS limit_applied, 'salvado' AS decision, NULL AS note, NULL AS undone_at, 0 AS undoable FROM salvados ${salvadosWhereSql}`;

  let unionSql;
  let unionParams;
  let countSql;
  let countParams;
  if (includeDecisions && includeSalvados) {
    unionSql = `${decisionsSelect} UNION ALL ${salvadosSelect}`;
    unionParams = [...decisionsParams, ...salvadosParams];
    countSql = `SELECT (SELECT COUNT(*) FROM decisions_log ${decisionsWhereSql}) + (SELECT COUNT(*) FROM salvados ${salvadosWhereSql}) AS total`;
    countParams = [...decisionsParams, ...salvadosParams];
  } else if (includeSalvados) {
    unionSql = salvadosSelect;
    unionParams = salvadosParams;
    countSql = `SELECT COUNT(*) AS total FROM salvados ${salvadosWhereSql}`;
    countParams = salvadosParams;
  } else {
    unionSql = decisionsSelect;
    unionParams = decisionsParams;
    countSql = `SELECT COUNT(*) AS total FROM decisions_log ${decisionsWhereSql}`;
    countParams = decisionsParams;
  }

  const { total } = db.prepare(countSql).get(...countParams);
  const rows = db
    .prepare(`SELECT * FROM (${unionSql}) ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...unionParams, limit, offset);
  res.json({ rows, total });
});

// --- Telegram notifications ---

// --- Módulo Maintainerr (admin) ---

router.get('/maintainerr/settings', (req, res) => {
  res.json({
    ...getMaintainerrSettingsForDisplay(),
    webhookUrl: `http://limitarr:${config.port}/api/webhook/maintainerr/${getWebhookSecret()}`,
  });
});

router.put('/maintainerr/settings', (req, res) => {
  const { url, botToken, chatId, topicId, pairs, silent, savedMessage, deleteMessage, deleteMessageTv, salvadoGraceDays } = req.body || {};
  updateMaintainerrSettings({ url, botToken, chatId, topicId, pairs, silent, savedMessage, deleteMessage, deleteMessageTv, salvadoGraceDays });
  res.json(getMaintainerrSettingsForDisplay());
});

// Prueba de conexión: lista las colecciones de Maintainerr para verificar URL
// y para que el panel arme los selects de "colección origen → colección salvados".
router.post('/maintainerr/test', ah(async (req, res) => {
  const collections = await listMaintainerrCollections();
  res.json({
    ok: true,
    collections: collections.map((c) => ({
      id: c.id,
      title: c.title,
      type: c.type,
      libraryId: c.libraryId,
      deleteAfterDays: c.deleteAfterDays,
    })),
  });
}));

// Salvadas vivas de todos los usuarios, para colgarlas de las tarjetas de la
// pestaña Cupo (agrupa el cliente por user_id / telegram_name).
router.get('/salvados', ah(async (req, res) => {
  res.json(await getAllSalvados());
}));

// Historial 30 días (o los que pida ?days=) para la pestaña Salvadas: activas
// y ya resueltas, con watched_at por fila para pintar "vista"/"pendiente".
router.get('/salvados/history', (req, res) => {
  const days = Number(req.query.days);
  res.json(getSalvadosHistory(Number.isFinite(days) && days > 0 ? days : 30));
});

router.get('/notifications/settings', (req, res) => {
  res.json({ ...getBotTokenForDisplay(), ...getNotifyTarget() });
});

// Aviso general en pantalla (terminate_session con mensaje, ver
// enforceBroadcast en scheduler.js): pensado para empujar a quien todavía no
// ha vinculado Telegram a que entre en el panel y lo haga. seenCount es
// informativo, para que el admin vea si ya está calando sin tener que mirar
// la tabla a mano.
router.get('/notifications/broadcast', (req, res) => {
  const settings = getBroadcastSettings();
  res.json({ ...settings, seenCount: seenCountFor(settings.message) });
});

router.put('/notifications/broadcast', (req, res) => {
  const { enabled, message } = req.body || {};
  setBroadcastSettings({ enabled, message });
  const settings = getBroadcastSettings();
  res.json({ ...settings, seenCount: seenCountFor(settings.message) });
});

// Prueba manual: corta SOLO la sesión activa del propio admin (buscada por el
// flag is_admin de Tautulli, nunca por lo que escriba el body) con el mensaje
// ya guardado — para ver cómo queda el pop-up en Plex sin esperar a que
// alguien sin vincular se ponga a ver algo. No toca la sesión de nadie más.
router.post('/notifications/broadcast/test', ah(async (req, res) => {
  const { message } = getBroadcastSettings();
  if (!message) return res.status(400).json({ error: 'message_required' });

  const [users, sessions] = await Promise.all([getUsers(), getActiveSessions()]);
  const adminIds = new Set(users.filter((u) => u.isAdmin).map((u) => u.id));
  const session = sessions.find((s) => adminIds.has(s.userId));
  if (!session) return res.status(404).json({ error: 'no_active_admin_session' });

  await terminateSession(session.sessionKey, message);
  res.json({ ok: true });
}));

router.put('/notifications/settings', (req, res) => {
  const { botToken, mode, groupChatId, groupTopicId, noQuotaMessage, notifyNoQuota, notifyApproved, notifyFreed } = req.body || {};
  if (typeof botToken === 'string' && botToken.trim() !== '') setBotToken(botToken);
  if (
    mode || groupChatId !== undefined || groupTopicId !== undefined || noQuotaMessage !== undefined ||
    notifyNoQuota !== undefined || notifyApproved !== undefined || notifyFreed !== undefined
  ) {
    setNotifyTarget({ mode, groupChatId, groupTopicId, noQuotaMessage, notifyNoQuota, notifyApproved, notifyFreed });
  }
  res.json({ ...getBotTokenForDisplay(), ...getNotifyTarget() });
});

// Catálogo unificado de avisos automáticos (ver NOTIFICATION_TYPES en
// telegram.js): cada uno con su propio toggle y texto editable, todos con la
// misma forma en vez de que cada aviso tenga su propio mecanismo.
router.get('/notifications/types', (req, res) => {
  res.json(getAllNotificationTypes());
});

router.put('/notifications/types/:id', (req, res) => {
  if (!getNotificationType(req.params.id)) return res.status(404).json({ error: 'unknown_type' });
  const { enabled, message } = req.body || {};
  setNotificationType(req.params.id, { enabled, message });
  res.json(getNotificationType(req.params.id));
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

  // A TODOS los vinculados, no solo a quien tiene pendientes (antes se
  // saltaba en silencio a quien no tenía nada, y el contador de "enviados"
  // solo reflejaba esa minoría — Edu lo leía como que "no detectaba a los
  // demás usuarios" cuando en realidad ni se les intentaba mandar nada).
  const summaryByUser = new Map(withPending.map((s) => [s.userId, s]));
  const links = db.prepare('SELECT user_id, chat_id FROM telegram_links').all();
  let messages = 0;
  let withPendingCount = 0;
  for (const link of links) {
    const summary = summaryByUser.get(link.user_id);
    const text = summary
      ? formatPendingSummaryForUser(summary, { personal: true })
      : '📋 Nada pendiente de ver ahora mismo.';
    for (const chunk of chunkTelegramText(text)) {
      await sendMessage(link.chat_id, chunk);
      messages += 1;
    }
    if (summary) withPendingCount += 1;
  }
  res.json({ ok: true, mode: 'dm', users: links.length, withPending: withPendingCount, messages });
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
