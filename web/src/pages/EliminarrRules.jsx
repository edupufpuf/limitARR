import { useEffect, useState } from 'react';
import { api } from '../api.js';

const CONDITION_META = {
  not_watched_days: {
    label: 'Sin ver desde hace más de…',
    unit: 'días',
    field: 'days',
    default: 60,
    hint: 'Una reproducción antigua cuenta como "visto hace tiempo" — si nunca se vio, también cumple.',
  },
  never_watched_added_days: {
    label: 'Añadida hace más de…',
    unit: 'días, y jamás vista',
    field: 'days',
    default: 365,
    hint: 'Exige cero reproducciones jamás. Una vista hace años no cumple esta condición.',
  },
  file_size_over_gb: {
    label: 'Ocupa más de…',
    unit: 'GB en disco',
    field: 'gb',
    default: 15,
    hint: 'No consulta Tautulli — solo el tamaño en Radarr/Sonarr.',
  },
};

function emptyConditionState() {
  return Object.fromEntries(
    Object.entries(CONDITION_META).map(([type, meta]) => [type, { enabled: false, value: meta.default }])
  );
}

function conditionsToArray(state) {
  return Object.entries(state)
    .filter(([, c]) => c.enabled)
    .map(([type, c]) => ({ type, [CONDITION_META[type].field]: Number(c.value) }));
}

function MatchList({ matches }) {
  if (matches.length === 0) {
    return <p className="text-xs text-gray-500 mt-3">Ningún ítem cumple las condiciones ahora mismo.</p>;
  }
  return (
    <div className="mt-3 space-y-1.5 max-h-64 overflow-y-auto">
      <p className="text-xs text-gray-500 mb-1">{matches.length} ítem(s) afectados:</p>
      {matches.map((m) => (
        <div key={m.externalId} className="flex items-center gap-2 text-xs bg-bg-900/40 rounded-lg px-2.5 py-1.5">
          {m.posterUrl && <img src={m.posterUrl} alt="" className="w-5 h-7 object-cover rounded flex-shrink-0" />}
          <span className="flex-1 truncate">{m.title}</span>
          <span className="text-gray-500 tabular-nums">{(m.sizeOnDisk / 1024 ** 3).toFixed(1)} GB</span>
        </div>
      ))}
    </div>
  );
}

