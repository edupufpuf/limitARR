// Tema claro/oscuro. La preferencia ('system' | 'light' | 'dark') vive en
// localStorage solo como comodidad del navegador; sin ella se sigue al
// sistema. index.html aplica la clase antes de pintar para evitar el
// parpadeo; esto la mantiene al día.
import { useEffect, useState } from 'react';

const KEY = 'limitarr-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function getThemePref() {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

function apply(pref) {
  const dark = pref === 'dark' || (pref === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#ffffff');
}

export function setThemePref(pref) {
  try {
    if (pref === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Sin almacenamiento (modo privado): el cambio dura lo que la pestaña.
  }
  apply(pref);
  window.dispatchEvent(new CustomEvent('limitarr-theme', { detail: pref }));
}

media.addEventListener('change', () => apply(getThemePref()));
apply(getThemePref());

export function useThemePref() {
  const [pref, setPref] = useState(getThemePref);
  useEffect(() => {
    const onChange = (e) => setPref(e.detail);
    window.addEventListener('limitarr-theme', onChange);
    return () => window.removeEventListener('limitarr-theme', onChange);
  }, []);
  return [pref, setThemePref];
}
