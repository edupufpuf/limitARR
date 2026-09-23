import { getRawSetting, setRawSetting } from './settings.js';

const KEY = 'global_pause_enabled';

// Interruptor global: mientras está activo, ninguna solicitud nueva se
// aprueba (ver scheduler.js) — se queda pendiente en Seerr tal cual. Al
// desactivarlo no hace falta reprocesar nada a mano: el siguiente
// runPollCycle (forzado desde la propia ruta PUT) vuelve a evaluar la cola
// con las reglas normales de cupo.
export function isGlobalPauseEnabled() {
  return getRawSetting(KEY) === '1';
}

export function setGlobalPauseEnabled(enabled) {
  setRawSetting(KEY, enabled ? '1' : '0');
}
