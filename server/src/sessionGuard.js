import { db } from './db.js';

const getRow = db.prepare('SELECT enabled FROM session_guard_settings WHERE user_id = ?');
const upsert = db.prepare(`
  INSERT INTO session_guard_settings (user_id, enabled, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at
`);

// Por defecto activado (pedido de Edu, 2 ago 2026): sin fila = se corta la
// sesión duplicada. Cada usuario puede desactivarlo desde su panel si de
// verdad comparte cuenta a propósito entre dos pantallas a la vez.
export function isSessionGuardEnabled(userId) {
  const row = getRow.get(userId);
  return row ? Boolean(row.enabled) : true;
}

export function setSessionGuardEnabled(userId, enabled) {
  upsert.run(userId, enabled ? 1 : 0);
}
