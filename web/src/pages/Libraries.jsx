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
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">
          {lib.name} <span className="text-gray-500 text-xs">#{lib.id}</span>
          <span className="ml-2 text-gray-500 text-xs">
            {lib.section_type === 'show' ? 'serie' : 'película'}
          </span>
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
            className="input w-auto py-1"
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
            className="input w-20 py-1"
          />
        </div>
      </div>

      <button
        onClick={save}
        disabled={saving}
        className="btn btn-primary"
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
        <h2 className="page-title">Bibliotecas</h2>
        <button
          onClick={sync}
          disabled={syncing}
          className="btn btn-ghost"
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
