import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useDirty } from '../DirtyGuard.jsx';

function Chevron({ open }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-5 h-5 transition-transform ${open ? 'rotate-180' : ''}`}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}

function AccordionSection({ id, title, description, status, tone = 'neutral', open, onToggle, children }) {
  const statusClass = tone === 'active'
    ? 'bg-green-500/10 text-green-300 ring-green-500/25'
    : tone === 'warning'
      ? 'bg-amber-500/10 text-amber-300 ring-amber-500/25'
      : 'bg-bg-700/70 text-gray-300 ring-bg-600';

  return (
    <section className={`card overflow-hidden transition-colors ${open ? 'border-bg-600' : ''}`}>
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        aria-controls={`${id}-content`}
        className="w-full flex items-center gap-4 px-4 sm:px-5 py-4 text-left hover:bg-bg-700/25 transition-colors"
      >
        <span className="flex-1 min-w-0">
          <span className="block font-extrabold text-gray-100">{title}</span>
          <span className="block text-xs text-gray-500 mt-1 leading-relaxed">{description}</span>
        </span>
        <span className={`badge ${statusClass}`}>{status}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div id={`${id}-content`} className="border-t border-bg-700/70 px-4 sm:px-5 py-5 bg-bg-900/25">
          {children}
        </div>
      )}
    </section>
  );
}

// Todos los avisos automáticos comparten esta misma forma (toggle + texto
// editable + Guardar propio), catálogo servido por /notifications/types —
// antes cada uno "tenía su forma de ser" (unos con toggle, otros sin, unos
// editables, otros fijos en el código); pedido de Edu (11 ago 2026).
function NotificationTypeSection({ type, open, onToggle, onSaved }) {
  const [enabled, setEnabled] = useState(type.enabled);
  const [message, setMessage] = useState(type.message);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null);

  const dirty = enabled !== type.enabled || message !== type.message;
  useDirty(`notif-type-${type.id}`, dirty);

  async function save() {
    setSaving(true);
    setResult(null);
    try {
      const updated = await api.updateNotificationType(type.id, { enabled, message });
      onSaved(updated);
      setResult('Guardado.');
    } catch {
      setResult('No se pudo guardar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AccordionSection
      id={`type-${type.id}`}
      title={type.label}
      description={type.description}
      status={enabled ? 'Activo' : 'Desactivado'}
      tone={enabled ? 'active' : 'neutral'}
      open={open}
      onToggle={onToggle}
    >
      <label className="flex items-center justify-between gap-4 rounded-xl border border-bg-600 bg-bg-950/30 p-4 cursor-pointer mb-5">
        <span>
          <span className="block font-bold">Enviar esta notificación</span>
        </span>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-5 h-5 accent-red-500" />
      </label>
      <label className="label">Texto del aviso</label>
      <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="input min-h-28 resize-y" />
      <p className="text-xs text-gray-500 mt-2">
        Variables: <span className="text-gray-300">{type.variables.map((v) => `{${v}}`).join(', ')}</span>
      </p>
      <div className="flex flex-wrap items-center gap-3 mt-4">
        <button type="button" onClick={save} disabled={saving} className="btn btn-primary">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
        {result && <span className="text-xs text-gray-500">{result}</span>}
      </div>
    </AccordionSection>
  );
}

export default function Notifications() {
  const [botSettings, setBotSettings] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [mode, setMode] = useState('dm');
  const [groupChatId, setGroupChatId] = useState('');
  const [groupTopicId, setGroupTopicId] = useState('');
  const [notificationTypes, setNotificationTypes] = useState(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [groupTestResult, setGroupTestResult] = useState(null);
  const [pendingSummaryResult, setPendingSummaryResult] = useState(null);
  const [sendingPendingSummary, setSendingPendingSummary] = useState(false);
  const [openSection, setOpenSection] = useState('agent');

  const [broadcastSettings, setBroadcastSettingsState] = useState(null);
  const [broadcastEnabled, setBroadcastEnabled] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastSeenCount, setBroadcastSeenCount] = useState(0);
  const [savingBroadcast, setSavingBroadcast] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState(null);
  const [testingBroadcast, setTestingBroadcast] = useState(false);
  const [broadcastTestResult, setBroadcastTestResult] = useState(null);

  const [links, setLinks] = useState([]);
  const [users, setUsers] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [pickUser, setPickUser] = useState({});
  const [testResult, setTestResult] = useState({});

  const agentDirty = Boolean(
    botSettings &&
      (tokenInput !== '' ||
        mode !== (botSettings.mode ?? 'dm') ||
        groupChatId !== (botSettings.groupChatId ?? '') ||
        groupTopicId !== (botSettings.groupTopicId ?? ''))
  );
  useDirty('notifications-agent', agentDirty);

  const broadcastDirty = Boolean(
    broadcastSettings &&
      (broadcastEnabled !== (broadcastSettings.enabled ?? false) ||
        broadcastMessage !== (broadcastSettings.message ?? ''))
  );
  useDirty('notifications-broadcast', broadcastDirty);

  function loadLinks() {
    api.notificationLinks().then(setLinks);
  }

  useEffect(() => {
    api.notificationSettings().then((s) => {
      setBotSettings(s);
      setMode(s.mode ?? 'dm');
      setGroupChatId(s.groupChatId ?? '');
      setGroupTopicId(s.groupTopicId ?? '');
    });
    api.notificationTypes().then(setNotificationTypes);
    api.users().then(setUsers);
    loadLinks();
    api.broadcastSettings().then((b) => {
      setBroadcastSettingsState(b);
      setBroadcastEnabled(b.enabled ?? false);
      setBroadcastMessage(b.message ?? '');
      setBroadcastSeenCount(b.seenCount ?? 0);
    });
  }, []);

  async function saveBroadcast() {
    setSavingBroadcast(true);
    setBroadcastResult(null);
    try {
      const b = await api.updateBroadcastSettings({ enabled: broadcastEnabled, message: broadcastMessage });
      setBroadcastSettingsState(b);
      setBroadcastEnabled(b.enabled ?? false);
      setBroadcastMessage(b.message ?? '');
      setBroadcastSeenCount(b.seenCount ?? 0);
      setBroadcastResult('Guardado.');
    } catch {
      setBroadcastResult('No se pudo guardar.');
    } finally {
      setSavingBroadcast(false);
    }
  }

  // Corta SOLO tu propia sesión de Plex activa (identificada como admin en
  // Tautulli) con el mensaje ya guardado, para verlo en pantalla sin esperar
  // a un usuario sin vincular. Necesita estar reproduciendo algo YA.
  async function testBroadcast() {
    setTestingBroadcast(true);
    setBroadcastTestResult(null);
    try {
      await api.testBroadcast();
      setBroadcastTestResult('Cortada tu sesión con el mensaje — mira Plex.');
    } catch (err) {
      setBroadcastTestResult(
        err.message.endsWith('404')
          ? 'No tienes ninguna reproducción activa ahora mismo — empieza a ver algo en Plex y vuelve a pulsar.'
          : `Error: ${err.message}`
      );
    } finally {
      setTestingBroadcast(false);
    }
  }

  async function saveSettings(e) {
    e.preventDefault();
    setSavingSettings(true);
    const s = await api.updateNotificationSettings({ botToken: tokenInput, mode, groupChatId, groupTopicId });
    setBotSettings(s);
    setTokenInput('');
    setSavingSettings(false);
  }

  function updateNotificationType(updated) {
    setNotificationTypes((list) => list.map((t) => (t.id === updated.id ? updated : t)));
  }

  async function discover() {
    setDiscovering(true);
    setDiscovered(await api.discoverChats());
    setDiscovering(false);
  }

  async function link(chatId, label) {
    const userId = pickUser[chatId];
    if (!userId) return;
    await api.setNotificationLink(userId, { chatId, label });
    setDiscovered(discovered.filter((d) => d.chatId !== chatId));
    loadLinks();
  }

  function useAsGroup(d) {
    setGroupChatId(d.chatId);
    setGroupTopicId(d.messageThreadId ?? '');
    setDiscovered(discovered.filter((x) => x.chatId !== d.chatId || x.messageThreadId !== d.messageThreadId));
  }

  async function unlink(userId) {
    await api.deleteNotificationLink(userId);
    loadLinks();
  }

  async function test(userId) {
    setTestResult({ ...testResult, [userId]: 'probando…' });
    try {
      await api.testNotification(userId);
      setTestResult({ ...testResult, [userId]: 'enviado ✓' });
    } catch (err) {
      setTestResult({ ...testResult, [userId]: `error: ${err.message}` });
    }
  }

  async function testGroup() {
    setGroupTestResult('probando…');
    try {
      await api.testGroupNotification({ groupChatId, groupTopicId });
      setGroupTestResult('enviado ✓ (recuerda Guardar)');
    } catch (err) {
      setGroupTestResult(`error: ${err.message}`);
    }
  }

  async function sendPendingSummary(target) {
    setSendingPendingSummary(true);
    setPendingSummaryResult('enviando…');
    try {
      const result = await api.sendPendingSummary(target);
      if (result.mode === 'group') {
        setPendingSummaryResult(`enviado al grupo · ${result.users} usuario(s) · ${result.messages} mensaje(s)`);
      } else {
        setPendingSummaryResult(`enviado por DM · ${result.sent} usuario(s) · ${result.messages} mensaje(s) · ${result.skipped} sin vincular`);
      }
    } catch (err) {
      setPendingSummaryResult(`error: ${err.message}`);
    } finally {
      setSendingPendingSummary(false);
    }
  }

  const userName = (id) => users.find((u) => u.id === id)?.username ?? `user#${id}`;

  function toggleSection(id) {
    setOpenSection((current) => current === id ? null : id);
  }

  if (!botSettings || !notificationTypes) return null;

  return (
    <div className="max-w-3xl">
      <h2 className="page-title mb-1">Avisos</h2>
      <p className="text-sm text-gray-500 mb-7">
        Configura el agente Telegram y abre únicamente el tipo de notificación que quieras editar.
      </p>

      <form onSubmit={saveSettings} className="space-y-3">
        <AccordionSection
          id="agent"
          title="Agente de Telegram"
          description="Token del bot y destino predeterminado de los avisos."
          status={botSettings.bot_token_set ? 'Configurado' : 'Pendiente'}
          tone={botSettings.bot_token_set ? 'active' : 'warning'}
          open={openSection === 'agent'}
          onToggle={toggleSection}
        >
          <div className="space-y-5">
            <div>
              <label className="label">
                Token del bot {botSettings.bot_token_set && <span className="text-gray-600">(guardado: {botSettings.bot_token_masked})</span>}
              </label>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={botSettings.bot_token_set ? '•••• dejar en blanco para no cambiar' : '123456:ABC-token-de-BotFather'}
                className="input"
              />
              <p className="text-xs text-gray-500 mt-2">Crea el bot con <span className="text-gray-300">@BotFather</span> y pega aquí su token.</p>
            </div>

            <fieldset>
              <legend className="label">Destino predeterminado</legend>
              <div className="grid sm:grid-cols-2 gap-2 text-sm mb-4">
                <label className={`flex items-center gap-2 rounded-xl border px-3 py-3 cursor-pointer ${mode === 'dm' ? 'border-accent-500/60 bg-accent-500/10' : 'border-bg-600 bg-bg-950/30'}`}>
                  <input type="radio" checked={mode === 'dm'} onChange={() => setMode('dm')} />
                  Mensaje directo al usuario
                </label>
                <label className={`flex items-center gap-2 rounded-xl border px-3 py-3 cursor-pointer ${mode === 'group' ? 'border-accent-500/60 bg-accent-500/10' : 'border-bg-600 bg-bg-950/30'}`}>
                  <input type="radio" checked={mode === 'group'} onChange={() => setMode('group')} />
                  Grupo con topics
                </label>
              </div>

              {mode === 'group' && (
                <div className="grid sm:grid-cols-[1fr_10rem_auto] items-end gap-3">
                  <div>
                    <label className="label">Chat ID del grupo</label>
                    <input value={groupChatId} onChange={(e) => setGroupChatId(e.target.value)} placeholder="-1001234567890" className="input" />
                  </div>
                  <div>
                    <label className="label">Topic ID</label>
                    <input value={groupTopicId} onChange={(e) => setGroupTopicId(e.target.value)} placeholder="opcional" className="input" />
                  </div>
                  <button type="button" onClick={testGroup} className="btn btn-ghost">Probar</button>
                </div>
              )}
              {groupTestResult && <p aria-live="polite" className="text-xs text-gray-500 mt-3">{groupTestResult}</p>}
            </fieldset>
          </div>
        </AccordionSection>

        <div className="pt-5 pb-1">
          <h3 className="font-extrabold text-lg">Tipos de notificación</h3>
          <p className="text-xs text-gray-500 mt-1">Cada aviso mantiene su configuración y estado por separado.</p>
        </div>

        {notificationTypes.map((type) => (
          <NotificationTypeSection
            key={type.id}
            type={type}
            open={openSection === `type-${type.id}`}
            onToggle={() => toggleSection(`type-${type.id}`)}
            onSaved={updateNotificationType}
          />
        ))}

        <AccordionSection
          id="broadcast"
          title="Vincular Telegram (pop-up en Plex)"
          description="Corta la reproducción con un aviso en pantalla, una vez, a quien todavía no ha vinculado Telegram."
          status={broadcastEnabled ? 'Activo' : 'Desactivado'}
          tone={broadcastEnabled ? 'active' : 'neutral'}
          open={openSection === 'broadcast'}
          onToggle={toggleSection}
        >
          <p className="text-xs text-gray-500 mb-4">
            Es la única forma de pop-up real que da la API de Plex/Tautulli: se
            corta la reproducción en curso mostrando este texto (como ya hace el
            corte de sesiones duplicadas). Solo a quien NO tenga Telegram
            vinculado, nunca al admin, y como mucho una vez por usuario mientras
            el texto no cambie — si lo editas, se vuelve a enseñar a todos los
            que aún no han vinculado.
          </p>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-bg-600 bg-bg-950/30 p-4 cursor-pointer mb-5">
            <span>
              <span className="block font-bold">Activar</span>
              <span className="block text-xs text-gray-500 mt-1">
                {broadcastSeenCount > 0
                  ? `Ya se ha mostrado a ${broadcastSeenCount} usuario${broadcastSeenCount === 1 ? '' : 's'} con este texto.`
                  : 'Todavía no se ha mostrado a nadie con este texto.'}
              </span>
            </span>
            <input type="checkbox" checked={broadcastEnabled} onChange={(e) => setBroadcastEnabled(e.target.checked)} className="w-5 h-5 accent-red-500" />
          </label>
          <label className="label">Texto del aviso</label>
          <textarea value={broadcastMessage} onChange={(e) => setBroadcastMessage(e.target.value)} rows={4} className="input min-h-24 resize-y" />
          <div className="flex flex-wrap items-center gap-3 mt-4">
            <button type="button" onClick={saveBroadcast} disabled={savingBroadcast} className="btn btn-primary">
              {savingBroadcast ? 'Guardando…' : 'Guardar'}
            </button>
            <button type="button" onClick={testBroadcast} disabled={testingBroadcast} className="btn btn-ghost">
              {testingBroadcast ? 'Probando…' : 'Probar en mi sesión activa'}
            </button>
            {broadcastResult && <span className="text-xs text-gray-500">{broadcastResult}</span>}
          </div>
          {broadcastTestResult && <p aria-live="polite" className="text-xs text-gray-500 mt-2">{broadcastTestResult}</p>}
        </AccordionSection>

        <AccordionSection
          id="summary"
          title="Resumen de pendientes"
          description="Envío manual con todo lo que queda por ver."
          status="Manual"
          open={openSection === 'summary'}
          onToggle={toggleSection}
        >
          <p className="text-sm text-gray-400 mb-4">Al grupo envía un resumen común; por DM envía uno a cada usuario vinculado.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => sendPendingSummary('group')} disabled={sendingPendingSummary} className="btn btn-primary">
              {sendingPendingSummary ? 'Enviando…' : 'Enviar al grupo'}
            </button>
            <button type="button" onClick={() => sendPendingSummary('dm')} disabled={sendingPendingSummary} className="btn btn-ghost">
              {sendingPendingSummary ? 'Enviando…' : 'Enviar por DM'}
            </button>
          </div>
          {pendingSummaryResult && <p aria-live="polite" className="text-xs text-gray-500 mt-3">{pendingSummaryResult}</p>}
        </AccordionSection>

        <div className="pt-5 pb-1">
          <h3 className="font-extrabold text-lg">Destinatarios</h3>
        </div>

        <AccordionSection
          id="recipients"
          title="Chats y usuarios vinculados"
          description="Descubre conversaciones nuevas y gestiona los mensajes directos."
          status={`${links.length} vinculados`}
          open={openSection === 'recipients'}
          onToggle={toggleSection}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <p className="text-sm text-gray-400 max-w-lg">Pide al usuario que escriba al bot, o escribe en el topic del grupo que quieras detectar.</p>
            <button type="button" onClick={discover} disabled={discovering} className="btn btn-ghost">
              {discovering ? 'Buscando…' : 'Buscar chats nuevos'}
            </button>
          </div>

          {discovered.length > 0 && (
            <div className="rounded-xl border border-bg-600 bg-bg-950/25 p-3 mb-5 space-y-3">
              {discovered.map((d) => (
                <div key={`${d.chatId}-${d.messageThreadId}`} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-gray-300 w-full sm:w-44 truncate">
                    {d.chatType === 'private'
                      ? d.username ? `@${d.username}` : d.firstName ?? d.chatId
                      : `${d.chatTitle ?? 'grupo'}${d.messageThreadId ? ` · topic ${d.messageThreadId}` : ''}`}
                  </span>
                  <span className="text-gray-500 flex-1 truncate min-w-0">“{d.text}”</span>
                  {d.chatType === 'private' ? (
                    <>
                      <select value={pickUser[d.chatId] ?? ''} onChange={(e) => setPickUser({ ...pickUser, [d.chatId]: e.target.value })} className="input w-auto py-1">
                        <option value="">— usuario Tautulli —</option>
                        {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                      </select>
                      <button type="button" onClick={() => link(d.chatId, d.username ?? d.firstName)} className="btn btn-primary py-1">Vincular</button>
                    </>
                  ) : (
                    <button type="button" onClick={() => useAsGroup(d)} className="btn btn-primary py-1">Usar como grupo</button>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 border-b border-bg-700"><th className="py-2 pr-4">Usuario</th><th className="py-2 pr-4">Chat</th><th className="py-2">Acciones</th></tr></thead>
              <tbody>
                {links.map((l) => (
                  <tr key={l.user_id} className="border-b border-bg-800">
                    <td className="py-3 pr-4 whitespace-nowrap">{userName(l.user_id)}</td>
                    <td className="py-3 pr-4 text-gray-400">{l.label ?? l.chat_id}</td>
                    <td className="py-3 whitespace-nowrap">
                      <div className="flex items-center gap-3">
                        <button type="button" onClick={() => test(l.user_id)} className="text-accent-300 text-xs">Probar</button>
                        <button type="button" onClick={() => unlink(l.user_id)} className="text-gray-500 text-xs">Desvincular</button>
                        {testResult[l.user_id] && <span className="text-xs text-gray-500">{testResult[l.user_id]}</span>}
                      </div>
                    </td>
                  </tr>
                ))}
                {links.length === 0 && <tr><td colSpan={3} className="py-6 text-center text-gray-500">Ningún usuario vinculado todavía.</td></tr>}
              </tbody>
            </table>
          </div>
        </AccordionSection>

        <div className="flex justify-end pt-4 pb-4 sm:pb-0">
          <button type="submit" disabled={savingSettings} className="btn btn-primary shadow-glow">
            {savingSettings ? 'Guardando…' : 'Guardar configuración'}
          </button>
        </div>
      </form>
    </div>
  );
}
