import { createContext, useContext, useEffect, useRef } from 'react';

// Aviso de "cambios sin guardar" para toda la app: cada formulario se
// registra aquí con un id único y si tiene cambios sin guardar. Dashboard usa
// anyDirty() para preguntar antes de cambiar de pestaña, y este provider pone
// un beforeunload nativo del navegador para el cierre/recarga de la pestaña.
const DirtyContext = createContext(null);

export function DirtyGuardProvider({ children }) {
  const dirtyIds = useRef(new Set());

  function setDirty(id, isDirty) {
    if (isDirty) dirtyIds.current.add(id);
    else dirtyIds.current.delete(id);
  }

  function anyDirty() {
    return dirtyIds.current.size > 0;
  }

  useEffect(() => {
    function handler(e) {
      if (!anyDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    }
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return <DirtyContext.Provider value={{ setDirty, anyDirty }}>{children}</DirtyContext.Provider>;
}

// Registra el "sucio" de un formulario bajo un id único (p.ej. `group-${id}`
// si hay varias instancias del mismo componente en una lista).
export function useDirty(id, isDirty) {
  const ctx = useContext(DirtyContext);
  useEffect(() => {
    if (!ctx) return undefined;
    ctx.setDirty(id, isDirty);
    return () => ctx.setDirty(id, false);
  }, [ctx, id, isDirty]);
}

export function useAnyDirty() {
  const ctx = useContext(DirtyContext);
  return ctx?.anyDirty ?? (() => false);
}
