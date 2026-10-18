import type { VaultNote } from '../api/client';

const lower = (text: string) => text.toLocaleLowerCase('es');
const pathOf = (note: VaultNote) => lower(`${note.folder ? `${note.folder}/` : ''}${note.title}`);

/**
 * Index of a vault's notes for Obsidian link targets: a title, or a path relative to the vault,
 * case-insensitive. Built once per listing so each link costs a lookup, not a walk of every note.
 */
export function noteFinder(notes: VaultNote[]) {
  const byTitle = new Map<string, VaultNote[]>();
  for (const note of notes) {
    const key = lower(note.title), list = byTitle.get(key);
    if (list) list.push(note); else byTitle.set(key, [note]);
  }
  return (target: string, from = '') => {
    const wanted = lower(target.replace(/\.md$/i, '').replace(/^\/+/, ''));
    const title = wanted.split('/').at(-1) ?? '';
    const matches = (byTitle.get(title) ?? []).filter(note => !wanted.includes('/') || pathOf(note) === wanted || pathOf(note).endsWith(`/${wanted}`));
    // Like Obsidian, a title shared by several notes resolves to the one closest to the current folder.
    return matches.find(note => note.folder === from) ?? matches[0] ?? null;
  };
}

export const findNote = (notes: VaultNote[], target: string, from = '') => noteFinder(notes)(target, from);
