import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Notifications() {
  const [botSettings, setBotSettings] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [mode, setMode] = useState('dm');
  const [groupChatId, setGroupChatId] = useState('');
  const [groupTopicId, setGroupTopicId] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [groupTestResult, setGroupTestResult] = useState(null);

  const [links, setLinks] = useState([]);
  const [users, setUsers] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [discovering, setDiscovering] = useState(false);
  const [pickUser, setPickUser] = useState({});
  const [testResult, setTestResult] = useState({});

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
    api.users().then(setUsers);
    loadLinks();
  }, []);

  async function saveSettings(e) {
    e.preventDefault();
    setSavingSettings(true);
    const s = await api.updateNotificationSettings({ botToken: tokenInput, mode, groupChatId, groupTopicId });
    setBotSettings(s);
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
      await api.testGroupNotification();
      setGroupTestResult('enviado ✓');
    } catch (err) {
      setGroupTestResult(`error: ${err.message}`);
    }
  }

  const userName = (id) => users.find((u) => u.id === id)?.username ?? `user#${id}`;

  if (!botSettings) return null;

  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-bold tracking-tight mb-1">Notificaciones (Telegram)</h2>
      <p className="text-xs text-gray-500 mb-6">
        Avisa cuando una solicitud se queda sin cupo. Crea un bot con{' '}
        <span className="text-gray-400">@BotFather</span> en Telegram y pega el token aquí.
      </p>

      <form onSubmit={saveSettings} className="card p-4 mb-6 space-y-4">
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
        </div>

        <div>
          <label className="block text-xs text-gray-400 mb-2">Dónde avisar</label>
          <div className="flex gap-4 text-sm mb-3">
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'dm'} onChange={() => setMode('dm')} />
              Mensaje directo al usuario
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={mode === 'group'} onChange={() => setMode('group')} />
              Grupo (con topics)
            </label>
          </div>

          {mode === 'group' && (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="label">Chat ID del grupo</label>
                <input
                  value={groupChatId}
                  onChange={(e) => setGroupChatId(e.target.value)}
                  placeholder="-1001234567890"
                  className="input w-40"
                />
              </div>
              <div>
                <label className="label">Topic ID (opcional)</label>
                <input
                  value={groupTopicId}
                  onChange={(e) => setGroupTopicId(e.target.value)}
                  placeholder="—"
                  className="input w-28"
                />
              </div>
              <button type="button" onClick={testGroup} className="btn btn-ghost">
                Probar
              </button>
              {groupTestResult && <span className="text-xs text-gray-500">{groupTestResult}</span>}
            </div>
          )}
        </div>

        <button type="submit" disabled={savingSettings} className="btn btn-primary">
          {savingSettings ? 'Guardando…' : 'Guardar'}
        </button>
      </form>

      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">Descubrir chats</h3>
        <button
          onClick={discover}
          disabled={discovering}
          className="btn btn-ghost"
        >
          {discovering ? 'Buscando…' : 'Buscar chats nuevos'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        Que el usuario le mande un mensaje al bot en privado (para vincular su DM), o escribe algo en
        el topic del grupo que quieras usar (para rellenar el chat/topic de arriba).
      </p>

      {discovered.length > 0 && (
        <div className="card p-4 mb-6 space-y-3">
          {discovered.map((d) => (
            <div key={`${d.chatId}-${d.messageThreadId}`} className="flex flex-wrap items-center gap-3 text-sm">
              <span className="text-gray-400 w-full sm:w-44 truncate">
                {d.chatType === 'private'
                  ? d.username ? `@${d.username}` : d.firstName ?? d.chatId
                  : `${d.chatTitle ?? 'grupo'}${d.messageThreadId ? ` · topic ${d.messageThreadId}` : ''}`}
              </span>
              <span className="text-gray-500 flex-1 truncate min-w-0">"{d.text}"</span>
              {d.chatType === 'private' ? (
                <>
                  <select
                    value={pickUser[d.chatId] ?? ''}
                    onChange={(e) => setPickUser({ ...pickUser, [d.chatId]: e.target.value })}
                    className="input w-auto py-1"
                  >
                    <option value="">— usuario Tautulli —</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() => link(d.chatId, d.username ?? d.firstName)}
                    className="bg-accent-600 hover:bg-accent-700 rounded px-3 py-1 text-xs font-semibold"
                  >
                    Vincular
                  </button>
                </>
              ) : (
                <button
                  onClick={() => useAsGroup(d)}
                  className="bg-accent-600 hover:bg-accent-700 rounded px-3 py-1 text-xs font-semibold"
                >
                  Usar como grupo destino
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <h3 className="font-semibold mb-3">Usuarios vinculados (DM)</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-bg-700">
              <th className="py-2 pr-4">Usuario</th>
              <th className="py-2 pr-4">Chat</th>
              <th className="py-2 pr-4"></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.user_id} className="border-b border-bg-800">
                <td className="py-2 pr-4 whitespace-nowrap">{userName(l.user_id)}</td>
                <td className="py-2 pr-4 text-gray-400">{l.label ?? l.chat_id}</td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  <div className="flex items-center gap-3">
                    <button onClick={() => test(l.user_id)} className="text-accent-400 text-xs">
                      probar
                    </button>
                    <button onClick={() => unlink(l.user_id)} className="text-gray-500 text-xs">
                      desvincular
                    </button>
                    {testResult[l.user_id] && <span className="text-xs text-gray-500">{testResult[l.user_id]}</span>}
                  </div>
                </td>
              </tr>
            ))}
            {links.length === 0 && (
              <tr>
                <td colSpan={3} className="py-6 text-center text-gray-500">
                  Ningún usuario vinculado todavía.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
