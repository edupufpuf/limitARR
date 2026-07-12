import { useEffect, useState } from 'react';
import { api } from '../api.js';

function GroupCard({ group, users, libraries, onChanged }) {
  // Límite y caducidad por biblioteca como texto del input: '' = sin override.
  const [limits, setLimits] = useState({});
  const [expiries, setExpiries] = useState({});

  useEffect(() => {
    setLimits(
      Object.fromEntries(
        libraries.map((l) => [
          l.id,
          group.overrides.find((o) => o.library_id === l.id)?.limit_override ?? '',
        ])
      )
    );
    setExpiries(
      Object.fromEntries(
        libraries.map((l) => [
          l.id,
          group.overrides.find((o) => o.library_id === l.id)?.expiry_override ?? '',
        ])
      )
    );
  }, [group, libraries]);

  async function toggleMember(userId) {
    const next = group.members.includes(userId)
      ? group.members.filter((id) => id !== userId)
      : [...group.members, userId];
    await api.setGroupMembers(group.id, next);
    onChanged();
  }

  async function saveLimit(libraryId) {
    const value = limits[libraryId];
    if (value === '') {
      if (group.overrides.some((o) => o.library_id === libraryId)) {
        await api.deleteGroupOverride(group.id, libraryId);
      }
    } else {
      const expiry = expiries[libraryId];
      await api.setGroupOverride(group.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiry === '' ? null : Number(expiry),
      });
    }
    onChanged();
  }

  async function removeGroup() {
    if (!window.confirm(`¿Eliminar el grupo "${group.name}"? Sus miembros vuelven al límite de biblioteca.`)) return;
    await api.deleteGroup(group.id);
    onChanged();
  }

  async function toggleAggregated() {
    await api.updateGroup(group.id, { aggregated: !group.aggregated });
    onChanged();
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">
          {group.name}
          {Boolean(group.aggregated) && (
            <span className="ml-2 text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/40 align-middle">
              cupo agregado
            </span>
          )}
        </h3>
        <button onClick={removeGroup} className="text-accent-400 text-xs">
          eliminar grupo
        </button>
      </div>

      <label className="flex items-start gap-2 mb-4 cursor-pointer">
        <input
          type="checkbox"
          checked={Boolean(group.aggregated)}
          onChange={toggleAggregated}
          className="mt-0.5 accent-accent-500"
        />
        <span className="text-xs text-gray-400">
          <span className="text-gray-200 font-medium">Cupo grupal agregado</span> — el grupo
          cuenta como un solo usuario: las solicitudes de todos los miembros comparten cupo,
          verla cualquiera lo libera, y en la pestaña Cupo aparece el grupo en vez de los
          miembros. Los overrides individuales dejan de aplicar.
        </span>
      </label>

      <div className="label mb-1.5">Miembros</div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {users.map((u) => {
          const inGroup = group.members.includes(u.id);
          return (
            <button
              key={u.id}
              onClick={() => toggleMember(u.id)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                inGroup
                  ? 'bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/40'
                  : 'bg-bg-700/60 text-gray-500 hover:text-gray-300'
              }`}
            >
              {u.username}
            </button>
          );
        })}
      </div>

      <div className="label mb-1.5">Límite y caducidad (días) por biblioteca (vacío = el de la biblioteca)</div>
      <div className="flex flex-wrap gap-3">
        {libraries.map((l) => {
          const savedOverride = group.overrides.find((o) => o.library_id === l.id);
          const savedLimit = savedOverride?.limit_override ?? '';
          const savedExpiry = savedOverride?.expiry_override ?? '';
          const dirty =
            String(limits[l.id] ?? '') !== String(savedLimit) ||
            String(expiries[l.id] ?? '') !== String(savedExpiry);
          return (
            <div key={l.id} className="flex items-center gap-2 text-sm">
              <span className="text-gray-400">{l.name}</span>
              <input
                type="number"
                min={0}
                value={limits[l.id] ?? ''}
                onChange={(e) => setLimits({ ...limits, [l.id]: e.target.value })}
                className="input w-16 py-1"
                title="Límite"
              />
              <input
                type="number"
                min={0}
                value={expiries[l.id] ?? ''}
                onChange={(e) => setExpiries({ ...expiries, [l.id]: e.target.value })}
                className="input w-16 py-1"
                placeholder="cad."
                title="Caducidad en días (0 = no caduca; vacío = la de la biblioteca)"
              />
              {dirty && (
                <button onClick={() => saveLimit(l.id)} className="btn btn-primary py-1 px-2.5 text-xs">
                  Guardar
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Overrides() {
  const [overrides, setOverrides] = useState([]);
  const [groups, setGroups] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [users, setUsers] = useState([]);
  const [libraries, setLibraries] = useState([]);
  const [form, setForm] = useState({ userId: '', libraryId: '', limitOverride: 4, expiryOverride: '', note: '' });
  const [bulkForm, setBulkForm] = useState({ libraryId: '', limitOverride: 2 });
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  function load() {
    api.overrides().then(setOverrides);
    api.groups().then(setGroups);
  }

  async function createGroup(e) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    await api.createGroup(newGroupName.trim());
    setNewGroupName('');
    load();
  }

  useEffect(() => {
    load();
    api.users().then(setUsers);
    api.libraries().then(setLibraries);
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!form.userId || !form.libraryId) return;
    await api.setOverride(form.userId, form.libraryId, {
      limitOverride: Number(form.limitOverride),
      expiryOverride: form.expiryOverride === '' ? null : Number(form.expiryOverride),
      note: form.note,
    });
    setForm({ ...form, note: '' });
    load();
  }

  async function remove(userId, libraryId) {
    await api.deleteOverride(userId, libraryId);
    load();
  }

  async function applyBulk(e) {
    e.preventDefault();
    if (!bulkForm.libraryId) return;
    setApplyingBulk(true);
    setBulkResult(null);
    const { applied } = await api.bulkSetOverride(bulkForm.libraryId, Number(bulkForm.limitOverride));
    setBulkResult(`Aplicado a ${applied} usuario(s)`);
    load();
    setApplyingBulk(false);
  }

  const userName = (id) => users.find((u) => u.id === id)?.username ?? `user#${id}`;
  const libName = (id) => libraries.find((l) => l.id === id)?.name ?? `#${id}`;

  return (
    <div>
      <h2 className="page-title mb-1">Overrides</h2>
      <p className="text-xs text-gray-500 mb-4">
        Precedencia del límite: override individual &gt; override de grupo &gt; límite de la
        biblioteca. Pon 0 para bloquear del todo.
      </p>

      <h3 className="text-sm font-semibold text-gray-300 mb-2">Grupos</h3>
      <form onSubmit={createGroup} className="flex gap-2 mb-3">
        <input
          value={newGroupName}
          onChange={(e) => setNewGroupName(e.target.value)}
          placeholder="Nombre del grupo (p.ej. Familia)"
          className="input py-1 max-w-xs"
        />
        <button type="submit" className="btn btn-primary">
          Crear grupo
        </button>
      </form>
      {groups.length > 0 && (
        <div className="space-y-3 mb-6">
          {groups.map((g) => (
            <GroupCard key={g.id} group={g} users={users} libraries={libraries} onChanged={load} />
          ))}
        </div>
      )}
      <p className="text-[11px] text-gray-600 mb-6">
        Cada usuario puede estar como mucho en un grupo: marcarlo en otro lo mueve.
      </p>

      <h3 className="text-sm font-semibold text-gray-300 mb-2">Overrides individuales</h3>

      <form onSubmit={applyBulk} className="card p-4 mb-4 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label">Biblioteca</label>
          <select
            value={bulkForm.libraryId}
            onChange={(e) => setBulkForm({ ...bulkForm, libraryId: e.target.value })}
            className="input w-auto py-1"
          >
            <option value="">—</option>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Límite para todos</label>
          <input
            type="number"
            min={0}
            value={bulkForm.limitOverride}
            onChange={(e) => setBulkForm({ ...bulkForm, limitOverride: e.target.value })}
            className="input w-20 py-1"
          />
        </div>
        <button
          type="submit"
          disabled={applyingBulk}
          className="btn btn-primary"
        >
          {applyingBulk ? 'Aplicando…' : 'Aplicar a todos'}
        </button>
        {bulkResult && <span className="text-xs text-gray-500">{bulkResult}</span>}
      </form>

      <form onSubmit={submit} className="card p-4 mb-6 flex flex-wrap gap-3 items-end">
        <div>
          <label className="label">Usuario</label>
          <select
            value={form.userId}
            onChange={(e) => setForm({ ...form, userId: e.target.value })}
            className="input w-auto py-1"
          >
            <option value="">—</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Biblioteca</label>
          <select
            value={form.libraryId}
            onChange={(e) => setForm({ ...form, libraryId: e.target.value })}
            className="input w-auto py-1"
          >
            <option value="">—</option>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Límite</label>
          <input
            type="number"
            min={0}
            value={form.limitOverride}
            onChange={(e) => setForm({ ...form, limitOverride: e.target.value })}
            className="input w-20 py-1"
          />
        </div>
        <div>
          <label className="label" title="Días hasta que un pendiente sin ver sale del cupo. 0 = no caduca; vacío = la de la biblioteca.">
            Caducidad
          </label>
          <input
            type="number"
            min={0}
            value={form.expiryOverride}
            onChange={(e) => setForm({ ...form, expiryOverride: e.target.value })}
            placeholder="días"
            className="input w-20 py-1"
          />
        </div>
        <div className="flex-1 min-w-[120px]">
          <label className="label">Nota</label>
          <input
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            className="input py-1"
          />
        </div>
        <button type="submit" className="btn btn-primary">
          Guardar override
        </button>
      </form>

      <div className="card overflow-x-auto px-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-bg-700">
              <th className="th">Usuario</th>
              <th className="th">Biblioteca</th>
              <th className="th">Límite</th>
              <th className="th">Caducidad</th>
              <th className="th">Nota</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={`${o.user_id}-${o.library_id}`} className="border-b border-bg-700/50 last:border-0 hover:bg-bg-700/20 transition-colors">
                <td className="py-2 pr-4 whitespace-nowrap">{userName(o.user_id)}</td>
                <td className="py-2 pr-4 whitespace-nowrap">{libName(o.library_id)}</td>
                <td className="py-2 pr-4">{o.limit_override}</td>
                <td className="py-2 pr-4 text-gray-400">
                  {o.expiry_override == null ? '—' : o.expiry_override === 0 ? 'no caduca' : `${o.expiry_override} días`}
                </td>
                <td className="py-2 pr-4 text-gray-400">{o.note}</td>
                <td className="py-2 pr-4">
                  <button onClick={() => remove(o.user_id, o.library_id)} className="text-accent-400 text-xs">
                    eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
