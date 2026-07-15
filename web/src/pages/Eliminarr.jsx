import { useState } from 'react';
import EliminarrRules from './EliminarrRules.jsx';
import EliminarrHistory from './EliminarrHistory.jsx';
import EliminarrSettings from './EliminarrSettings.jsx';

const SUBTABS = {
  rules: { label: 'Reglas', Component: EliminarrRules },
  history: { label: 'Historial', Component: EliminarrHistory },
  settings: { label: 'Ajustes', Component: EliminarrSettings },
};

export default function Eliminarr() {
  const [subtab, setSubtab] = useState('rules');
  const { Component } = SUBTABS[subtab];

  return (
    <div>
      <h2 className="page-title mb-1">
        Elimin<span className="text-accent-500">ARR</span>
      </h2>
      <p className="text-xs text-gray-500 mb-6">
        Reglas de borrado automático contra Radarr/Sonarr. Módulo aparte del cupo de solicitudes.
      </p>

      <div className="flex gap-2 mb-6 border-b border-bg-700/60">
        {Object.entries(SUBTABS).map(([key, { label }]) => (
          <button
            key={key}
            onClick={() => setSubtab(key)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors ${
              subtab === key
                ? 'border-accent-500 text-accent-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <Component />
    </div>
  );
}
