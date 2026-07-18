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

// Sub-desplegable más compacto, para trocear una AccordionSection larga (el
// módulo Maintainerr tiene conexión + mensajes de dos tipos + colecciones +
// webhook — todo en un bloque se veía como una pared de campos).
function MiniSection({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-bg-700 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-bg-700/25 transition-colors"
      >
        <span className="font-bold text-sm text-gray-200">{title}</span>
        <Chevron open={open} />
      </button>
      {open && <div className="border-t border-bg-700 px-4 py-4 bg-bg-900/20 space-y-4">{children}</div>}
    </div>
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

export default function Notifications() {
  const [botSettings, setBotSettings] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [mode, setMode] = useState('dm');
  const [groupChatId, setGroupChatId] = useState('');
  const [groupTopicId, setGroupTopicId] = useState('');
  const [noQuotaMessage, setNoQuotaMessage] = useState('');
  const [notifyNoQuota, setNotifyNoQuota] = useState(true);
  const [notifyApproved, setNotifyApproved] = useState(true);
  const [notifyFreed, setNotifyFreed] = useState(true);
  const [savingSettings, setSavingSettings] = useState(false);
  const [groupTestResult, setGroupTestResult] = useState(null);
  const [pendingSummaryResult, setPendingSummaryResult] = useState(null);
  const [sendingPendingSummary, setSendingPendingSummary] = useState(false);
  const [openSection, setOpenSection] = useState('agent');

  // Módulo Maintainerr (botón 💾 Salvar): config propia con bot dedicado.
  const [mnt, setMnt] = useState(null);
  const [mntUrl, setMntUrl] = useState('');
  const [mntToken, setMntToken] = useState('');
  const [mntChatId, setMntChatId] = useState('');
  const [mntTopicId, setMntTopicId] = useState('');
  const [mntSilent, setMntSilent] = useState(false);
  const [mntSavedMessage, setMntSavedMessage] = useState('');
  const [mntDeleteMessage, setMntDeleteMessage] = useState('');
  const [mntDeleteMessageTv, setMntDeleteMessageTv] = useState('');
  const [mntResult, setMntResult] = useState(null);
  const [mntLiveCollections, setMntLiveCollections] = useState(null);
  const [mntPairsMap, setMntPairsMap] = useState({}); // { tituloOrigen: tituloDestino }
  const [savingMnt, setSavingMnt] = useState(false);

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
        groupTopicId !== (botSettings.groupTopicId ?? '') ||
        noQuotaMessage !== (botSettings.noQuotaMessage ?? '') ||
        notifyNoQuota !== (botSettings.notifyNoQuota ?? true) ||
        notifyApproved !== (botSettings.notifyApproved ?? true) ||
        notifyFreed !== (botSettings.notifyFreed ?? true))
  );
  useDirty('notifications-agent', agentDirty);

  const normalizePairs = (map) => JSON.stringify(Object.entries(map).sort());
  const mntDirty = Boolean(
    mnt &&
      (mntToken !== '' ||
        mntUrl !== (mnt.url ?? '') ||
        mntChatId !== (mnt.chatId ?? '') ||
        mntTopicId !== (mnt.topicId ?? '') ||
        mntSilent !== Boolean(mnt.silent) ||
        mntSavedMessage !== (mnt.savedMessage ?? '') ||
        mntDeleteMessage !== (mnt.deleteMessage ?? '') ||
        mntDeleteMessageTv !== (mnt.deleteMessageTv ?? '') ||
        normalizePairs(mntPairsMap) !== normalizePairs(Object.fromEntries((mnt.pairs ?? []).map((p) => [p.source, p.target]))))
  );
  useDirty('notifications-maintainerr', mntDirty);

  function loadLinks() {
    api.notificationLinks().then(setLinks);
  }

  useEffect(() => {
    api.notificationSettings().then((s) => {
      setBotSettings(s);
      setMode(s.mode ?? 'dm');
      setGroupChatId(s.groupChatId ?? '');
      setGroupTopicId(s.groupTopicId ?? '');
      setNoQuotaMessage(s.noQuotaMessage ?? '');
      setNotifyNoQuota(s.notifyNoQuota ?? true);
      setNotifyApproved(s.notifyApproved ?? true);
      setNotifyFreed(s.notifyFreed ?? true);
    });
    api.users().then(setUsers);
    loadLinks();
    api.maintainerrSettings().then((m) => {
      setMnt(m);
      setMntUrl(m.url ?? '');
      setMntChatId(m.chatId ?? '');
      setMntTopicId(m.topicId ?? '');
      setMntSilent(Boolean(m.silent));
      setMntSavedMessage(m.savedMessage ?? '');
      setMntDeleteMessage(m.deleteMessage ?? '');
      setMntDeleteMessageTv(m.deleteMessageTv ?? '');
      const map = {};
      (m.pairs ?? []).forEach((p) => { map[p.source] = p.target; });
      setMntPairsMap(map);
    }).catch(() => {});
  }, []);

  async function saveMaintainerr() {
    setSavingMnt(true);
    setMntResult(null);
    try {
      const pairs = Object.entries(mntPairsMap).map(([source, target]) => ({ source, target }));
      const m = await api.updateMaintainerrSettings({
        url: mntUrl,
        botToken: mntToken,
        chatId: mntChatId,
        topicId: mntTopicId,
        pairs,
        silent: mntSilent,
        savedMessage: mntSavedMessage,
        deleteMessage: mntDeleteMessage,
        deleteMessageTv: mntDeleteMessageTv,
      });
      setMnt((prev) => ({ ...prev, ...m }));
      setMntSavedMessage(m.savedMessage ?? mntSavedMessage);
      setMntDeleteMessage(m.deleteMessage ?? mntDeleteMessage);
      setMntDeleteMessageTv(m.deleteMessageTv ?? mntDeleteMessageTv);
      setMntToken('');
      setMntResult('Guardado.');
    } catch {
      setMntResult('No se pudo guardar.');
    } finally {
      setSavingMnt(false);
    }
  }

  async function loadMaintainerrCollections() {
    setMntResult('Cargando…');
    setMntLiveCollections(null);
    try {
      const { collections } = await api.testMaintainerr();
      setMntLiveCollections(collections);
      setMntResult(collections.length ? null : 'Conexión OK, pero Maintainerr no tiene colecciones.');
    } catch {
      setMntResult('No se pudo conectar con Maintainerr — revisa la URL.');
    }
  }

  function setPairTarget(sourceTitle, targetTitle) {
    setMntPairsMap((prev) => {
      const next = { ...prev };
      if (targetTitle) next[sourceTitle] = targetTitle;
      else delete next[sourceTitle];
      return next;
    });
  }

  async function saveSettings(e) {
    e.preventDefault();
    setSavingSettings(true);
    const s = await api.updateNotificationSettings({ botToken: tokenInput, mode, groupChatId, groupTopicId, noQuotaMessage, notifyNoQuota, notifyApproved, notifyFreed });
    setBotSettings(s);
    setNoQuotaMessage(s.noQuotaMessage ?? '');
    setTokenInput('');
    setSavingSettings(false);
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

  if (!botSettings) return null;

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

        <AccordionSection
          id="no-quota"
          title="Usuario sin cupo"
          description="Se envía cuando una solicitud no puede aprobarse por falta de saldo."
          status={notifyNoQuota ? 'Activo' : 'Desactivado'}
          tone={notifyNoQuota ? 'active' : 'neutral'}
          open={openSection === 'no-quota'}
          onToggle={toggleSection}
        >
          <label className="flex items-center justify-between gap-4 rounded-xl border border-bg-600 bg-bg-950/30 p-4 cursor-pointer mb-5">
            <span>
              <span className="block font-bold">Enviar esta notificación</span>
              <span className="block text-xs text-gray-500 mt-1">Avisa al usuario y al grupo cuando se bloquea una solicitud.</span>
            </span>
            <input type="checkbox" checked={notifyNoQuota} onChange={(e) => setNotifyNoQuota(e.target.checked)} className="w-5 h-5 accent-red-500" />
          </label>
          <label className="label">Texto del aviso</label>
          <textarea value={noQuotaMessage} onChange={(e) => setNoQuotaMessage(e.target.value)} rows={5} className="input min-h-32 resize-y" />
          <p className="text-xs text-gray-500 mt-2">
            Variables: <span className="text-gray-300">{'{usuario}'}</span>, <span className="text-gray-300">{'{biblioteca}'}</span>,{' '}
            <span className="text-gray-300">{'{titulo}'}</span> y <span className="text-gray-300">{'{tipo}'}</span>.
          </p>
        </AccordionSection>

        <AccordionSection
          id="approved"
          title="Solicitud aprobada"
          description="Confirma la aprobación e indica cuánto cupo le queda al usuario."
          status={notifyApproved ? 'Activo' : 'Desactivado'}
          tone={notifyApproved ? 'active' : 'neutral'}
          open={openSection === 'approved'}
          onToggle={toggleSection}
        >
          <label className="flex items-center justify-between gap-4 rounded-xl border border-bg-600 bg-bg-950/30 p-4 cursor-pointer">
            <span>
              <span className="block font-bold">Enviar esta notificación</span>
              <span className="block text-xs text-gray-500 mt-1">Incluye título, biblioteca y saldo restante.</span>
            </span>
            <input type="checkbox" checked={notifyApproved} onChange={(e) => setNotifyApproved(e.target.checked)} className="w-5 h-5 accent-red-500" />
          </label>
        </AccordionSection>

        <AccordionSection
          id="freed"
          title="Cupo liberado"
          description="Avisa al terminar de ver contenido o al cancelarse una solicitud."
          status={notifyFreed ? 'Activo' : 'Desactivado'}
          tone={notifyFreed ? 'active' : 'neutral'}
          open={openSection === 'freed'}
          onToggle={toggleSection}
        >
          <label className="flex items-center justify-between gap-4 rounded-xl border border-bg-600 bg-bg-950/30 p-4 cursor-pointer">
            <span>
              <span className="block font-bold">Enviar esta notificación</span>
              <span className="block text-xs text-gray-500 mt-1">Indica qué elemento liberó el hueco y el nuevo saldo.</span>
            </span>
            <input type="checkbox" checked={notifyFreed} onChange={(e) => setNotifyFreed(e.target.checked)} className="w-5 h-5 accent-red-500" />
          </label>
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

        <AccordionSection
          id="maintainerr"
          title="Salvar del borrado (Maintainerr)"
          description="Aviso con botón 💾 Salvar cuando Maintainerr va a borrar una película o una temporada."
          status={mnt?.enabled ? 'Configurado' : 'Pendiente'}
          tone={mnt?.enabled ? 'active' : 'warning'}
          open={openSection === 'maintainerr'}
          onToggle={toggleSection}
        >
          <div className="space-y-3">
            <p className="text-sm text-gray-400">
              Usa un bot de Telegram <strong>dedicado</strong> (no el de los avisos de cupo: Telegram
              solo permite un lector de updates por token). Al pulsar 💾 Salvar, el ítem pasa a la
              colección de salvados y se registra quién lo salvó.
            </p>

            <MiniSection title="Conexión" defaultOpen={!mnt?.enabled}>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">URL de Maintainerr</label>
                  <input value={mntUrl} onChange={(e) => setMntUrl(e.target.value)} placeholder="http://maintainerr:6246" className="input" />
                </div>
                <div>
                  <label className="label">
                    Token del bot dedicado {mnt?.bot_token_set && <span className="text-gray-600">(guardado: {mnt.bot_token_masked})</span>}
                  </label>
                  <input
                    type="password"
                    value={mntToken}
                    onChange={(e) => setMntToken(e.target.value)}
                    placeholder={mnt?.bot_token_set ? '•••• dejar en blanco para no cambiar' : 'token de @BotFather'}
                    className="input"
                  />
                </div>
                <div>
                  <label className="label">Chat ID del grupo</label>
                  <input value={mntChatId} onChange={(e) => setMntChatId(e.target.value)} placeholder="-1001234567890" className="input" />
                </div>
                <div>
                  <label className="label">Topic ID</label>
                  <input value={mntTopicId} onChange={(e) => setMntTopicId(e.target.value)} placeholder="opcional" className="input" />
                </div>
              </div>
              <label className="flex items-center justify-between gap-4 rounded-xl border border-bg-600 bg-bg-950/30 p-4 cursor-pointer">
                <span>
                  <span className="block font-bold">Enviar sin sonido</span>
                  <span className="block text-xs text-gray-500 mt-1">Avisos de "va a borrarse" y "salvada por…" llegan silenciados al grupo.</span>
                </span>
                <input type="checkbox" checked={mntSilent} onChange={(e) => setMntSilent(e.target.checked)} className="w-5 h-5 accent-red-500" />
              </label>
            </MiniSection>

            <MiniSection title="Mensajes">
              <div>
                <label className="label">Texto del aviso de borrado — películas</label>
                <textarea
                  value={mntDeleteMessage}
                  onChange={(e) => setMntDeleteMessage(e.target.value)}
                  rows={3}
                  className="input min-h-20 resize-y"
                />
                <p className="text-xs text-gray-500 mt-2">
                  Variables: <span className="text-gray-300">{'{titulo}'}</span>,{' '}
                  <span className="text-gray-300">{'{dias}'}</span> (frase " en N días", vacía si no aplica),{' '}
                  <span className="text-gray-300">{'{fecha}'}</span> (día concreto del borrado, p.ej. "22 de julio") y{' '}
                  <span className="text-gray-300">{'{diasSalvado}'}</span> (número de días extra al salvar).
                </p>
              </div>
              <div>
                <label className="label">Texto del aviso de borrado — series</label>
                <textarea
                  value={mntDeleteMessageTv}
                  onChange={(e) => setMntDeleteMessageTv(e.target.value)}
                  rows={3}
                  className="input min-h-20 resize-y"
                />
                <p className="text-xs text-gray-500 mt-2">
                  Mismas variables que el de películas. <span className="text-gray-300">{'{titulo}'}</span> ya
                  nombra serie y temporada ("la serie «X» (temporada N)") — este texto es aparte por si
                  quieres un tono o emoji distinto para series.
                </p>
              </div>
              <div>
                <label className="label">Texto al salvar</label>
                <textarea
                  value={mntSavedMessage}
                  onChange={(e) => setMntSavedMessage(e.target.value)}
                  rows={2}
                  className="input min-h-16 resize-y"
                />
                <p className="text-xs text-gray-500 mt-2">
                  Variables: <span className="text-gray-300">{'{usuario}'}</span> y{' '}
                  <span className="text-gray-300">{'{dias}'}</span> (frase con los días extra, vacía si no aplica).
                </p>
              </div>
            </MiniSection>

            <MiniSection title="Colecciones: qué va a dónde al salvar">
              <ol className="text-xs text-gray-500 mt-1 mb-3 list-decimal list-inside space-y-1">
                <li>En Maintainerr crea la colección de borrado (regla Radarr/Sonarr) como siempre.</li>
                <li>Crea otra colección en la <strong>misma biblioteca y tipo</strong> para "salvados", con los días extra en "delete after days". El nombre es libre — Maintainerr no deja mezclar bibliotecas ni tipos al mover media entre colecciones, por eso solo aparecen como opción las compatibles.</li>
                <li>Pulsa "Cargar colecciones de Maintainerr" y, para cada colección de borrado, elige a mano a cuál de salvados se mueve la película. Nada se adivina por nombre — si no eliges destino, esa colección se queda sin botón "Salvar".</li>
                <li>En Maintainerr añade el webhook de abajo como agente (Settings → Notifications → Webhook Agent), payload <code>{'{}'}</code>, evento "Media Added To Collection".</li>
              </ol>
              <button type="button" onClick={loadMaintainerrCollections} className="btn btn-ghost">Cargar colecciones de Maintainerr</button>
              {mntLiveCollections && mntLiveCollections.length > 0 && (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="pr-3 pb-1 font-medium">Colección en Maintainerr</th>
                        <th className="pr-3 pb-1 font-medium">Biblioteca</th>
                        <th className="pb-1 font-medium">Al salvar, mover a</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mntLiveCollections.map((c) => {
                        const compatible = mntLiveCollections.filter(
                          (o) => o.id !== c.id && o.type === c.type && o.libraryId === c.libraryId
                        );
                        return (
                          <tr key={c.id} className="border-t border-bg-700/70">
                            <td className="pr-3 py-1 text-gray-300">{c.title}</td>
                            <td className="pr-3 py-1 text-gray-500">{c.type}, biblioteca {c.libraryId}</td>
                            <td className="py-1">
                              <select
                                value={mntPairsMap[c.title] ?? ''}
                                onChange={(e) => setPairTarget(c.title, e.target.value)}
                                className="input py-1"
                              >
                                <option value="">— no salvable —</option>
                                {compatible.map((o) => (
                                  <option key={o.id} value={o.title}>
                                    {o.title} ({o.deleteAfterDays ?? '—'} días)
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </MiniSection>

            {mnt?.webhookUrl && (
              <MiniSection title="Webhook">
                <label className="label">Agente Webhook, payload {'{}'}, evento "Media Added To Collection"</label>
                <code className="block text-xs bg-bg-950/60 border border-bg-600 rounded-lg p-2 break-all select-all">{mnt.webhookUrl}</code>
                <p className="text-xs text-gray-500">
                  Solo dispara cuando el propio motor de reglas de Maintainerr añade el ítem. Una alta que no
                  pase por ahí (a mano, u otra vía de su panel) no lo llama — por eso limitARR también revisa
                  las colecciones cada 5 min por su cuenta, para no depender de eso.
                </p>
              </MiniSection>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <button type="button" onClick={saveMaintainerr} disabled={savingMnt} className="btn btn-primary">
                {savingMnt ? 'Guardando…' : 'Guardar módulo'}
              </button>
            </div>
            {mntResult && <p aria-live="polite" className="text-xs text-gray-500 whitespace-pre-wrap">{mntResult}</p>}
          </div>
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
