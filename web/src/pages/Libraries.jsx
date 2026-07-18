import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDirty } from '../DirtyGuard.jsx';

// Ajuste global de verdad (no por biblioteca): el % de episodios para dar una
// temporada por vista aplica igual a todas las bibliotecas de series. Vive
// arriba del todo, separado de las tarjetas por biblioteca de abajo.
function GlobalSettings() {
  const [percent, setPercent] = useState('');
  const [savedPercent, setSavedPercent] = useState('');
  const [saving, setSaving] = useState(false);

  function load() {
    api.settings().then((s) => {
      setPercent(s.tv_season_watched_percent ?? '');
      setSavedPercent(s.tv_season_watched_percent ?? '');
    });
  }

  useEffect(load, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    await api.updateSettings({ tv_season_watched_percent: percent });
    load();
    setSaving(false);
  }

  return (
    <div className="card p-4 mb-6">
      <h3 className="text-sm font-semibold text-accent-400 mb-3">Ajustes</h3>
      <form onSubmit={save} className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-gray-400 mr-2 block mb-1">
            % de episodios para dar una temporada por completada
          </label>
          <input
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            placeholder="85 — vacío = valor por defecto"
            inputMode="numeric"
            className="input w-40"
          />
        </div>
        {percent !== savedPercent && (
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        )}
      </form>
      <p className="text-xs text-gray-500 mt-2">
        Una temporada libera cupo cuando este % de sus episodios está visto (al 85% cada uno, umbral
        de Tautulli). 100 exige verla entera. Aplica a todas las bibliotecas de series.
      </p>
    </div>
  );
}

