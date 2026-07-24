import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { SalvadosGrid } from '../components/Salvados.jsx';
import { useDirty } from '../DirtyGuard.jsx';

function FichaRow({ label, children }) {
  return (
    <div className="flex items-center gap-4 py-2 border-b border-bg-700/50 last:border-0 text-sm">
      <span className="w-28 flex-shrink-0 text-gray-400">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function FichaBadge({ tone, children }) {
  const tones = {
    accent: 'bg-accent-600/20 text-accent-300 ring-1 ring-accent-500/40',
    sky: 'bg-sky-600/20 text-sky-300 ring-1 ring-sky-500/40',
  };
  return (
    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${tones[tone]}`}>{children}</span>
  );
}

// Antes cada caja de override solo tenía título/placeholder (desaparece al
// escribir un número) — no se veía qué era cada una. Con una etiqueta fija
// encima siempre se sabe qué campo es, aunque tenga valor.
function OverrideField({ label, className, ...inputProps }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
      <input className={className ?? 'input w-20 py-1'} {...inputProps} />
    </div>
  );
}

// v3: control único (no por biblioteca) para el override del cupo mensual
// TOTAL — mismo patrón visual que OverrideField, pero con su propio guardar/
// quitar porque no vive en la grid por biblioteca de límite/caducidad/mensual.
function MonthlyTotalOverrideControl({ value, onSave, onDelete }) {
  const [input, setInput] = useState(value ?? '');
  useEffect(() => setInput(value ?? ''), [value]);
  const dirty = String(input) !== String(value ?? '');
  return (
    <div className="flex items-end gap-2 text-sm">
      <OverrideField
        label="Cupo mensual total"
        type="number"
        min={0}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        title="Todas las bibliotecas combinadas (0 = bloquear el mes; vacío = herencia/global)"
      />
      {dirty && input !== '' && (
        <button onClick={() => onSave(Number(input))} className="btn btn-primary py-1 px-2.5 text-xs mb-0.5">
          Guardar
        </button>
      )}
      {dirty && input === '' && value !== '' && value != null && (
        <button onClick={onDelete} className="text-accent-400 text-xs mb-1.5">
          quitar
        </button>
      )}
    </div>
  );
}

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

  const overridesDirty = libraries.some((l) => {
    const savedOverride = group.overrides.find((o) => o.library_id === l.id);
    return (
      String(limits[l.id] ?? '') !== String(savedOverride?.limit_override ?? '') ||
      String(expiries[l.id] ?? '') !== String(savedOverride?.expiry_override ?? '') ||
      String(monthlyLimits[l.id] ?? '') !== String(savedOverride?.monthly_limit_override ?? '')
    );
  });
  useDirty(`group-${group.id}`, overridesDirty);

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
        await api.deleteGroupOverride(group.id, libraryId, group.name);
      }
    } else {
      const expiry = expiries[libraryId];
      const monthly = monthlyLimits[libraryId];
      await api.setGroupOverride(group.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiry === '' ? null : Number(expiry),
        monthlyLimitOverride: monthly === '' ? null : Number(monthly),
        groupName: group.name,
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
            <div key={l.id} className="flex items-end gap-2 text-sm">
              <span className="text-gray-400 w-28 truncate flex-shrink-0 pb-1.5">{l.name}</span>
              <OverrideField
                label="Límite"
                type="number"
                min={0}
                value={limits[l.id] ?? ''}
                onChange={(e) => setLimits({ ...limits, [l.id]: e.target.value })}
              />
              <OverrideField
                label="Caducidad"
                type="number"
                min={0}
                value={expiries[l.id] ?? ''}
                onChange={(e) => setExpiries({ ...expiries, [l.id]: e.target.value })}
                title="Días (0 = no caduca; vacío = la de la biblioteca)"
              />
              <OverrideField
                label="Mensual"
                type="number"
                min={0}
                value={monthlyLimits[l.id] ?? ''}
                onChange={(e) => setMonthlyLimits({ ...monthlyLimits, [l.id]: e.target.value })}
                title="Cupo mensual (0 = bloquear el mes; vacío = el de la biblioteca)"
              />
              {dirty && (
                <button onClick={() => saveLimit(l.id)} className="btn btn-primary py-1 px-2.5 text-xs mb-0.5">
                  Guardar
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 pt-3 border-t border-bg-700/50">
        <div className="label mb-1.5">Cupo mensual total (vacío = el global de Ajustes)</div>
        <MonthlyTotalOverrideControl
          value={group.monthlyTotalOverride?.limit_override ?? ''}
          onSave={async (n) => {
            await api.setMonthlyTotalGroupOverride(group.id, n, group.name);
            onChanged();
          }}
          onDelete={async () => {
            await api.deleteMonthlyTotalGroupOverride(group.id, group.name);
            onChanged();
          }}
        />
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

  const overridesDirty = libraries.some((l) => {
    const savedOverride = role.overrides.find((o) => o.library_id === l.id);
    return (
      String(limits[l.id] ?? '') !== String(savedOverride?.limit_override ?? '') ||
      String(expiries[l.id] ?? '') !== String(savedOverride?.expiry_override ?? '') ||
      String(monthlyLimits[l.id] ?? '') !== String(savedOverride?.monthly_limit_override ?? '')
    );
  });
  useDirty(`role-${role.id}`, overridesDirty);

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
        await api.deleteRoleOverride(role.id, libraryId, role.name);
      }
    } else {
      const expiry = expiries[libraryId];
      const monthly = monthlyLimits[libraryId];
      await api.setRoleOverride(role.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiry === '' ? null : Number(expiry),
        monthlyLimitOverride: monthly === '' ? null : Number(monthly),
        roleName: role.name,
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
            <div key={l.id} className="flex items-end gap-2 text-sm">
              <span className="text-gray-400 w-28 truncate flex-shrink-0 pb-1.5">{l.name}</span>
              <OverrideField
                label="Límite"
                type="number"
                min={0}
                value={limits[l.id] ?? ''}
                onChange={(e) => setLimits({ ...limits, [l.id]: e.target.value })}
              />
              <OverrideField
                label="Caducidad"
                type="number"
                min={0}
                value={expiries[l.id] ?? ''}
                onChange={(e) => setExpiries({ ...expiries, [l.id]: e.target.value })}
                title="Días (0 = no caduca; vacío = la de la biblioteca)"
              />
              <OverrideField
                label="Mensual"
                type="number"
                min={0}
                value={monthlyLimits[l.id] ?? ''}
                onChange={(e) => setMonthlyLimits({ ...monthlyLimits, [l.id]: e.target.value })}
                title="Cupo mensual (0 = bloquear el mes; vacío = el de la biblioteca)"
              />
              {dirty && (
                <button onClick={() => saveLimit(l.id)} className="btn btn-primary py-1 px-2.5 text-xs mb-0.5">
                  Guardar
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 pt-3 border-t border-bg-700/50">
        <div className="label mb-1.5">Cupo mensual total (vacío = el global de Ajustes)</div>
        <MonthlyTotalOverrideControl
          value={role.monthlyTotalOverride?.limit_override ?? ''}
          onSave={async (n) => {
            await api.setMonthlyTotalRoleOverride(role.id, n, role.name);
            onChanged();
          }}
          onDelete={async () => {
            await api.deleteMonthlyTotalRoleOverride(role.id, role.name);
            onChanged();
          }}
        />
      </div>
    </div>
  );
}

const FICHA_TABS = [
  { key: 'general', label: 'General' },
  { key: 'cupo', label: 'Cupo' },
  { key: 'pendientes', label: 'Pendientes' },
  { key: 'salvadas', label: 'Salvadas' },
  { key: 'overrides', label: 'Overrides' },
];

// Ficha de un usuario, en modal (se abre desde la fila de la tabla de
// Usuarios): TODO lo relacionado con él en un sitio — grupo/rol asignados,
// vínculo de Telegram, su cupo por biblioteca, sus pendientes de aprobación
// (con Aprobar/Rechazar/Aplazar en el sitio, igual que en Cupo) y lo que
// tenga salvado del borrado (Maintainerr). Grupo/rol/overrides se editan
// aquí mismo; cupo/pendientes/salvadas son de la misma fuente que la pestaña
// Cupo (esta ficha NO la sustituye, solo la enseña centrada en un usuario).
function UserFichaModal({ user, group, role, allGroups, allRoles, overrides, monthlyTotalOverride, libraries, onChanged, onClose }) {
  const [tab, setTab] = useState('general');
  const [quotaAll, setQuotaAll] = useState([]);
  const [pendingAll, setPendingAll] = useState([]);
  const [links, setLinks] = useState([]);
  const [salvadosAll, setSalvadosAll] = useState([]);
  const [acting, setActing] = useState({});

  const [limits, setLimits] = useState({});
  const [expiries, setExpiries] = useState({});
  const [monthlyLimits, setMonthlyLimits] = useState({});
  const [notes, setNotes] = useState({});

  function loadExtra() {
    api.quota().then(setQuotaAll).catch(() => {});
    api.pendingApprovals().then(setPendingAll).catch(() => setPendingAll([]));
    api.notificationLinks().then(setLinks).catch(() => setLinks([]));
    api.salvados().then(setSalvadosAll).catch(() => setSalvadosAll([]));
  }

  useEffect(loadExtra, [user.id]);

  useEffect(() => {
    setLimits(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.limit_override ?? ''])));
    setExpiries(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.expiry_override ?? ''])));
    setMonthlyLimits(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.monthly_limit_override ?? ''])));
    setNotes(Object.fromEntries(libraries.map((l) => [l.id, overrides.find((o) => o.library_id === l.id)?.note ?? ''])));
  }, [overrides, libraries]);

  const overridesDirty = libraries.some((l) => {
    const saved = overrides.find((o) => o.library_id === l.id);
    return (
      String(limits[l.id] ?? '') !== String(saved?.limit_override ?? '') ||
      String(expiries[l.id] ?? '') !== String(saved?.expiry_override ?? '') ||
      String(monthlyLimits[l.id] ?? '') !== String(saved?.monthly_limit_override ?? '') ||
      String(notes[l.id] ?? '') !== String(saved?.note ?? '')
    );
  });
  useDirty(`user-ficha-${user.id}`, overridesDirty);

  function requestClose() {
    if (overridesDirty && !window.confirm('Hay overrides sin guardar. ¿Cerrar igualmente?')) return;
    onClose();
  }

  async function saveLimit(libraryId) {
    const value = limits[libraryId];
    if (value === '') {
      if (overrides.some((o) => o.library_id === libraryId)) {
        await api.deleteOverride(user.id, libraryId, user.username);
      }
    } else {
      await api.setOverride(user.id, libraryId, {
        limitOverride: Number(value),
        expiryOverride: expiries[libraryId] === '' ? null : Number(expiries[libraryId]),
        monthlyLimitOverride: monthlyLimits[libraryId] === '' ? null : Number(monthlyLimits[libraryId]),
        note: notes[libraryId] || '',
        username: user.username,
      });
    }
    onChanged();
  }

  async function clearLimit(libraryId) {
    await api.deleteOverride(user.id, libraryId, user.username);
    onChanged();
  }

  // Un miembro de un grupo con cupo agregado no tiene fila propia (issue #4):
  // la caché vive bajo el grupo (isGroup=true), identificado solo por
  // username entre sus miembros — se enseña el cupo compartido con nota.
  const quotaEntry =
    quotaAll.find((q) => q.userId === user.id) ??
    quotaAll.find((q) => q.isGroup && q.members?.includes(user.username));
  const myPending = pendingAll.filter((p) => p.userId === user.id);
  const myLink = links.find((l) => l.user_id === user.id) ?? null;
  const mySalvados = salvadosAll.filter((s) => s.user_id === user.id);

  async function act(item, action) {
    const label = action === 'approve' ? 'Aprobar' : 'Rechazar';
    if (!confirm(`¿${label} "${item.title ?? 'esta solicitud'}" en Seerr?`)) return;
    setActing((a) => ({ ...a, [item.requestId]: action }));
    try {
      if (action === 'approve') await api.approveRequest(item.requestId);
      else await api.declineRequest(item.requestId);
    } finally {
      setActing((a) => ({ ...a, [item.requestId]: null }));
      loadExtra();
    }
  }

  async function hold(item) {
    const days = prompt(`¿Aplazar "${item.title ?? 'esta solicitud'}" cuántos días?`, '7');
    if (!days) return;
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) return;
    await api.holdRequest(item.requestId, n);
    loadExtra();
  }

  async function clearHold(item) {
    await api.clearRequestHold(item.requestId);
    loadExtra();
  }

  // Mover de grupo/rol reutiliza el mismo endpoint que las pestañas Grupos/Roles
  // (reemplaza la lista de miembros); no hace falta tocar el grupo/rol viejo,
  // el backend mueve al usuario solo (user_id es la PK de group_members/user_roles).
  async function changeGroup(newGroupIdStr) {
    const newGroupId = newGroupIdStr === '' ? null : Number(newGroupIdStr);
    if (group && group.id !== newGroupId) {
      await api.setGroupMembers(group.id, group.members.filter((id) => id !== user.id));
    }
    if (newGroupId != null) {
      const target = allGroups.find((g) => g.id === newGroupId);
      await api.setGroupMembers(newGroupId, [...target.members, user.id]);
    }
    onChanged();
  }

  async function changeRole(newRoleIdStr) {
    const newRoleId = newRoleIdStr === '' ? null : Number(newRoleIdStr);
    if (role && role.id !== newRoleId) {
      await api.setRoleMembers(role.id, role.members.filter((id) => id !== user.id));
    }
    if (newRoleId != null) {
      const target = allRoles.find((r) => r.id === newRoleId);
      await api.setRoleMembers(newRoleId, [...target.members, user.id]);
    }
    onChanged();
  }

  const [cupoBusy, setCupoBusy] = useState({});

  // Mismas acciones que la tarjeta de la pestaña Cupo, pero desde la ficha:
  // quotaEntry.userId es el id de caché correcto (el del grupo si es un
  // miembro de un grupo agregado), no necesariamente user.id.
  async function resetCupo(libraryId) {
    if (!confirm('¿Resetear el cupo? Todo lo pendiente hasta ahora deja de contar (queda en el Registro, se puede deshacer).')) return;
    const cacheId = quotaEntry.userId;
    setCupoBusy((b) => ({ ...b, [libraryId]: 'reset' }));
    try {
      await api.resetQuota(cacheId, libraryId, user.username);
    } finally {
      setCupoBusy((b) => ({ ...b, [libraryId]: null }));
      loadExtra();
      onChanged();
    }
  }

  async function manualChargeCupo(libraryId) {
    const title = prompt('Título de lo que se bajó/vio fuera de Seerr (restará un hueco de cupo):');
    if (!title?.trim()) return;
    const note = prompt('Nota: ¿por qué se usa este cargo manual? (opcional)');
    const cacheId = quotaEntry.userId;
    setCupoBusy((b) => ({ ...b, [libraryId]: 'charge' }));
    try {
      await api.manualCharge(cacheId, libraryId, title.trim(), user.username, note?.trim() || null);
    } finally {
      setCupoBusy((b) => ({ ...b, [libraryId]: null }));
      loadExtra();
      onChanged();
    }
  }

  async function dismissPending(libraryId, item) {
    if (!confirm(`¿Quitar "${item.title ?? 'este pendiente'}" del cupo? Queda en el Registro, se puede deshacer.`)) return;
    const cacheId = quotaEntry.userId;
    await api.dismissPending(cacheId, libraryId, {
      tmdbId: item.tmdbId,
      seasonNumber: item.seasonNumber ?? null,
      title: item.title,
      username: user.username,
    });
    loadExtra();
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-4" onClick={requestClose}>
      <div
        className="card w-full max-w-4xl max-h-[90vh] overflow-y-auto p-4 sm:p-6"
        style={{ maxHeight: '90dvh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <span className="w-14 h-14 rounded-full bg-bg-700 flex items-center justify-center text-lg font-bold flex-shrink-0">
              {user.username.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                <h3 className="font-bold text-lg text-accent-300 leading-tight truncate">{user.username}</h3>
                {user.email && <span className="text-gray-500 text-sm truncate">({user.email})</span>}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">Id de usuario: {user.id}</div>
            </div>
          </div>
          <button onClick={requestClose} className="text-gray-500 hover:text-gray-200 text-xl leading-none flex-shrink-0">✕</button>
        </div>

        <div className="flex gap-1 mb-4 border-b border-bg-700 overflow-x-auto">
          {FICHA_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                tab === t.key
                  ? 'border-accent-500 text-accent-300'
                  : 'border-transparent text-gray-500 hover:text-gray-300'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'general' && (
          <div>
            <FichaRow label="Grupo">
              <select value={group?.id ?? ''} onChange={(e) => changeGroup(e.target.value)} className="input w-auto py-1">
                <option value="">— sin grupo —</option>
                {allGroups.map((g) => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
            </FichaRow>
            <FichaRow label="Rol">
              <select value={role?.id ?? ''} onChange={(e) => changeRole(e.target.value)} className="input w-auto py-1">
                <option value="">— sin rol —</option>
                {allRoles.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </FichaRow>
            <FichaRow label="Telegram">
              {myLink ? (
                <span className="text-green-400">vinculado{myLink.label ? ` — ${myLink.label}` : ''}</span>
              ) : (
                <span className="text-gray-500">sin vincular</span>
              )}
            </FichaRow>
          </div>
        )}

        {tab === 'cupo' && (
          <div className="space-y-4">
            {!quotaEntry && <p className="text-sm text-gray-500">Sin cupo calculado todavía.</p>}
            {quotaEntry?.isGroup && (
              <p className="text-xs text-gray-500">
                Cupo compartido con el grupo "{quotaEntry.username}" (cupo agregado): lo pedido por
                cualquier miembro cuenta aquí.
              </p>
            )}
            {quotaEntry?.monthlyTotal?.enabled && (
              <div className="text-xs text-gray-400">
                📅 Cupo mensual total (todas las bibliotecas): {quotaEntry.monthlyTotal.used}/{quotaEntry.monthlyTotal.limit}
              </div>
            )}
            {quotaEntry?.libraries.map((lib) => {
              const pct = lib.limitApplied > 0 ? Math.round((lib.balance / lib.limitApplied) * 100) : 0;
              const busy = cupoBusy[lib.libraryId];
              return (
                <div key={lib.libraryId}>
                  <div className="flex items-center gap-3 text-sm mb-1">
                    <span className="flex-1 font-medium truncate">{lib.libraryName}</span>
                    <span className="tabular-nums">{lib.balance} / {lib.limitApplied}</span>
                    <button
                      onClick={() => manualChargeCupo(lib.libraryId)}
                      disabled={Boolean(busy)}
                      title="Restar un hueco de cupo a mano (contenido bajado/visto fuera de Seerr)"
                      className="text-gray-400 hover:text-gray-200 text-xs disabled:opacity-50"
                    >
                      {busy === 'charge' ? 'cargando…' : 'cargo manual'}
                    </button>
                    <button
                      onClick={() => resetCupo(lib.libraryId)}
                      disabled={Boolean(busy)}
                      className="text-accent-400 hover:text-accent-300 text-xs disabled:opacity-50"
                    >
                      {busy === 'reset' ? 'reseteando…' : 'resetear'}
                    </button>
                  </div>
                  <div className="h-2 rounded-full bg-bg-600/70 overflow-hidden">
                    <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
                  </div>
                  {lib.monthly?.enabled && (
                    <div className="text-[11px] text-gray-500 mt-1">mensual {lib.monthly.used}/{lib.monthly.limit}</div>
                  )}
                  {lib.pendingItems?.length > 0 && (
                    <div className="flex flex-wrap gap-2 mt-2">
                      {lib.pendingItems.map((item, i) => (
                        <div key={i} className="relative w-12 flex-shrink-0 group" title={item.title ?? ''}>
                          <div className="aspect-[2/3] rounded overflow-hidden bg-bg-700">
                            {item.posterUrl && <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                          </div>
                          <button
                            onClick={() => dismissPending(lib.libraryId, item)}
                            className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-black/70 text-gray-200 hover:bg-accent-500 hover:text-white text-[9px] leading-none hidden group-hover:flex items-center justify-center"
                            title="Quitar del cupo"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {tab === 'pendientes' && (
          <div className="space-y-2">
            {myPending.length === 0 && <p className="text-sm text-gray-500">Sin pendientes de aprobación.</p>}
            {myPending.map((item) => (
              <div key={item.requestId} className="flex flex-wrap items-center gap-2 sm:gap-3 text-sm">
                <span className="w-8 h-12 rounded overflow-hidden bg-bg-600 flex-shrink-0">
                  {item.posterUrl && <img src={item.posterUrl} alt="" loading="lazy" className="w-full h-full object-cover" />}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{item.title ?? `solicitud #${item.requestId}`}</div>
                  <div className="text-xs text-gray-500 truncate">
                    {item.libraryName ?? 'Sin biblioteca'}
                    {item.balance != null && ` · saldo ${item.balance}/${item.limit}`}
                    {item.holdUntil != null && <span className="text-yellow-400"> · aplazada</span>}
                  </div>
                </div>
                {item.holdUntil != null ? (
                  <button onClick={() => clearHold(item)} className="btn btn-ghost py-1 px-2 text-xs">Quitar aplazamiento</button>
                ) : (
                  <button onClick={() => hold(item)} className="btn btn-ghost py-1 px-2 text-xs">Aplazar</button>
                )}
                <button
                  onClick={() => act(item, 'approve')}
                  disabled={Boolean(acting[item.requestId])}
                  className="btn btn-primary py-1 px-2 text-xs"
                >
                  {acting[item.requestId] === 'approve' ? 'Aprobando…' : 'Aprobar'}
                </button>
                <button
                  onClick={() => act(item, 'decline')}
                  disabled={Boolean(acting[item.requestId])}
                  className="btn btn-ghost py-1 px-2 text-xs text-accent-400"
                >
                  {acting[item.requestId] === 'decline' ? 'Rechazando…' : 'Rechazar'}
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === 'salvadas' && (
          mySalvados.length > 0
            ? <SalvadosGrid items={mySalvados} compact />
            : <p className="text-sm text-gray-500">Sin nada salvado del borrado.</p>
        )}

        {tab === 'overrides' && (
          <div>
            <p className="text-xs text-gray-500 mb-3">
              Overrides propios de este usuario (vacío = herencia normal: grupo &gt; rol &gt; biblioteca).
            </p>
            <div className="mb-4 pb-3 border-b border-bg-700/50">
              <MonthlyTotalOverrideControl
                value={monthlyTotalOverride?.limit_override ?? ''}
                onSave={async (n) => {
                  await api.setMonthlyTotalUserOverride(user.id, n, user.username);
                  onChanged();
                }}
                onDelete={async () => {
                  await api.deleteMonthlyTotalUserOverride(user.id, user.username);
                  onChanged();
                }}
              />
            </div>
            <div className="flex flex-col gap-2">
              {libraries.map((l) => {
                const saved = overrides.find((o) => o.library_id === l.id);
                const dirty =
                  String(limits[l.id] ?? '') !== String(saved?.limit_override ?? '') ||
                  String(expiries[l.id] ?? '') !== String(saved?.expiry_override ?? '') ||
                  String(monthlyLimits[l.id] ?? '') !== String(saved?.monthly_limit_override ?? '') ||
                  String(notes[l.id] ?? '') !== String(saved?.note ?? '');
                return (
                  <div key={l.id} className="flex flex-wrap items-end gap-2 text-sm">
                    <span className="text-gray-400 w-28 truncate flex-shrink-0 pb-1.5">{l.name}</span>
                    <OverrideField
                      label="Límite"
                      type="number"
                      min={0}
                      value={limits[l.id] ?? ''}
                      onChange={(e) => setLimits({ ...limits, [l.id]: e.target.value })}
                    />
                    <OverrideField
                      label="Caducidad"
                      type="number"
                      min={0}
                      value={expiries[l.id] ?? ''}
                      onChange={(e) => setExpiries({ ...expiries, [l.id]: e.target.value })}
                      title="Días (0 = no caduca; vacío = herencia)"
                    />
                    <OverrideField
                      label="Mensual"
                      type="number"
                      min={0}
                      value={monthlyLimits[l.id] ?? ''}
                      onChange={(e) => setMonthlyLimits({ ...monthlyLimits, [l.id]: e.target.value })}
                      title="Cupo mensual (0 = bloquear el mes; vacío = herencia)"
                    />
                    <OverrideField
                      label="Nota"
                      value={notes[l.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
                      className="input w-40 py-1"
                    />
                    {dirty && (
                      <button onClick={() => saveLimit(l.id)} className="btn btn-primary py-1 px-2.5 text-xs mb-0.5">
                        Guardar
                      </button>
                    )}
                    {!dirty && saved && (
                      <button onClick={() => clearLimit(l.id)} className="text-accent-400 text-xs mb-1.5">
                        quitar
                      </button>
                    )}
                  </div>
                );
              })}
              {libraries.length === 0 && <p className="text-sm text-gray-500">Sin bibliotecas activas.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Peor saldo (balance más bajo) entre las bibliotecas de un usuario, para el
// chip de cupo de la fila — mismo criterio de color que la pestaña Cupo.
function worstQuotaLib(entry) {
  if (!entry?.libraries?.length) return null;
  return entry.libraries.reduce((worst, l) => (l.balance < worst.balance ? l : worst), entry.libraries[0]);
}

function quotaTone(balance) {
  if (balance <= 0) return 'text-accent-400';
  if (balance <= 1) return 'text-yellow-400';
  return 'text-green-400';
}

// Fila limpia por usuario, estilo tarjeta (como en Cupo): foto real de Seerr
// si hay match (si no, iniciales), grupo/rol asignados, cupo y pendientes de
// un vistazo. Toda la fila abre la ficha — nada de botones sueltos.
function UsersTable({ users, groups, roles, quotaByUserId, pendingCountByUserId, query, setQuery, onSelect }) {
  const visibleUsers = users.filter((u) => u.username.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <div>
      <div className="relative mb-3 max-w-xs">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar usuario…"
          className="input"
        />
      </div>
      <div className="space-y-2">
        {visibleUsers.map((u) => {
          const group = groups.find((g) => g.members.includes(u.id));
          const role = roles.find((r) => r.members.includes(u.id));
          const quotaEntry = quotaByUserId.get(u.id);
          const worst = worstQuotaLib(quotaEntry);
          const pending = pendingCountByUserId.get(u.id) ?? 0;
          return (
            <button
              key={u.id}
              onClick={() => onSelect(u)}
              className="card w-full flex items-center gap-3 p-3 text-left hover:bg-bg-700/40 transition-colors"
            >
              <span className="w-9 h-9 rounded-full bg-bg-700 overflow-hidden flex items-center justify-center text-xs font-bold flex-shrink-0">
                {quotaEntry?.avatar ? (
                  <img src={quotaEntry.avatar} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                ) : (
                  u.username.slice(0, 2).toUpperCase()
                )}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate flex items-center gap-1.5 flex-wrap">
                  {u.username}
                  {group && <FichaBadge tone="accent">{group.name}</FichaBadge>}
                  {role && <FichaBadge tone="sky">{role.name}</FichaBadge>}
                </div>
                {u.email && <div className="text-xs text-gray-500 truncate">{u.email}</div>}
              </div>
              {worst && (
                <span className={`text-sm font-bold tabular-nums flex-shrink-0 ${quotaTone(worst.balance)}`}>
                  {worst.balance}/{worst.limitApplied}
                </span>
              )}
              {pending > 0 && (
                <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-yellow-400/10 text-yellow-400 ring-1 ring-yellow-400/25 flex-shrink-0">
                  {pending} pdte.
                </span>
              )}
            </button>
          );
        })}
      </div>
      {users.length > 0 && visibleUsers.length === 0 && (
        <p className="text-gray-500 text-sm py-6 text-center">Ningún usuario coincide con "{query}".</p>
      )}
    </div>
  );
}

const SUBTABS = [
  { key: 'usuarios', label: 'Usuarios' },
  { key: 'grupos', label: 'Grupos' },
  { key: 'roles', label: 'Roles' },
  { key: 'overrides', label: 'Overrides' },
];

export default function Users() {
  const [subtab, setSubtab] = useState('usuarios');
  const [overrides, setOverrides] = useState([]);
  const [monthlyTotalUserOverrides, setMonthlyTotalUserOverrides] = useState([]);
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
  const [selectedUser, setSelectedUser] = useState(null);
  const [quota, setQuota] = useState([]);
  const [pendingApprovals, setPendingApprovals] = useState([]);

  function load() {
    api.overrides().then(setOverrides);
    api.monthlyTotalQuotaOverrides().then((r) => setMonthlyTotalUserOverrides(r.users ?? []));
    api.groups().then(setGroups);
    api.roles().then(setRoles);
    // Foto de Seerr, cupo y pendientes de un vistazo en la tabla de usuarios.
    api.quota().then(setQuota).catch(() => {});
    api.pendingApprovals().then(setPendingApprovals).catch(() => {});
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

  const quotaByUserId = useMemo(() => new Map(quota.filter((q) => !q.isGroup).map((q) => [q.userId, q])), [quota]);
  const pendingCountByUserId = useMemo(() => {
    const map = new Map();
    for (const p of pendingApprovals) {
      if (p.userId == null) continue;
      map.set(p.userId, (map.get(p.userId) ?? 0) + 1);
    }
    return map;
  }, [pendingApprovals]);

  return (
    <div>
      <h2 className="page-title mb-1">Usuarios</h2>
      <p className="text-xs text-gray-500 mb-4">
        Precedencia del límite: override individual &gt; override de grupo &gt; rol &gt; límite de la
        biblioteca. Pon 0 para bloquear del todo.
      </p>

      <div className="flex gap-1 mb-5 border-b border-bg-700">
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSubtab(t.key)}
            className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              subtab === t.key
                ? 'border-accent-500 text-accent-300'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subtab === 'usuarios' && (
        <UsersTable
          users={users}
          groups={groups}
          roles={roles}
          quotaByUserId={quotaByUserId}
          pendingCountByUserId={pendingCountByUserId}
          query={query}
          setQuery={setQuery}
          onSelect={setSelectedUser}
        />
      )}

      {subtab === 'grupos' && (
        <div>
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
            <div className="space-y-3 mb-3">
              {groups.map((g) => (
                <GroupCard key={g.id} group={g} users={users} libraries={libraries} onChanged={load} />
              ))}
            </div>
          )}
          <p className="text-[11px] text-gray-600">
            Cada usuario puede estar como mucho en un grupo: marcarlo en otro lo mueve.
          </p>
        </div>
      )}

      {subtab === 'roles' && (
        <div>
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
            <div className="space-y-3 mb-3">
              {roles.map((r) => (
                <RoleCard key={r.id} role={r} users={users} libraries={libraries} onChanged={load} />
              ))}
            </div>
          )}
          <p className="text-[11px] text-gray-600">
            Cada usuario puede tener como mucho un rol: marcarlo en otro lo mueve. Un usuario puede tener
            rol y grupo a la vez (son independientes) — el grupo gana si ambos tocan la misma biblioteca.
          </p>
        </div>
      )}

      {subtab === 'overrides' && (
        <div>
          <p className="text-xs text-gray-500 mb-3">
            Acción rápida: fija el mismo límite a todos los usuarios de golpe. Para overrides puntuales
            de un usuario concreto, entra en su ficha desde la pestaña Usuarios.
          </p>
          <form onSubmit={applyBulk} className="card p-4 flex flex-wrap gap-3 items-end">
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
            <button type="submit" disabled={applyingBulk} className="btn btn-primary">
              {applyingBulk ? 'Aplicando…' : 'Aplicar a todos'}
            </button>
            {bulkResult && <span className="text-xs text-gray-500">{bulkResult}</span>}
          </form>
        </div>
      )}

      {selectedUser && (
        <UserFichaModal
          user={selectedUser}
          group={groups.find((g) => g.members.includes(selectedUser.id))}
          role={roles.find((r) => r.members.includes(selectedUser.id))}
          allGroups={groups}
          allRoles={roles}
          overrides={overrides.filter((o) => o.user_id === selectedUser.id)}
          monthlyTotalOverride={monthlyTotalUserOverrides.find((o) => o.user_id === selectedUser.id) ?? null}
          libraries={libraries}
          onChanged={load}
          onClose={() => setSelectedUser(null)}
        />
      )}
    </div>
  );
}
