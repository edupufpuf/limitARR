import { useEffect, useState } from 'react';
import { api } from '../api.js';

function GroupCard({ group, users, libraries, onChanged }) {
  // Límite, caducidad y cupo mensual por biblioteca como texto del input: '' = sin override.
  const [limits, setLimits] = useState({});
  const [expiries, setExpiries] = useState({});
  const [monthlyLimits, setMonthlyLimits] = useState({});

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
    setMonthlyLimits(
      Object.fromEntries(
        libraries.map((l) => [
          l.id,
          group.overrides.find((o) => o.library_id === l.id)?.monthly_limit_override ?? '',
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
      const monthly = monthlyLimits[libraryId];
      await api.setGroupOverride(group.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiry === '' ? null : Number(expiry),
        monthlyLimitOverride: monthly === '' ? null : Number(monthly),
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

      <div className="label mb-1.5">Límite, caducidad y cupo mensual por biblioteca (vacío = el de la biblioteca)</div>
      <div className="flex flex-wrap gap-3">
        {libraries.map((l) => {
          const savedOverride = group.overrides.find((o) => o.library_id === l.id);
          const savedLimit = savedOverride?.limit_override ?? '';
          const savedExpiry = savedOverride?.expiry_override ?? '';
          const savedMonthly = savedOverride?.monthly_limit_override ?? '';
          const dirty =
            String(limits[l.id] ?? '') !== String(savedLimit) ||
            String(expiries[l.id] ?? '') !== String(savedExpiry) ||
            String(monthlyLimits[l.id] ?? '') !== String(savedMonthly);
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
              <input
                type="number"
                min={0}
                value={monthlyLimits[l.id] ?? ''}
                onChange={(e) => setMonthlyLimits({ ...monthlyLimits, [l.id]: e.target.value })}
                className="input w-16 py-1"
                placeholder="mes"
                title="Cupo mensual (0 = bloquear el mes; vacío = el de la biblioteca)"
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

// v2: rol — mismo patrón que GroupCard (un usuario tiene como mucho un rol),
// pero sin el toggle de cupo agregado (eso es cosa de grupos) y con un tercer
// campo por biblioteca: el cupo mensual (0 = bloquear el mes entero, vacío =
// el de la biblioteca).
function RoleCard({ role, users, libraries, onChanged }) {
  const [limits, setLimits] = useState({});
  const [expiries, setExpiries] = useState({});
  const [monthlyLimits, setMonthlyLimits] = useState({});

  useEffect(() => {
    setLimits(
      Object.fromEntries(
        libraries.map((l) => [l.id, role.overrides.find((o) => o.library_id === l.id)?.limit_override ?? ''])
      )
    );
    setExpiries(
      Object.fromEntries(
        libraries.map((l) => [l.id, role.overrides.find((o) => o.library_id === l.id)?.expiry_override ?? ''])
      )
    );
    setMonthlyLimits(
      Object.fromEntries(
        libraries.map((l) => [l.id, role.overrides.find((o) => o.library_id === l.id)?.monthly_limit_override ?? ''])
      )
    );
  }, [role, libraries]);

  async function toggleMember(userId) {
    const next = role.members.includes(userId)
      ? role.members.filter((id) => id !== userId)
      : [...role.members, userId];
    await api.setRoleMembers(role.id, next);
    onChanged();
  }

  async function saveLimit(libraryId) {
    const value = limits[libraryId];
    if (value === '') {
      if (role.overrides.some((o) => o.library_id === libraryId)) {
        await api.deleteRoleOverride(role.id, libraryId);
      }
    } else {
      const expiry = expiries[libraryId];
      const monthly = monthlyLimits[libraryId];
      await api.setRoleOverride(role.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiry === '' ? null : Number(expiry),
        monthlyLimitOverride: monthly === '' ? null : Number(monthly),
      });
    }
    onChanged();
  }

  async function removeRole() {
    if (!window.confirm(`¿Eliminar el rol "${role.name}"? Sus miembros vuelven al límite de biblioteca (o de su grupo).`)) return;
    await api.deleteRole(role.id);
    onChanged();
  }

  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{role.name}</h3>
        <button onClick={removeRole} className="text-accent-400 text-xs">
          eliminar rol
        </button>
      </div>

      <div className="label mb-1.5">Miembros</div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {users.map((u) => {
          const inRole = role.members.includes(u.id);
          return (
            <button
              key={u.id}
              onClick={() => toggleMember(u.id)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                inRole
                  ? 'bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/40'
                  : 'bg-bg-700/60 text-gray-500 hover:text-gray-300'
              }`}
            >
              {u.username}
            </button>
          );
        })}
      </div>

      <div className="label mb-1.5">Límite, caducidad y cupo mensual por biblioteca (vacío = el de la biblioteca)</div>
      <div className="flex flex-wrap gap-3">
        {libraries.map((l) => {
          const savedOverride = role.overrides.find((o) => o.library_id === l.id);
          const savedLimit = savedOverride?.limit_override ?? '';
          const savedExpiry = savedOverride?.expiry_override ?? '';
          const savedMonthly = savedOverride?.monthly_limit_override ?? '';
          const dirty =
            String(limits[l.id] ?? '') !== String(savedLimit) ||
            String(expiries[l.id] ?? '') !== String(savedExpiry) ||
            String(monthlyLimits[l.id] ?? '') !== String(savedMonthly);
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
              <input
                type="number"
                min={0}
                value={monthlyLimits[l.id] ?? ''}
                onChange={(e) => setMonthlyLimits({ ...monthlyLimits, [l.id]: e.target.value })}
                className="input w-16 py-1"
                placeholder="mes"
                title="Cupo mensual (0 = bloquear el mes; vacío = el de la biblioteca)"
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

// Ficha de un usuario: de un vistazo, su grupo y rol asignados (badges, de
// solo lectura aquí — se asignan desde las secciones de Grupos/Roles de
// arriba) y sus overrides propios por biblioteca, editables igual que en
// GroupCard/RoleCard. Colapsada por defecto para que la lista quepa aunque
// haya muchos usuarios en el servidor.
function UserFicha({ user, group, role, overrides, libraries, expanded, onToggle, libName, onChanged }) {
  const [limits, setLimits] = useState({});
  const [expiries, setExpiries] = useState({});
  const [monthlyLimits, setMonthlyLimits] = useState({});
  const [notes, setNotes] = useState({});

  useEffect(() => {
    setLimits(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.limit_override ?? ''])));
    setExpiries(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.expiry_override ?? ''])));
    setMonthlyLimits(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.monthly_limit_override ?? ''])));
    setNotes(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.note ?? ''])));
  }, [overrides, libraries]);

  async function saveLimit(libraryId) {
    const value = limits[libraryId];
    if (value === '') {
      if (overrides.some((o) => o.library_id === libraryId)) {
        await api.deleteOverride(user.id, libraryId);
      }
    } else {
      await api.setOverride(user.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiries[libraryId] === '' ? null : Number(expiries[libraryId]),
        monthlyLimitOverride: monthlyLimits[libraryId] === '' ? null : Number(monthlyLimits[libraryId]),
        note: notes[libraryId] || '',
      });
    }
    onChanged();
  }

  async function clearLimit(libraryId) {
    await api.deleteOverride(user.id, libraryId);
    onChanged();
  }

  return (
    <div className="card overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center gap-3 p-3 text-left hover:bg-bg-700/40 transition-colors">
        <span className="w-8 h-8 rounded-full bg-bg-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
          {user.username.slice(0, 2).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate flex items-center gap-1.5 flex-wrap">
            {user.username}
            {group && (
              <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/40">
                {group.name}
              </span>
            )}
            {role && (
              <span className="text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-sky-600/20 text-sky-300 ring-1 ring-sky-500/40">
                {role.name}
              </span>
            )}
          </div>
          {overrides.length > 0 && (
            <div className="text-xs text-gray-500 truncate">
              {overrides.length} override{overrides.length > 1 ? 's' : ''} propio{overrides.length > 1 ? 's' : ''}: {overrides.map((o) => libName(o.library_id)).join(', ')}
            </div>
          )}
        </div>
        <span className="text-gray-500 text-xs">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="border-t border-bg-700 p-4">
          <div className="label mb-1.5">Overrides propios por biblioteca (vacío = herencia normal: grupo &gt; rol &gt; biblioteca)</div>
          <div className="flex flex-col gap-2">
            {libraries.map((l) => {
              const saved = overrides.find((o) => o.library_id === l.id);
              const dirty =
                String(limits[l.id] ?? '') !== String(saved?.limit_override ?? '') ||
                String(expiries[l.id] ?? '') !== String(saved?.expiry_override ?? '') ||
                String(monthlyLimits[l.id] ?? '') !== String(saved?.monthly_limit_override ?? '') ||
                String(notes[l.id] ?? '') !== String(saved?.note ?? '');
              return (
                <div key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-gray-400 w-24 truncate">{l.name}</span>
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
                    title="Caducidad en días (0 = no caduca; vacío = herencia)"
                  />
                  <input
                    type="number"
                    min={0}
                    value={monthlyLimits[l.id] ?? ''}
                    onChange={(e) => setMonthlyLimits({ ...monthlyLimits, [l.id]: e.target.value })}
                    className="input w-16 py-1"
                    placeholder="mes"
                    title="Cupo mensual (0 = bloquear el mes; vacío = herencia)"
                  />
                  <input
                    value={notes[l.id] ?? ''}
                    onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
                    placeholder="nota"
                    className="input w-32 py-1"
                  />
                  {dirty && (
                    <button onClick={() => saveLimit(l.id)} className="btn btn-primary py-1 px-2.5 text-xs">
                      Guardar
                    </button>
                  )}
                  {!dirty && saved && (
                    <button onClick={() => clearLimit(l.id)} className="text-accent-400 text-xs">
                      quitar
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Users() {
  const [overrides, setOverrides] = useState([]);
  const [groups, setGroups] = useState([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [roles, setRoles] = useState([]);
  const [newRoleName, setNewRoleName] = useState('');
  const [users, setUsers] = useState([]);
  const [libraries, setLibraries] = useState([]);
  const [bulkForm, setBulkForm] = useState({ libraryId: '', limitOverride: 2 });
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);
  const [query, setQuery] = useState('');
  const [expandedUsers, setExpandedUsers] = useState(new Set());

  function load() {
    api.overrides().then(setOverrides);
    api.groups().then(setGroups);
    api.roles().then(setRoles);
  }

  async function createGroup(e) {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    await api.createGroup(newGroupName.trim());
    setNewGroupName('');
    load();
  }

  async function createRole(e) {
    e.preventDefault();
    if (!newRoleName.trim()) return;
    await api.createRole(newRoleName.trim());
    setNewRoleName('');
    load();
  }

  useEffect(() => {
    load();
    api.users().then(setUsers);
    // Bibliotecas deshabilitadas no aparecen aquí: no tiene sentido ponerles
    // override si no están activas (se gestionan solo desde Bibliotecas).
    api.libraries().then((libs) => setLibraries(libs.filter((l) => l.enabled)));
  }, []);

  function toggleUser(userId) {
    setExpandedUsers((prev) => {
      const next = new Set(prev);
      next.has(userId) ? next.delete(userId) : next.add(userId);
      return next;
    });
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

  const libName = (id) => libraries.find((l) => l.id === id)?.name ?? `#${id}`;

  const visibleUsers = users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div>
      <h2 className="page-title mb-1">Usuarios</h2>
      <p className="text-xs text-gray-500 mb-4">
        Precedencia del límite: override individual &gt; override de grupo &gt; rol &gt; límite de la
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

      <h3 className="text-sm font-semibold text-gray-300 mb-2">Roles</h3>
      <p className="text-xs text-gray-500 mb-3">
        Un rol pone varias normas de golpe (límite, caducidad y cupo mensual por biblioteca) a todos
        sus miembros. Precedencia: override individual &gt; override de grupo &gt; rol &gt; límite de
        biblioteca — un override puntual siempre gana al rol.
      </p>
      <form onSubmit={createRole} className="flex gap-2 mb-3">
        <input
          value={newRoleName}
          onChange={(e) => setNewRoleName(e.target.value)}
          placeholder="Nombre del rol (p.ej. Amigo)"
          className="input py-1 max-w-xs"
        />
        <button type="submit" className="btn btn-primary">
          Crear rol
        </button>
      </form>
      {roles.length > 0 && (
        <div className="space-y-3 mb-4">
          {roles.map((r) => (
            <RoleCard key={r.id} role={r} users={users} libraries={libraries} onChanged={load} />
          ))}
        </div>
      )}
      <p className="text-[11px] text-gray-600 mb-6">
        Cada usuario puede tener como mucho un rol: marcarlo en otro lo mueve. Un usuario puede tener
        rol y grupo a la vez (son independientes) — el grupo gana si ambos tocan la misma biblioteca.
      </p>

      <h3 className="text-sm font-semibold text-gray-300 mb-2">Usuarios</h3>

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

      <div className="relative mb-3 max-w-xs">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar usuario…"
          className="input"
        />
      </div>

      <div className="space-y-2">
        {visibleUsers.map((u) => (
          <UserFicha
            key={u.id}
            user={u}
            group={groups.find((g) => g.members.includes(u.id))}
            role={roles.find((r) => r.members.includes(u.id))}
            overrides={overrides.filter((o) => o.user_id === u.id)}
            libraries={libraries}
            expanded={expandedUsers.has(u.id)}
            onToggle={() => toggleUser(u.id)}
            libName={libName}
            onChanged={load}
          />
        ))}
      </div>
      {users.length > 0 && visibleUsers.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">Ningún usuario coincide con "{query}".</p>
      )}
    </div>
  );
}
