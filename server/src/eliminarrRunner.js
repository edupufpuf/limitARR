import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { evaluateRule } from './rules.js';

function parseRule(row) {
  return {
    ...row,
    enabled: Boolean(row.enabled),
    tag_ids: row.tag_ids ? JSON.parse(row.tag_ids) : [],
    conditions: JSON.parse(row.conditions),
    action_options: row.action_options ? JSON.parse(row.action_options) : {},
  };
}

const insertExecution = db.prepare(`
  INSERT INTO eliminarr_executions (rule_id, rule_name, run_id, media_type, external_id, tmdb_id, title, poster_url, matched_conditions, action_taken, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateLastRun = db.prepare("UPDATE eliminarr_rules SET last_run_at = datetime('now'), last_run_summary = ? WHERE id = ?");

// Ejecuta una regla YA armada (dryRun:false), loguea cada ítem afectado en
// eliminarr_executions y actualiza last_run_at/last_run_summary. Usado tanto
// por el scheduler (ciclo automático) como por "Ejecutar ahora" en el panel
// — una sola fuente de verdad para que ambos caminos logueen igual.
export async function runRule(ruleRow) {
  const rule = typeof ruleRow.conditions === 'string' ? parseRule(ruleRow) : ruleRow;
  const { matches } = await evaluateRule(rule, { dryRun: false });
  const runId = randomUUID();
  for (const m of matches) {
    insertExecution.run(rule.id, rule.name, runId, rule.media_type, m.externalId, m.tmdbId, m.title, m.posterUrl, JSON.stringify(m.matchedConditions), m.actionTaken, m.error || null);
  }
  const summary = {
    matched: matches.length,
    deleted: matches.filter((m) => m.actionTaken === 'deleted').length,
    tagged: matches.filter((m) => m.actionTaken === 'tagged').length,
    errors: matches.filter((m) => m.actionTaken === 'error').length,
  };
  updateLastRun.run(JSON.stringify(summary), rule.id);
  return { summary, matches };
}
