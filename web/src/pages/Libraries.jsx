import { useEffect, useState } from 'react';
import { api } from '../api.js';

function LibraryCard({ lib, onSaved }) {
  const [kind, setKind] = useState(lib.kind);
  const [enabled, setEnabled] = useState(Boolean(lib.enabled));
  const [defaultLimit, setDefaultLimit] = useState(lib.default_limit);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await api.updateLibrary(lib.id, { kind, enabled, defaultLimit: Number(defaultLimit) });
    setSaving(false);
    onSaved();
  }

  return (
    <div className="bg-bg-800 border border-bg-700 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">
          {lib.name} <span className="text-gray-500 text-xs">#{lib.id}</span>
        </h3>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          activa
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-4 sm:gap-6 mb-4">
        <div>
          <label className="text-xs text-gray-400 mr-2">Tipo</label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="bg-bg-700 border border-bg-600 rounded px-2 py-1 text-sm"
          >
            <option value="standard">standard</option>
            <option value="4k">4k</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 mr-2">Límite de solicitudes sin ver por usuario</label>
          <input
            type="number"
            min={0}
            value={defaultLimit}
            onChange={(e) => setDefaultLimit(e.target.value)}
            className="w-20 bg-bg-700 border border-bg-600 rounded px-2 py-1 text-sm"
          />
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="bg-accent-600 hover:bg-accent-700 rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
      >
        {saving ? 'Guardando…' : 'Guardar'}
      </button>
    </div>
  );
}

export default function Libraries() {
  const [libs, setLibs] = useState([]);
  const [syncing, setSyncing] = useState(false);

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

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-xl font-semibold">Bibliotecas de películas</h2>
        <button
          onClick={sync}
          disabled={syncing}
          className="bg-bg-700 hover:bg-bg-600 border border-bg-600 rounded px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {syncing ? 'Sincronizando…' : 'Sincronizar desde Tautulli'}
        </button>
      </div>
      {libs.map((lib) => (
        <LibraryCard key={lib.id} lib={lib} onSaved={load} />
      ))}
      {libs.length === 0 && (
        <p className="text-gray-500 text-sm">
          Sin bibliotecas configuradas. Pulsa "Sincronizar desde Tautulli" para descubrirlas.
        </p>
      )}
    </div>
  );
}
