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

export default function EliminarrSettings() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({
    radarrUrl: '', radarrApiKey: '',
    sonarrUrl: '', sonarrApiKey: '',
    telegramChatId: '', telegramTopicId: '',
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  function load() {
    api.eliminarrSettings().then((s) => {
      setSettings(s);
      setForm((f) => ({
        ...f,
        radarrUrl: s.radarr.url ?? '',
        sonarrUrl: s.sonarr.url ?? '',
        telegramChatId: s.telegram.chatId ?? '',
        telegramTopicId: s.telegram.topicId ?? '',
      }));
    });
  }

  useEffect(load, []);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    await api.updateEliminarrSettings({
      radarr: { url: form.radarrUrl, apiKey: form.radarrApiKey },
      sonarr: { url: form.sonarrUrl, apiKey: form.sonarrApiKey },
      telegram: { chatId: form.telegramChatId, topicId: form.telegramTopicId },
    });
    setForm((f) => ({ ...f, radarrApiKey: '', sonarrApiKey: '' }));
    load();
    setSaving(false);
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    setTestResult(await api.testEliminarrSettings());
    setTesting(false);
  }

  if (!settings) return null;

  return (
    <div className="max-w-xl">
      <p className="text-xs text-gray-500 mb-6">
        Conexión a Radarr y Sonarr, y el chat de Telegram donde avisan las reglas de borrado
        (independiente del de Avisos de cupo). Deja las claves en blanco para conservar las guardadas.
      </p>

      <form onSubmit={save} className="card p-5 space-y-5">
        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Radarr</legend>
          <label className="label">URL</label>
          <input
            value={form.radarrUrl}
            onChange={(e) => setForm({ ...form, radarrUrl: e.target.value })}
            placeholder="http://radarr:7878"
            className="input mb-3"
          />
          <label className="label">
            API key {settings.radarr.api_key_set && <span className="text-gray-600">(guardada: {settings.radarr.api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.radarrApiKey}
            onChange={(e) => setForm({ ...form, radarrApiKey: e.target.value })}
            placeholder={settings.radarr.api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="input"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Sonarr</legend>
          <label className="label">URL</label>
          <input
            value={form.sonarrUrl}
            onChange={(e) => setForm({ ...form, sonarrUrl: e.target.value })}
            placeholder="http://sonarr:8989"
            className="input mb-3"
          />
          <label className="label">
            API key {settings.sonarr.api_key_set && <span className="text-gray-600">(guardada: {settings.sonarr.api_key_masked})</span>}
          </label>
          <input
            type="password"
            value={form.sonarrApiKey}
            onChange={(e) => setForm({ ...form, sonarrApiKey: e.target.value })}
            placeholder={settings.sonarr.api_key_set ? '•••• dejar en blanco para no cambiar' : ''}
            className="input"
          />
        </fieldset>

        <fieldset>
          <legend className="text-sm font-semibold text-accent-400 mb-2">Avisos (Telegram)</legend>
          <p className="text-xs text-gray-500 mb-3">
            Usa el mismo bot ya configurado en Avisos, pero un chat/tema propio —
            para no mezclar avisos de borrado con los de cupo.
          </p>
          <label className="label">Chat ID</label>
          <input
            value={form.telegramChatId}
            onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })}
            placeholder="-1001234567890"
            className="input mb-3"
          />
          <label className="label">Topic ID <span className="text-gray-600">(opcional, si el chat es un foro)</span></label>
          <input
            value={form.telegramTopicId}
            onChange={(e) => setForm({ ...form, telegramTopicId: e.target.value })}
            placeholder="vacío = general"
            className="input"
          />
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
          <button type="button" onClick={test} disabled={testing} className="btn btn-ghost">
            {testing ? 'Probando…' : 'Probar conexión'}
          </button>
        </div>

        {testResult && (
          <div className="text-sm space-y-1 pt-1">
            <div>Radarr <StatusDot result={testResult.radarr} /></div>
            <div>Sonarr <StatusDot result={testResult.sonarr} /></div>
            {testResult.telegram && <div>Telegram <StatusDot result={testResult.telegram} /></div>}
          </div>
        )}
      </form>
    </div>
  );
}
