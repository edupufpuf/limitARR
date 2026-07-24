import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDirty } from '../DirtyGuard.jsx';

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
    seerr_public_url: '',
    tautulli_url: '',
    tautulli_api_key: '',
    tautulli_public_url: '',
    plex_url: '',
    plex_token: '',
    radarr_url: '',
    radarr_api_key: '',
    sonarr_url: '',
    sonarr_api_key: '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const [pwForm, setPwForm] = useState({ current: '', next: '', confirm: '' });
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMessage, setPwMessage] = useState(null);

  const [webhookUrl, setWebhookUrl] = useState('');
  const [configuringWebhook, setConfiguringWebhook] = useState(false);
  const [webhookMessage, setWebhookMessage] = useState(null);

  const [monthlyTotal, setMonthlyTotal] = useState(null);
  const [monthlyTotalForm, setMonthlyTotalForm] = useState({ mode: 'per_library', limit: '' });
  const [monthlyTotalSaving, setMonthlyTotalSaving] = useState(false);

  const monthlyTotalDirty = Boolean(
    monthlyTotal &&
      (monthlyTotalForm.mode !== monthlyTotal.mode ||
        String(monthlyTotalForm.limit) !== String(monthlyTotal.limit))
  );
  useDirty('settings-monthly-total', monthlyTotalDirty);

  const formDirty = Boolean(
    settings &&
      (form.seerr_url !== (settings.seerr_url ?? '') ||
        form.seerr_public_url !== (settings.seerr_public_url ?? '') ||
        form.tautulli_url !== (settings.tautulli_url ?? '') ||
        form.tautulli_public_url !== (settings.tautulli_public_url ?? '') ||
        form.plex_url !== (settings.plex_url ?? '') ||
        form.radarr_url !== (settings.radarr_url ?? '') ||
        form.sonarr_url !== (settings.sonarr_url ?? '') ||
        form.seerr_api_key !== '' ||
        form.tautulli_api_key !== '' ||
        form.plex_token !== '' ||
        form.radarr_api_key !== '' ||
        form.sonarr_api_key !== '')
  );
  useDirty('settings-connections', formDirty);

  const pwDirty = Boolean(pwForm.current || pwForm.next || pwForm.confirm);
  useDirty('settings-password', pwDirty);

  function load() {
    api.settings().then((s) => {
      setSettings(s);
      setForm((f) => ({
        ...f,
        seerr_url: s.seerr_url ?? '',
        seerr_public_url: s.seerr_public_url ?? '',
        tautulli_url: s.tautulli_url ?? '',
        tautulli_public_url: s.tautulli_public_url ?? '',
        plex_url: s.plex_url ?? '',
        radarr_url: s.radarr_url ?? '',
        sonarr_url: s.sonarr_url ?? '',
      }));
    });
    api.webhookInfo().then((r) => setWebhookUrl(r.url));
    api.monthlyTotalQuotaSettings().then((s) => {
      setMonthlyTotal(s);
      setMonthlyTotalForm({ mode: s.mode, limit: String(s.limit) });
    });
  }

  useEffect(load, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    await api.updateSettings(form);
    setForm((f) => ({ ...f, seerr_api_key: '', tautulli_api_key: '', plex_token: '', radarr_api_key: '', sonarr_api_key: '' }));
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

  async function saveMonthlyTotal(e) {
    e.preventDefault();
    setMonthlyTotalSaving(true);
    try {
      const limitNum = Number(monthlyTotalForm.limit);
      const s = await api.updateMonthlyTotalQuotaSettings({
        mode: monthlyTotalForm.mode,
        limit: Number.isInteger(limitNum) && limitNum >= 0 ? limitNum : undefined,
      });
      setMonthlyTotal(s);
      setMonthlyTotalForm({ mode: s.mode, limit: String(s.limit) });
    } finally {
      setMonthlyTotalSaving(false);
    }
  }

  async function configureWebhook() {
    setConfiguringWebhook(true);
    setWebhookMessage(null);
    try {
      await api.configureWebhook();
      setWebhookMessage({ ok: true, text: 'Configurado en Seerr' });
    } catch (err) {
      setWebhookMessage({ ok: false, text: `Error: ${err.message}` });
    } finally {
      setConfiguringWebhook(false);
    }
  }

  if (!settings) return null;

  return (
    <div className="max-w-xl">
      <h2 className="page-title mb-1">Configuración</h2>
      <p className="text-xs text-gray-500 mb-6">
        Conexión a Seerr, Tautulli y Plex. Deja las claves en blanco para conservar las guardadas.
      </p>

      <form onSubmit={save} className="card p-5 space-y-5">
        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Seerr</legend>
          <label className="label">URL</label>
          <input
            value={form.seerr_url}
            onChange={(e) => setForm({ ...form, seerr_url: e.target.value })}
            placeholder="http://seerr:5055"
            className="input mb-3"
          />
          <label className="label">
            API key {settings.seerr_api_key_set && <span className="text-gray-600">(guardada: {settings.seerr_api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.seerr_api_key}
            onChange={(e) => setForm({ ...form, seerr_api_key: e.target.value })}
            placeholder={settings.seerr_api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="input mb-3"
          />
          <label className="label">
            URL pública <span className="text-gray-600">(opcional — para abrir Seerr desde el navegador)</span>
          </label>
          <input
            value={form.seerr_public_url}
            onChange={(e) => setForm({ ...form, seerr_public_url: e.target.value })}
            placeholder="http://192.168.1.10:5055 — vacío = usar la URL de arriba"
            className="input"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Plex</legend>
          <label className="label">URL del servidor</label>
          <input
            value={form.plex_url}
            onChange={(e) => setForm({ ...form, plex_url: e.target.value })}
            placeholder="http://plex:32400"
            className="input mb-3"
          />
          <label className="label">
            Token del propietario {settings.plex_token_set && <span className="text-gray-600">(guardado: {settings.plex_token_masked})</span>}
          </label>
          <input
            type="password"
            value={form.plex_token}
            onChange={(e) => setForm({ ...form, plex_token: e.target.value })}
            placeholder={settings.plex_token_set ? '•••• dejar en blanco para no cambiar' : 'X-Plex-Token del propietario'}
            className="input"
          />
          <p className="text-xs text-gray-500 mt-2">
            Permite comprobar el servidor y reconocer al propietario como administrador al iniciar sesión con Plex.
          </p>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Tautulli</legend>
          <label className="label">URL</label>
          <input
            value={form.tautulli_url}
            onChange={(e) => setForm({ ...form, tautulli_url: e.target.value })}
            placeholder="http://tautulli:8181"
            className="input mb-3"
          />
          <label className="label">
            API key {settings.tautulli_api_key_set && <span className="text-gray-600">(guardada: {settings.tautulli_api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.tautulli_api_key}
            onChange={(e) => setForm({ ...form, tautulli_api_key: e.target.value })}
            placeholder={settings.tautulli_api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="input mb-3"
          />
          <label className="label">
            URL pública <span className="text-gray-600">(opcional — para abrir Tautulli desde el navegador)</span>
          </label>
          <input
            value={form.tautulli_public_url}
            onChange={(e) => setForm({ ...form, tautulli_public_url: e.target.value })}
            placeholder="http://192.168.1.10:8181 — vacío = usar la URL de arriba"
            className="input"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Radarr <span className="text-gray-600 font-normal">(opcional)</span></legend>
          <p className="text-xs text-gray-500 mb-2">
            Solo para la etiqueta de estado de pendientes: sin nada descargándose, muestra
            lo que dice Radarr (No disponible, Falta...) en vez de un "pendiente" genérico.
          </p>
          <label className="label">URL</label>
          <input
            value={form.radarr_url}
            onChange={(e) => setForm({ ...form, radarr_url: e.target.value })}
            placeholder="http://radarr:7878"
            className="input mb-3"
          />
          <label className="label">
            API key {settings.radarr_api_key_set && <span className="text-gray-600">(guardada: {settings.radarr_api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.radarr_api_key}
            onChange={(e) => setForm({ ...form, radarr_api_key: e.target.value })}
            placeholder={settings.radarr_api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="input"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Sonarr <span className="text-gray-600 font-normal">(opcional)</span></legend>
          <p className="text-xs text-gray-500 mb-2">
            Igual que Radarr pero para series: sin nada descargándose, muestra por qué
            (No monitorizada, Sin estrenar, Faltan episodios) en vez del "pendiente" genérico.
          </p>
          <label className="label">URL</label>
          <input
            value={form.sonarr_url}
            onChange={(e) => setForm({ ...form, sonarr_url: e.target.value })}
            placeholder="http://sonarr:8989"
            className="input mb-3"
          />
          <label className="label">
            API key {settings.sonarr_api_key_set && <span className="text-gray-600">(guardada: {settings.sonarr_api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.sonarr_api_key}
            onChange={(e) => setForm({ ...form, sonarr_api_key: e.target.value })}
            placeholder={settings.sonarr_api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="input"
          />
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary"
          >
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={testing}
            className="btn btn-ghost"
          >
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
        </div>

        {testResult && (
          <div className="text-sm space-y-1 pt-1">
            <div>Tautulli <StatusDot result={testResult.tautulli} /></div>
            <div>Seerr <StatusDot result={testResult.seerr} /></div>
            <div>Plex <StatusDot result={testResult.plex} /></div>
            {testResult.radarr && <div>Radarr <StatusDot result={testResult.radarr} /></div>}
            {testResult.sonarr && <div>Sonarr <StatusDot result={testResult.sonarr} /></div>}
          </div>
        )}
      </form>

      <h3 className="text-sm font-semibold text-accent-400 mt-8 mb-2">Reacción instantánea</h3>
      <div className="card p-5">
        <p className="text-xs text-gray-500 mb-3">
          Sin esto, limitARR tarda hasta un minuto en enterarse de una solicitud
          nueva (sondeo periódico). Con el webhook de Seerr activado, reacciona
          al momento. El sondeo se mantiene igual como red de seguridad.
        </p>
        <p className="text-xs text-gray-600 mb-3 break-all font-mono">{webhookUrl}</p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={configureWebhook}
            disabled={configuringWebhook}
            className="btn btn-ghost"
          >
            {configuringWebhook ? 'Configurando…' : 'Configurar automáticamente en Seerr'}
          </button>
          {webhookMessage && (
            <span className={`text-xs ${webhookMessage.ok ? 'text-green-400' : 'text-accent-400'}`}>{webhookMessage.text}</span>
          )}
        </div>
      </div>

      <h3 className="text-sm font-semibold text-accent-400 mt-8 mb-2">Cupo mensual</h3>
      <form onSubmit={saveMonthlyTotal} className="card p-5 space-y-3">
        <p className="text-xs text-gray-500">
          Elige un único modo: o cupo mensual por biblioteca (los límites de la pestaña
          Bibliotecas) o un tope total sumando todas las bibliotecas combinadas. Nunca los
          dos a la vez. El total se puede sobreescribir por usuario, grupo o rol en su ficha.
        </p>
        <div className="space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="monthly-quota-mode"
              checked={monthlyTotalForm.mode === 'per_library'}
              onChange={() => setMonthlyTotalForm({ ...monthlyTotalForm, mode: 'per_library' })}
              className="mt-0.5 accent-accent-500"
            />
            <span className="text-sm">Por biblioteca (límites configurados en Bibliotecas)</span>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="monthly-quota-mode"
              checked={monthlyTotalForm.mode === 'total'}
              onChange={() => setMonthlyTotalForm({ ...monthlyTotalForm, mode: 'total' })}
              className="mt-0.5 accent-accent-500"
            />
            <span className="text-sm">Total (todas las bibliotecas combinadas)</span>
          </label>
        </div>
        {monthlyTotalForm.mode === 'total' && (
          <div>
            <label className="label">Límite mensual (todas las bibliotecas)</label>
            <input
              type="number"
              min={0}
              value={monthlyTotalForm.limit}
              onChange={(e) => setMonthlyTotalForm({ ...monthlyTotalForm, limit: e.target.value })}
              className="input w-32"
            />
          </div>
        )}
        <button type="submit" disabled={monthlyTotalSaving} className="btn btn-primary">
          {monthlyTotalSaving ? 'Guardando…' : 'Guardar'}
        </button>
      </form>

      <h3 className="text-sm font-semibold text-accent-400 mt-8 mb-2">Copia de seguridad</h3>
      <div className="card p-5">
        <p className="text-xs text-gray-500 mb-3">
          Descarga un volcado consistente de la base de datos (cupo, overrides,
          registro de decisiones, vínculos de Telegram). Es manual — descárgalo
          de vez en cuando o antes de tocar algo delicado.
        </p>
        <a
          href="/api/backup"
          className="btn btn-ghost"
        >
          Descargar backup
        </a>
      </div>

      <h3 className="text-sm font-semibold text-accent-400 mt-8 mb-2">Contraseña de admin</h3>
      <form onSubmit={changePassword} className="card p-5 space-y-3">
        <div>
          <label className="label">Contraseña actual</label>
          <input
            type="password"
            value={pwForm.current}
            onChange={(e) => setPwForm({ ...pwForm, current: e.target.value })}
            className="input"
          />
        </div>
        <div>
          <label className="label">Contraseña nueva (mín. 8)</label>
          <input
            type="password"
            value={pwForm.next}
            onChange={(e) => setPwForm({ ...pwForm, next: e.target.value })}
            className="input"
          />
        </div>
        <div>
          <label className="label">Repite la contraseña nueva</label>
          <input
            type="password"
            value={pwForm.confirm}
            onChange={(e) => setPwForm({ ...pwForm, confirm: e.target.value })}
            className="input"
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <button
            type="submit"
            disabled={pwSaving}
            className="btn btn-primary"
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
