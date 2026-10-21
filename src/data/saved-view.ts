import type { LightMode } from '../world/daylight';

/** What the user was looking at, so a reload comes back to it. Per browser; nothing personal beyond ids. */
export type SavedView = {
  lightMode: LightMode; firstPerson: boolean; selected: string | null;
  profileTab: 'info' | 'chat' | 'skills'; libraryTab: 'chat' | 'documents';
  interior: { kind: 'library' | 'integrations' } | { kind: 'profile' | 'vault'; id: string } | null;
};

const key = 'agora-last-view';

// Storage can be unavailable (private window, blocked site data): the app then simply starts fresh.
export function readView(): Partial<SavedView> {
  try { const value = JSON.parse(localStorage.getItem(key) || '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}
export function writeView(view: SavedView) {
  try { localStorage.setItem(key, JSON.stringify(view)); } catch { /* not remembered this time */ }
}
