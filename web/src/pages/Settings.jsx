import { useEffect, useState } from 'react';
import { api } from '../api.js';

function StatusDot({ result }) {
  if (!result) return null;
  return (
    <span className={`text-xs ml-2 ${result.ok ? 'text-green-400' : 'text-accent-400'}`}>
      {result.ok ? '● conectado' : `● ${result.error}`}
    </span>
  );
}

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    seerr_url: '',
    seerr_api_key: '',
    tautulli_url: '',
    tautulli_api_key: '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState(null);

  function load() {
    api.settings().then((s) => {
      setSettings(s);
      setForm((f) => ({ ...f, seerr_url: s.seerr_url ?? '', tautulli_url: s.tautulli_url ?? '' }));
    });
  }

  useEffect(load, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    await api.updateSettings(form);
    setForm((f) => ({ ...f, seerr_api_key: '', tautulli_api_key: '' }));
    load();
    setSaving(false);
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    setTestResult(await api.testSettings());
    setTesting(false);
  }

  async function changePassword(e) {
    e.preventDefault();
    setPwMessage(null);

    if (pwForm.next.length < 8) {
      setPwMessage({ ok: false, text: 'Mínimo 8 caracteres' });
      return;
    }
    if (pwForm.next !== pwForm.confirm) {
      setPwMessage({ ok: false, text: 'No coinciden' });
      return;
    }

    setPwSaving(true);
    try {
      await api.changePassword(pwForm.current, pwForm.next);
      setPwForm({ current: '', next: '', confirm: '' });
      setPwMessage({ ok: true, text: 'Contraseña cambiada' });
    } catch {
      setPwMessage({ ok: false, text: 'Contraseña actual incorrecta' });
    } finally {
      setPwSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="max-w-xl">
      <h2 className="text-xl font-semibold mb-1">Configuración</h2>
      <p className="text-xs text-gray-500 mb-6">
        Conexión a Seerr y Tautulli. Deja la clave en blanco para no cambiar la ya guardada.
      </p>

      <form onSubmit={save} className="bg-bg-800 border border-bg-700 rounded-lg p-5 space-y-5">
        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Seerr</legend>
          <label className="block text-xs text-gray-400 mb-1">URL</label>
          <input
            value={form.seerr_url}
            onChange={(e) => setForm({ ...form, seerr_url: e.target.value })}
            placeholder="http://seerr:5055"
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5 mb-3"
          />
          <label className="block text-xs text-gray-400 mb-1">
            API key {settings.seerr_api_key_set && <span className="text-gray-600">(guardada: {settings.seerr_api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.seerr_api_key}
            onChange={(e) => setForm({ ...form, seerr_api_key: e.target.value })}
            placeholder={settings.seerr_api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Tautulli</legend>
          <label className="block text-xs text-gray-400 mb-1">URL</label>
          <input
            value={form.tautulli_url}
            onChange={(e) => setForm({ ...form, tautulli_url: e.target.value })}
            placeholder="http://tautulli:8181"
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5 mb-3"
          />
          <label className="block text-xs text-gray-400 mb-1">
            API key {settings.tautulli_api_key_set && <span className="text-gray-600">(guardada: {settings.tautulli_api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.tautulli_api_key}
            onChange={(e) => setForm({ ...form, tautulli_api_key: e.target.value })}
            placeholder={settings.tautulli_api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5"
          />
        </fieldset>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="bg-accent-600 hover:bg-accent-700 rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={testing}
            className="bg-bg-700 hover:bg-bg-600 border border-bg-600 rounded px-4 py-1.5 text-sm disabled:opacity-50"
          >
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
        </div>

        {testResult && (
          <div className="text-sm space-y-1 pt-1">
            <div>Tautulli <StatusDot result={testResult.tautulli} /></div>
            <div>Seerr <StatusDot result={testResult.seerr} /></div>
          </div>
        )}
      </form>

      <h3 className="text-sm font-semibold text-accent-400 mt-8 mb-2">Contraseña de admin</h3>
      <form onSubmit={changePassword} className="bg-bg-800 border border-bg-700 rounded-lg p-5 space-y-3">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Contraseña actual</label>
          <input
            type="password"
            value={pwForm.current}
            onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Contraseña nueva (mín. 8)</label>
          <input
            type="password"
            value={pwForm.next}
            onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Repite la contraseña nueva</label>
          <input
            type="password"
            value={pwForm.confirm}
            onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
            className="w-full bg-bg-700 border border-bg-600 rounded px-2 py-1.5"
          />
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={pwSaving}
            className="bg-accent-600 hover:bg-accent-700 rounded px-4 py-1.5 text-sm font-semibold disabled:opacity-50"
          >
            {pwSaving ? 'Guardando…' : 'Cambiar contraseña'}
          </button>
          {pwMessage && (
            <span className={`text-xs ${pwMessage.ok ? 'text-green-400' : 'text-accent-400'}`}>{pwMessage.text}</span>
          )}
        </div>
      </form>
    </div>
  );
}