function RuleForm({ onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [mediaType, setMediaType] = useState('movie');
  const [tags, setTags] = useState([]);
  const [tagIds, setTagIds] = useState([]);
  const [conditionLogic, setConditionLogic] = useState('all');
  const [conditions, setConditions] = useState(emptyConditionState());
  const [action, setAction] = useState('delete');
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [tagLabel, setTagLabel] = useState('eliminarr-candidato');
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setTagIds([]);
    api.eliminarrTags(mediaType).then(setTags).catch(() => setTags([]));
  }, [mediaType]);

  function buildBody() {
    return {
      name,
      media_type: mediaType,
      tag_ids: tagIds,
      condition_logic: conditionLogic,
      conditions: conditionsToArray(conditions),
      action,
      action_options: action === 'delete' ? { deleteFiles } : { tagLabel },
    };
  }

  async function preview() {
    setError(null);
    setPreviewing(true);
    try {
      const { matches } = await api.previewEliminarrDraft(buildBody());
      setPreviewResult(matches);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreviewing(false);
    }
  }

  async function create() {
    setError(null);
    if (conditionsToArray(conditions).length === 0) {
      setError('Activa al menos una condición.');
      return;
    }
    setSaving(true);
    try {
      await api.createEliminarrRule(buildBody());
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card p-4 mb-4 space-y-4">
      <div>
        <label className="label">Nombre</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Películas sin ver, 90 días" className="input" />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div>
          <label className="text-xs text-gray-400 mr-2">Tipo</label>
          <select value={mediaType} onChange={(e) => setMediaType(e.target.value)} className="input w-auto py-1">
            <option value="movie">películas (Radarr)</option>
            <option value="show">series (Sonarr)</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-400 mr-2">Coincidencia</label>
          <select value={conditionLogic} onChange={(e) => setConditionLogic(e.target.value)} className="input w-auto py-1">
            <option value="all">todas las condiciones</option>
            <option value="any">cualquier condición</option>
          </select>
        </div>
      </div>

      <div>
        <label className="text-xs text-gray-400">
          Etiquetas ({mediaType === 'show' ? 'Sonarr' : 'Radarr'}) — vacío = todo el catálogo
        </label>
        <div className="flex flex-wrap gap-2 mt-1.5">
          {tags.length === 0 && <span className="text-xs text-gray-600">Sin etiquetas configuradas ahí, o no conecta todavía.</span>}
          {tags.map((t) => {
            const selected = tagIds.includes(t.id);
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTagIds(selected ? tagIds.filter((id) => id !== t.id) : [...tagIds, t.id])}
                className={`text-xs px-2.5 py-1 rounded-full ring-1 transition-colors ${
                  selected ? 'bg-accent-600/25 text-accent-300 ring-accent-500/50' : 'text-gray-400 ring-bg-600 hover:text-gray-200'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-accent-400 mb-1">Condiciones</legend>
        {Object.entries(CONDITION_META).map(([type, meta]) => (
          <label key={type} className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={conditions[type].enabled}
              onChange={(e) => setConditions({ ...conditions, [type]: { ...conditions[type], enabled: e.target.checked } })}
              className="mt-0.5 accent-accent-500"
            />
            <span className="text-xs text-gray-400 flex-1">
              <span className="text-gray-200 font-medium">{meta.label}</span>{' '}
              <input
                type="number"
                min={0}
                value={conditions[type].value}
                onChange={(e) => setConditions({ ...conditions, [type]: { ...conditions[type], value: e.target.value } })}
                disabled={!conditions[type].enabled}
                className="input w-20 py-0.5 inline-block mx-1 disabled:opacity-40"
              />
              {meta.unit}
              <br />
              {meta.hint}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend className="text-sm font-semibold text-accent-400 mb-2">Acción</legend>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={action === 'delete'} onChange={() => setAction('delete')} className="accent-accent-500" />
            Borrar
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="radio" checked={action === 'tag_notify'} onChange={() => setAction('tag_notify')} className="accent-accent-500" />
            Solo etiquetar y avisar
          </label>
        </div>
        {action === 'delete' && (
          <label className="flex items-center gap-1.5 text-xs text-gray-400 mt-2">
            <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} className="accent-accent-500" />
            Borrar también los ficheros en disco (no solo la entrada en Radarr/Sonarr)
          </label>
        )}
        {action === 'tag_notify' && (
          <div className="mt-2">
            <label className="label">Etiqueta a añadir</label>
            <input value={tagLabel} onChange={(e) => setTagLabel(e.target.value)} className="input w-60" />
          </div>
        )}
      </fieldset>

      {error && <p className="text-xs text-accent-400">{error}</p>}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button type="button" onClick={preview} disabled={previewing || !name} className="btn btn-ghost">
          {previewing ? 'Comprobando…' : 'Vista previa'}
        </button>
        <button type="button" onClick={create} disabled={saving || !name} className="btn btn-primary">
          {saving ? 'Creando…' : 'Crear regla (sin armar)'}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost">Cancelar</button>
        <span className="text-xs text-gray-600">Nace desarmada — tendrás que hacer una vista previa antes de poder armarla.</span>
      </div>

      {previewResult && <MatchList matches={previewResult} />}
    </div>
  );
}

function RuleCard({ rule, onChanged }) {
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState(null);
  const [error, setError] = useState(null);

  async function preview() {
    setError(null);
    setPreviewing(true);
    try {
      const { matches } = await api.previewEliminarrRule(rule.id);
      setPreviewResult(matches);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreviewing(false);
    }
  }

  async function toggleArmed() {
    await api.armEliminarrRule(rule.id, !rule.enabled);
    onChanged();
  }

  async function runNow() {
    setError(null);
    setRunning(true);
    try {
      setRunResult(await api.runEliminarrRuleNow(rule.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function remove() {
    if (!confirm(`¿Borrar la regla "${rule.name}"? Esto no borra nada de Radarr/Sonarr, solo la regla.`)) return;
    await api.deleteEliminarrRule(rule.id);
    onChanged();
  }

  return (
    <div className="card p-4 mb-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="font-semibold">
          {rule.name}{' '}
          <span className="text-gray-500 text-xs">{rule.media_type === 'show' ? 'series' : 'películas'}</span>
        </h3>
        <label className="flex items-center gap-1.5 text-sm flex-shrink-0" title={!previewResult && !rule.enabled ? 'Haz una vista previa antes de armarla' : ''}>
          <input
            type="checkbox"
            checked={rule.enabled}
            disabled={!rule.enabled && !previewResult}
            onChange={toggleArmed}
            className="accent-accent-500"
          />
          {rule.enabled ? 'armada' : 'desarmada'}
        </label>
      </div>

      <p className="text-xs text-gray-500 mb-2">
        {rule.conditions.length} condición(es) ({rule.condition_logic === 'any' ? 'cualquiera' : 'todas'}) ·{' '}
        {rule.action === 'delete' ? 'borra' : 'etiqueta y avisa'}
        {rule.tag_ids.length > 0 ? ` · ${rule.tag_ids.length} etiqueta(s) de scope` : ' · todo el catálogo'}
      </p>

      {rule.last_run_at && rule.last_run_summary && (
        <p className="text-xs text-gray-600 mb-2">
          Última ejecución: {rule.last_run_summary.matched} coincidencia(s), {rule.last_run_summary.deleted} borradas,{' '}
          {rule.last_run_summary.tagged} etiquetadas{rule.last_run_summary.errors > 0 ? `, ${rule.last_run_summary.errors} con error` : ''}.
        </p>
      )}

      {error && <p className="text-xs text-accent-400 mb-2">{error}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={preview} disabled={previewing} className="btn btn-ghost">
          {previewing ? 'Comprobando…' : 'Vista previa'}
        </button>
        {rule.enabled && (
          <button onClick={runNow} disabled={running} className="btn btn-ghost">
            {running ? 'Ejecutando…' : 'Ejecutar ahora'}
          </button>
        )}
        <button onClick={remove} className="btn btn-ghost text-accent-400">Eliminar regla</button>
      </div>

      {previewResult && <MatchList matches={previewResult} />}
      {runResult && (
        <p className="text-xs text-green-400 mt-2">
          Ejecutado: {runResult.summary.deleted} borradas, {runResult.summary.tagged} etiquetadas
          {runResult.summary.errors > 0 ? `, ${runResult.summary.errors} con error` : ''}.
        </p>
      )}
    </div>
  );
}

export default function EliminarrRules() {
  const [rules, setRules] = useState([]);
  const [creating, setCreating] = useState(false);

  function load() {
    api.eliminarrRules().then(setRules);
  }

  useEffect(load, []);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-gray-500">{rules.length} regla(s)</span>
        {!creating && (
          <button onClick={() => setCreating(true)} className="btn btn-primary">
            Nueva regla
          </button>
        )}
      </div>

      {creating && (
        <RuleForm
          onCreated={() => {
            setCreating(false);
            load();
          }}
          onCancel={() => setCreating(false)}
        />
      )}

      {rules.map((rule) => (
        <RuleCard key={rule.id} rule={rule} onChanged={load} />
      ))}
      {rules.length === 0 && !creating && (
        <p className="text-gray-500 text-sm">Sin reglas todavía. Crea una para empezar.</p>
      )}
    </div>
  );
}
