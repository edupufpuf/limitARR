import { config } from './config.js';
import { db } from './db.js';
import { runRule } from './eliminarrRunner.js';

// Segundo setInterval, hermano de scheduler.js (no anidado): evaluar borrados
// contra Radarr/Sonarr es un concern independiente del sondeo de Seerr, con
// una cadencia natural mucho más lenta (ver config.eliminarrIntervalMs).
async function runEliminarrCycle() {
  const rules = db.prepare('SELECT * FROM eliminarr_rules WHERE enabled = 1').all();
  for (const row of rules) {
    try {
      await runRule(row);
    } catch (err) {
      console.error(`[eliminarr] regla "${row.name}" (#${row.id}) falló:`, err.message);
    }
  }
}

export function startEliminarrScheduler() {
  runEliminarrCycle().catch((err) => console.error('[eliminarr] ciclo inicial falló:', err));
  setInterval(() => {
    runEliminarrCycle().catch((err) => console.error('[eliminarr] ciclo falló:', err));
  }, config.eliminarrIntervalMs);
}