function LibraryCard({ lib, expanded, onToggle, onSaved }) {
  const [kind, setKind] = useState(lib.kind);
  const [enabled, setEnabled] = useState(Boolean(lib.enabled));
  const [defaultLimit, setDefaultLimit] = useState(lib.default_limit);
  const [expiryEnabled, setExpiryEnabled] = useState(lib.expiry_days !== 0);
  const [expiryDays, setExpiryDays] = useState(lib.expiry_days > 0 ? lib.expiry_days : '');
  const [monthlyEnabled, setMonthlyEnabled] = useState(Boolean(lib.monthly_quota_enabled));
  const [monthlyLimit, setMonthlyLimit] = useState(lib.monthly_limit);
  const [oneSeasonPerRequest, setOneSeasonPerRequest] = useState(Boolean(lib.one_season_per_request));
  const [sequentialSeasons, setSequentialSeasons] = useState(Boolean(lib.sequential_seasons));
  const [saving, setSaving] = useState(false);

  const dirty =
    kind !== lib.kind ||
    enabled !== Boolean(lib.enabled) ||
    Number(defaultLimit) !== lib.default_limit ||
    expiryEnabled !== (lib.expiry_days !== 0) ||
    (expiryEnabled && Number(expiryDays || 0) !== (lib.expiry_days > 0 ? lib.expiry_days : 0)) ||
    monthlyEnabled !== Boolean(lib.monthly_quota_enabled) ||
    Number(monthlyLimit) !== lib.monthly_limit ||
    oneSeasonPerRequest !== Boolean(lib.one_season_per_request) ||
    sequentialSeasons !== Boolean(lib.sequential_seasons);
  useDirty(`library-${lib.id}`, dirty);

  async function save() {
    setSaving(true);
    await api.updateLibrary(lib.id, {
      kind,
      enabled,
      defaultLimit: Number(defaultLimit),
      expiryDays: !expiryEnabled ? 0 : expiryDays === '' ? null : Number(expiryDays),
      monthlyQuotaEnabled: monthlyEnabled,
      monthlyLimit: Number(monthlyLimit),
      oneSeasonPerRequest,
      sequentialSeasons,
    });
    setSaving(false);
    onSaved();
  }

  return (
    <div className="card overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-bg-700/40 transition-colors"
      >
        <h3 className="font-semibold">
          {lib.name} <span className="text-gray-500 text-xs">#{lib.id}</span>
          <span className="ml-2 text-gray-500 text-xs">
            {lib.section_type === 'show' ? 'serie' : 'película'}
          </span>
          {!enabled && (
            <span className="ml-2 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-700 text-gray-500 align-middle">
              desactivada
            </span>
          )}
        </h3>
        <span className="text-gray-500 text-xs flex-shrink-0">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4">
      <label className="flex items-center gap-1 text-sm mb-3">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        activa
      </label>

      <div className="flex flex-wrap items-center gap-4 mb-4">
        <div>
          <label className="text-xs text-gray-400 mr-2 block mb-1">Tipo</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className="input w-auto py-1">
            <option value="standard">standard</option>
            <option value="4k">4k</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 mr-2 block mb-1">Límite sin ver por usuario</label>
          <input
            type="number"
            min={0}
            value={defaultLimit}
            onChange={(e) => setDefaultLimit(e.target.value)}
            className="input w-20 py-1"
          />
        </div>
      </div>

      <div className="border-t border-bg-700 pt-3 mb-1">
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={expiryEnabled}
            onChange={(e) => setExpiryEnabled(e.target.checked)}
            className="accent-accent-500"
          />
          <span className="text-sm font-medium">Caducidad</span>
          {expiryEnabled && (
            <input
              type="number"
              min={1}
              value={expiryDays}
              onChange={(e) => setExpiryDays(e.target.value)}
              placeholder="30"
              className="input w-16 py-1 ml-1"
              title="Días sin ver hasta que el pendiente sale del cupo"
            />
          )}
        </label>
        <p className="text-xs text-gray-500">
          Pasados estos días sin verse, el pendiente sale del cupo. Desmarca para que nunca caduque.
        </p>
      </div>

      <div className="border-t border-bg-700 pt-3 mb-1">
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={monthlyEnabled}
            onChange={(e) => setMonthlyEnabled(e.target.checked)}
            className="accent-accent-500"
          />
          <span className="text-sm font-medium">Cupo mensual</span>
          {monthlyEnabled && (
            <input
              type="number"
              min={0}
              value={monthlyLimit}
              onChange={(e) => setMonthlyLimit(e.target.value)}
              className="input w-16 py-1 ml-1"
              title="Cosas aprobadas por mes"
            />
          )}
        </label>
        <p className="text-xs text-gray-500">
          Tope de cosas aprobadas al mes, aunque se vean. Desactivado por defecto.
        </p>
      </div>

      {lib.section_type === 'show' && (
        <div className="border-t border-bg-700 pt-3 mt-3">
          <label className="flex items-start gap-2 mb-3 cursor-pointer">
            <input
              type="checkbox"
              checked={oneSeasonPerRequest}
              onChange={(e) => setOneSeasonPerRequest(e.target.checked)}
              className="mt-0.5 accent-accent-500"
            />
            <span className="text-xs text-gray-400">
              <span className="text-gray-200 font-medium">Solo una temporada por solicitud</span> — una
              solicitud con varias temporadas de golpe se rechaza en Seerr automáticamente (con aviso
              por Telegram): hay que pedirlas de una en una.
            </span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={sequentialSeasons}
              onChange={(e) => setSequentialSeasons(e.target.checked)}
              className="mt-0.5 accent-accent-500"
            />
            <span className="text-xs text-gray-400">
              <span className="text-gray-200 font-medium">Temporadas en orden</span> — un usuario solo
              puede tener sin ver una temporada de cada serie: las siguientes esperan en Seerr (en
              cola, con aviso) y se aprueban solas al terminar la anterior. Se aprueba siempre la
              temporada más baja primero. Implica "solo una temporada por solicitud".
            </span>
          </label>
        </div>
      )}

          <button onClick={save} disabled={saving} className="btn btn-primary mt-4">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function Libraries() {
  const [libs, setLibs] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  function load() {
    api.libraries().then(setLibs);
  }

  useEffect(load, []);

  async function sync() {
    setSyncing(true);
    await api.syncLibraries();
    load();
    setSyncing(false);
  }

  function toggle(id) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="page-title">Bibliotecas</h2>
        <button onClick={sync} disabled={syncing} className="btn btn-ghost">
          {syncing ? 'Sincronizando…' : 'Sincronizar desde Tautulli'}
        </button>
      </div>

      <GlobalSettings />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {libs.map((lib) => (
          <LibraryCard
            key={lib.id}
            lib={lib}
            expanded={expanded.has(lib.id)}
            onToggle={() => toggle(lib.id)}
            onSaved={load}
          />
        ))}
      </div>
      {libs.length === 0 && (
        <p className="text-gray-500 text-sm">
          Sin bibliotecas configuradas. Pulsa "Sincronizar desde Tautulli" para descubrirlas.
        </p>
      )}
    </div>
  );
}
