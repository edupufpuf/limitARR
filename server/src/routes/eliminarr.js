import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getRawSetting, setRawSetting } from '../settings.js';
import { sendMessage } from '../services/telegram.js';
import * as radarr from '../services/radarr.js';
import * as sonarr from '../services/sonarr.js';
import { evaluateRule } from '../rules.js';
import { runRule } from '../eliminarrRunner.js';

export const router = Router();

// Express 4 no captura rechazos de promesas en handlers async (ver api.js).
const ah = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Módulo entero admin-only: es una función de riesgo de pérdida de datos, y
// los usuarios normales (UserDashboard.jsx) nunca ven esta ruta.
router.use(requireAuth, requireAdmin);

function parseRule(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    tag_ids: row.tag_ids ? JSON.parse(row.tag_ids) : [],
    conditions: JSON.parse(row.conditions),
    action_options: row.action_options ? JSON.parse(row.action_options) : {},
    last_run_summary: row.last_run_summary ? JSON.parse(row.last_run_summary) : null,
  };
}

function validateRuleBody(body) {
  const { name, media_type, tag_ids, condition_logic, conditions, action, action_options } = body || {};
  if (!name || typeof name !== 'string') throw Object.assign(new Error('name requerido'), { status: 400 });
  if (!['movie', 'show'].includes(media_type)) throw Object.assign(new Error('media_type inválido'), { status: 400 });
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw Object.assign(new Error('conditions requerido'), { status: 400 });
  }
  if (!['delete', 'tag_notify'].includes(action)) throw Object.assign(new Error('action inválida'), { status: 400 });
  return {
    name,
    media_type,
    tag_ids: Array.isArray(tag_ids) ? tag_ids : [],
    condition_logic: condition_logic === 'any' ? 'any' : 'all',
    conditions,
    action,
    action_options: action_options || {},
  };
}

// --- Reglas ---

router.get('/rules', (req, res) => {
  const rows = db.prepare('SELECT * FROM eliminarr_rules ORDER BY created_at DESC').all();
  res.json(rows.map(parseRule));
});

