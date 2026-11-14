import { useSyncExternalStore } from 'react';

// Light, dark or whatever macOS says. The choice is per browser; colours come from src/theme-tokens.css.
export type ThemeChoice = 'system' | 'light' | 'dark';
export const themeLabels: Record<ThemeChoice, string> = { system: 'Tema del sistema', light: 'Tema claro', dark: 'Tema oscuro' };
const key = 'agora-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function readTheme(): ThemeChoice {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : 'system'; } catch { return 'system'; }
}

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme; else root.dataset.theme = choice;
  try { localStorage.setItem(key, choice); } catch { /* not remembered this time */ }
  window.dispatchEvent(new Event('agora-theme'));
}

const resolved = () => document.documentElement.dataset.theme === 'dark' || (document.documentElement.dataset.theme !== 'light' && media().matches) ? 'dark' : 'light';
const subscribe = (notify: () => void) => {
  const list = media();
  list.addEventListener('change', notify); window.addEventListener('agora-theme', notify);
  return () => { list.removeEventListener('change', notify); window.removeEventListener('agora-theme', notify); };
};
/** The theme on screen right now, for what CSS cannot colour (the 3D graph). */
export const useResolvedTheme = () => useSyncExternalStore(subscribe, resolved, () => 'light' as const);
