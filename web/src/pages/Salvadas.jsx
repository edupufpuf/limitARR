import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useDirty } from '../DirtyGuard.jsx';
import { IconSearch, IconUsers, IconSave } from '../icons.jsx';
import { SalvadosGrid, salvadoDaysLeft, SalvadosHistoryList } from '../components/Salvados.jsx';

const REFRESH_MS = 60_000;

function soonestDaysLeft(items) {
  return items.reduce((min, item) => Math.min(min, salvadoDaysLeft(item)), Infinity);
}

function GroupCard({ group, expanded, onToggle }) {
  const soonest = soonestDaysLeft(group.items);
  return (
    <div className="card overflow-hidden hover:border-bg-600/80 transition-colors">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-bg-700/40 transition-colors"
      >
        <span className="w-12 h-12 rounded-full overflow-hidden bg-bg-700 flex items-center justify-center flex-shrink-0">
          {group.isGroup ? (
            <IconUsers className="w-5 h-5 text-gray-300" />
          ) : group.avatar ? (
            <img src={group.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <span className="text-xs font-bold">{group.label.slice(0, 2).toUpperCase()}</span>
          )}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold truncate">
            {group.label}
            {!group.linked && (
              <span className="ml-1.5 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-bg-700 text-gray-400 ring-1 ring-bg-600 align-middle">
                sin vincular
              </span>
            )}
          </div>
          <div className="text-xs text-gray-500 truncate">
            {group.items.length} salvada{group.items.length === 1 ? '' : 's'}
            {Number.isFinite(soonest) && ` · la más próxima caduca en ${soonest} día${soonest === 1 ? '' : 's'}`}
          </div>
        </div>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4 bg-bg-900/30">
          <SalvadosGrid items={group.items} />
        </div>
      )}
    </div>
  );
}

function Chevron({ open }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`w-5 h-5 transition-transform ${open ? 'rotate-180' : ''}`}>
      <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
    </svg>
  );
}

// Sub-desplegable para trocear la config de Maintainerr (conexión + mensajes
// + colecciones + webhook + plazo de gracia) — todo en un bloque se veía como
// una pared de campos.
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

