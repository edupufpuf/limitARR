import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function Overrides() {
  const [overrides, setOverrides] = useState([]);
  const [users, setUsers] = useState([]);
  const [libraries, setLibraries] = useState([]);
  const [form, setForm] = useState({ userId: '', libraryId: '', limitOverride: 4, note: '' });
  const [bulkForm, setBulkForm] = useState({ libraryId: '', limitOverride: 2 });
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [bulkResult, setBulkResult] = useState(null);

  function load() {
    api.overrides().then(setOverrides);
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
      <h2 className="text-xl font-semibold mb-4">Overrides manuales (usuario + biblioteca)</h2>
      <p className="text-xs text-gray-500 mb-4">
        Fija un límite de solicitudes sin ver distinto del de la biblioteca para ese usuario. Pon 0
        para bloquearlo del todo.
      </p>

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