router.post('/rules', ah(async (req, res) => {
  const rule = validateRuleBody(req.body);
  // Ninguna regla nace armada: "armar" es un PUT explícito posterior.
  const result = db
    .prepare(`
      INSERT INTO eliminarr_rules (name, media_type, enabled, tag_ids, condition_logic, conditions, action, action_options)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?)
    `)
    .run(rule.name, rule.media_type, JSON.stringify(rule.tag_ids), rule.condition_logic, JSON.stringify(rule.conditions), rule.action, JSON.stringify(rule.action_options));
  const row = db.prepare('SELECT * FROM eliminarr_rules WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(parseRule(row));
}));

router.put('/rules/:id', ah(async (req, res) => {
  const existing = db.prepare('SELECT * FROM eliminarr_rules WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'rule_not_found' });

  // Toggle de "armar/desarmar": único campo que se puede tocar sin reenviar
  // la regla entera, para el switch de la tarjeta.
  if (Object.keys(req.body || {}).length === 1 && typeof req.body.enabled === 'boolean') {
    db.prepare('UPDATE eliminarr_rules SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(req.body.enabled ? 1 : 0, req.params.id);
  } else {
    const rule = validateRuleBody(req.body);
    db.prepare(`
      UPDATE eliminarr_rules
      SET name = ?, media_type = ?, tag_ids = ?, condition_logic = ?, conditions = ?, action = ?, action_options = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(rule.name, rule.media_type, JSON.stringify(rule.tag_ids), rule.condition_logic, JSON.stringify(rule.conditions), rule.action, JSON.stringify(rule.action_options), req.params.id);
  }
  const row = db.prepare('SELECT * FROM eliminarr_rules WHERE id = ?').get(req.params.id);
  res.json(parseRule(row));
}));

router.delete('/rules/:id', (req, res) => {
  db.prepare('DELETE FROM eliminarr_rules WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

// Vista previa de una regla ya guardada: nunca borra, nunca escribe en eliminarr_executions.
router.post('/rules/:id/preview', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM eliminarr_rules WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'rule_not_found' });
  const { matches } = await evaluateRule(parseRule(row), { dryRun: true });
  res.json({ matches });
}));

// Vista previa de un borrador sin guardar todavía.
router.post('/rules/preview', ah(async (req, res) => {
  const rule = validateRuleBody(req.body);
  const { matches } = await evaluateRule(rule, { dryRun: true });
  res.json({ matches });
}));

// Tags de Radarr/Sonarr, para el selector de scope al crear/editar una regla.
router.get('/tags', ah(async (req, res) => {
  const mediaType = req.query.media_type === 'show' ? 'show' : 'movie';
  const tags = mediaType === 'show' ? await sonarr.listTags() : await radarr.listTags();
  res.json(tags);
}));

// --- Historial ---

router.get('/history', (req, res) => {
  const { rule_id, action_taken, q } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = [];
  const params = [];
  if (rule_id) {
    where.push('rule_id = ?');
    params.push(rule_id);
  }
  if (action_taken) {
    where.push('action_taken = ?');
    params.push(action_taken);
  }
  if (q) {
    where.push('(title LIKE ? OR rule_name LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM eliminarr_executions ${whereSql}`)
    .get(...params);
  const rows = db
    .prepare(`SELECT * FROM eliminarr_executions ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);
  res.json({
    rows: rows.map((r) => ({ ...r, matched_conditions: r.matched_conditions ? JSON.parse(r.matched_conditions) : [] })),
    total,
  });
});

// --- Ajustes (Radarr/Sonarr/Telegram propio de Eliminarr) ---

router.get('/settings', (req, res) => {
  res.json({
    radarr: radarr.getSettingsForDisplay(),
    sonarr: sonarr.getSettingsForDisplay(),
    telegram: {
      chatId: getRawSetting('eliminarr_telegram_chat_id'),
      topicId: getRawSetting('eliminarr_telegram_topic_id'),
    },
  });
});

router.put('/settings', (req, res) => {
  const { radarr: radarrBody, sonarr: sonarrBody, telegram } = req.body || {};
  if (radarrBody) radarr.setConnectionSettings(radarrBody);
  if (sonarrBody) sonarr.setConnectionSettings(sonarrBody);
  if (telegram) {
    if (typeof telegram.chatId === 'string') {
      telegram.chatId.trim() === ''
        ? db.prepare("DELETE FROM settings WHERE key = 'eliminarr_telegram_chat_id'").run()
        : setRawSetting('eliminarr_telegram_chat_id', telegram.chatId.trim());
    }
    if (typeof telegram.topicId === 'string') {
      telegram.topicId.trim() === ''
        ? db.prepare("DELETE FROM settings WHERE key = 'eliminarr_telegram_topic_id'").run()
        : setRawSetting('eliminarr_telegram_topic_id', telegram.topicId.trim());
    }
  }
  res.json({
    radarr: radarr.getSettingsForDisplay(),
    sonarr: sonarr.getSettingsForDisplay(),
    telegram: {
      chatId: getRawSetting('eliminarr_telegram_chat_id'),
      topicId: getRawSetting('eliminarr_telegram_topic_id'),
    },
  });
});

router.post('/settings/test', async (req, res) => {
  const result = {};
  try {
    await radarr.ping();
    result.radarr = { ok: true };
  } catch (err) {
    result.radarr = { ok: false, error: err.message };
  }
  try {
    await sonarr.ping();
    result.sonarr = { ok: true };
  } catch (err) {
    result.sonarr = { ok: false, error: err.message };
  }
  const chatId = getRawSetting('eliminarr_telegram_chat_id');
  if (chatId) {
    try {
      const topicId = getRawSetting('eliminarr_telegram_topic_id');
      await sendMessage(chatId, '✅ Eliminarr: avisos conectados correctamente.', {
        messageThreadId: topicId ? Number(topicId) : undefined,
      });
      result.telegram = { ok: true };
    } catch (err) {
      result.telegram = { ok: false, error: err.message };
    }
  }
  res.json(result);
});

// Ejecuta una regla YA armada fuera de ciclo, para probarla al momento sin
// esperar al scheduler. runRule() es la misma función que usa el ciclo
// automático, así que respeta el mismo candado: si no está enabled=1 no se
// ejecuta, y loguea en eliminarr_executions exactamente igual.
router.post('/rules/:id/run-now', ah(async (req, res) => {
  const row = db.prepare('SELECT * FROM eliminarr_rules WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'rule_not_found' });
  const rule = parseRule(row);
  if (!rule.enabled) return res.status(409).json({ error: 'rule_not_armed' });
  const result = await runRule(rule);
  res.json(result);
}));