// Fila de plazo de gracia de UNA biblioteca: vacío = usa el global de arriba
// (salvado_grace_days NULL en la tabla libraries).
function LibraryGraceRow({ lib, globalDays, onSaved }) {
  const [value, setValue] = useState(lib.salvado_grace_days ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = String(value) !== String(lib.salvado_grace_days ?? '');

  async function save() {
    setSaving(true);
    try {
      const salvadoGraceDays = value === '' ? null : Number(value);
      await api.updateLibrary(lib.id, { salvadoGraceDays });
      onSaved(lib.id, salvadoGraceDays);
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-t border-bg-700/70">
      <td className="pr-3 py-1.5 text-gray-300">{lib.name}</td>
      <td className="pr-3 py-1.5">
        <input
          type="number"
          min="1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={String(globalDays)}
          className="input py-1 max-w-[6rem]"
        />
      </td>
      <td className="py-1.5">
        <button type="button" onClick={save} disabled={!dirty || saving} className="btn btn-ghost py-1">
          {saving ? 'Guardando…' : 'Guardar'}
        </button>
      </td>
    </tr>
  );
}

export default function Salvadas() {
  const [salvados, setSalvados] = useState([]);
  const [history, setHistory] = useState([]);
  const [users, setUsers] = useState([]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(new Set());

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
  const [mntGraceDays, setMntGraceDays] = useState(5);
  const [mntResult, setMntResult] = useState(null);
  const [mntLiveCollections, setMntLiveCollections] = useState(null);
  const [mntPairsMap, setMntPairsMap] = useState({}); // { tituloOrigen: tituloDestino }
  const [savingMnt, setSavingMnt] = useState(false);
  const [libraries, setLibraries] = useState([]);

  function load() {
    api.salvados().then(setSalvados).catch(() => {});
    api.salvadosHistory(30).then(setHistory).catch(() => {});
  }

  useEffect(() => {
    load();
    api.users().then(setUsers).catch(() => {});
    api.libraries().then(setLibraries).catch(() => {});
    api.maintainerrSettings().then((m) => {
      setMnt(m);
      setMntUrl(m.url ?? '');
      setMntChatId(m.chatId ?? '');
      setMntTopicId(m.topicId ?? '');
      setMntSilent(Boolean(m.silent));
      setMntSavedMessage(m.savedMessage ?? '');
      setMntDeleteMessage(m.deleteMessage ?? '');
      setMntDeleteMessageTv(m.deleteMessageTv ?? '');
      setMntGraceDays(m.salvadoGraceDays ?? 5);
      const map = {};
      (m.pairs ?? []).forEach((p) => { map[p.source] = p.target; });
      setMntPairsMap(map);
    }).catch(() => {});
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

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
        mntGraceDays !== (mnt.salvadoGraceDays ?? 5) ||
        normalizePairs(mntPairsMap) !== normalizePairs(Object.fromEntries((mnt.pairs ?? []).map((p) => [p.source, p.target]))))
  );
  useDirty('salvadas-maintainerr', mntDirty);

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
        salvadoGraceDays: mntGraceDays,
      });
      setMnt((prev) => ({ ...prev, ...m }));
      setMntSavedMessage(m.savedMessage ?? mntSavedMessage);
      setMntDeleteMessage(m.deleteMessage ?? mntDeleteMessage);
      setMntDeleteMessageTv(m.deleteMessageTv ?? mntDeleteMessageTv);
      setMntGraceDays(m.salvadoGraceDays ?? mntGraceDays);
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

  function onLibraryGraceSaved(libraryId, salvadoGraceDays) {
    setLibraries((prev) => prev.map((l) => (l.id === libraryId ? { ...l, salvado_grace_days: salvadoGraceDays } : l)));
  }

  // Agrupa por user_id (Tautulli, resuelto vía telegram_links al salvar); sin
  // vincular cae a un cubo por nombre de Telegram — no hay tarjeta de cupo
  // donde colgarlo, pero sigue siendo útil verlo.
  const groups = useMemo(() => {
    const byUserId = new Map(users.map((u) => [u.userId, u]));
    const map = new Map();
    for (const s of salvados) {
      const key = s.user_id != null ? `u:${s.user_id}` : `tg:${s.telegram_name ?? 'desconocido'}`;
      if (!map.has(key)) {
        const user = s.user_id != null ? byUserId.get(s.user_id) : null;
        map.set(key, {
          key,
          label: user?.username ?? s.telegram_name ?? 'Sin vincular',
          avatar: user?.avatar ?? null,
          isGroup: user?.isGroup ?? false,
          linked: s.user_id != null,
          items: [],
        });
      }
      map.get(key).items.push(s);
    }
    return [...map.values()].sort((a, b) => soonestDaysLeft(a.items) - soonestDaysLeft(b.items));
  }, [salvados, users]);

  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return groups.filter((g) => !q || g.label.toLowerCase().includes(q));
  }, [groups, query]);

  function toggle(key) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h2 className="page-title">Salvadas por usuario</h2>
          <p className="text-sm text-gray-500 mt-1">
            Películas rescatadas del borrado de Maintainerr con 💾 Salvar en Telegram. Se refresca solo cada minuto.
          </p>
        </div>
      </div>

      <div className="relative mb-4 max-w-xs">
        <IconSearch className="w-4 h-4 text-gray-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar usuario…"
          className="input pl-8"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {visibleGroups.map((g) => (
          <GroupCard key={g.key} group={g} expanded={expanded.has(g.key)} onToggle={() => toggle(g.key)} />
        ))}
      </div>

      {salvados.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">
          Nadie ha salvado ninguna película todavía.
        </p>
      )}
      {salvados.length > 0 && visibleGroups.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">Ningún usuario coincide con "{query}".</p>
      )}

      <h2 className="page-title mt-8 mb-1">Últimos 30 días</h2>
      <p className="text-sm text-gray-500 mb-4">
        Todo lo salvado en el último mes, se haya borrado ya o no, con si cada uno la ha visto.
      </p>
      <SalvadosHistoryList items={history} />

      <div className="flex items-center gap-2 mt-10 mb-1">
        <IconSave className="w-5 h-5 text-gray-400" />
        <h2 className="page-title">Salvar del borrado (Maintainerr)</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4 max-w-2xl">
        Usa un bot de Telegram <strong>dedicado</strong> (no el de los avisos de cupo: Telegram solo
        permite un lector de updates por token). Al pulsar 💾 Salvar, el ítem pasa a la colección de
        salvados y se registra quién lo salvó.
      </p>

      {mnt && (
        <div className="card p-4 sm:p-5 space-y-3">
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
                Variables: <span className="text-gray-300">{'{usuario}'}</span>,{' '}
                <span className="text-gray-300">{'{dias}'}</span> (frase con los días extra, vacía si no aplica) y{' '}
                <span className="text-gray-300">{'{fecha}'}</span> (nueva fecha de borrado tras salvar, p.ej. "22 de julio").
              </p>
            </div>
          </MiniSection>

          <MiniSection title="Plazo de gracia al salvar" defaultOpen>
            <div>
              <label className="label">Por defecto (días)</label>
              <input
                type="number"
                min="1"
                value={mntGraceDays}
                onChange={(e) => setMntGraceDays(Number(e.target.value))}
                className="input max-w-[8rem]"
              />
              <p className="text-xs text-gray-500 mt-2">
                Si no la ve todo el que la salvó, se borra a estos días contados desde el ÚLTIMO salvado
                (si se suma más gente, todos tienen su plazo entero — no se suma con nada más). Si la ven
                todos antes, se borra 24h después del último en verla — este plazo es solo el límite
                máximo si nadie la ve. Se guarda con el botón "Guardar módulo" de abajo.
              </p>
            </div>

            {libraries.length > 0 && (
              <div>
                <label className="label">Por biblioteca (vacío = usa el de arriba)</label>
                <div className="overflow-x-auto mt-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-gray-500">
                        <th className="pr-3 pb-1 font-medium">Biblioteca</th>
                        <th className="pr-3 pb-1 font-medium">Días</th>
                        <th className="pb-1 font-medium"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {libraries.map((lib) => (
                        <LibraryGraceRow key={lib.id} lib={lib} globalDays={mnt.salvadoGraceDays} onSaved={onLibraryGraceSaved} />
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-gray-500 mt-2">Este cambio se guarda al vuelo, por biblioteca — no hace falta "Guardar módulo".</p>
              </div>
            )}
          </MiniSection>

          <MiniSection title="Colecciones: qué va a dónde al salvar">
            <ol className="text-xs text-gray-500 mt-1 mb-3 list-decimal list-inside space-y-1">
              <li>En Maintainerr crea la colección de borrado (regla Radarr/Sonarr) como siempre.</li>
              <li>Crea otra colección en la <strong>misma biblioteca y tipo</strong> para "salvados" (el nombre es libre; los días de "delete after days" de ESTA ya no importan — limitARR decide cuándo borrarla de verdad, ver "Plazo de gracia" arriba). Maintainerr no deja mezclar bibliotecas ni tipos al mover media entre colecciones, por eso solo aparecen como opción las compatibles.</li>
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
      )}
    </div>
  );
}
