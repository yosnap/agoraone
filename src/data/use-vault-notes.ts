import { useCallback, useEffect, useMemo, useState } from 'react';
import { listVaultNotes, type VaultListing } from '../api/client';

export type VaultBook = { id: string; title: string; folder: string; readable: boolean };
export type VaultShelf = { folder: string; notes: number; books: VaultBook[] };

/** Note listing (titles and folders only) of the vault being viewed; reloads when the vault changes. */
export function useVaultNotes(vaultId: string | null) {
  const [listing, setListing] = useState<VaultListing | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  /** Reads the listing again (after a note was saved or created) without blanking the current one. */
  const reload = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    setListing(previous => previous?.vault.id === vaultId ? previous : null); setError('');
    if (!vaultId) return;
    let live = true;
    listVaultNotes(vaultId).then(data => { if (live) setListing(data); })
      .catch(() => { if (live) setError('No se pudo leer el vault. Puede estar en un volumen desconectado.'); });
    return () => { live = false; };
  }, [vaultId, version]);
  // Shelves for the 3D room: one per top-level folder, largest first. Each shelf holds up to 36 of
  // its notes as books, grouped by subfolder; the rest are reached from the panel.
  const shelves = useMemo<VaultShelf[]>(() => {
    const groups = new Map<string, VaultListing['notes']>();
    for (const note of listing?.notes ?? []) {
      const top = note.folder.split('/')[0], group = groups.get(top);
      if (group) group.push(note); else groups.set(top, [note]);
    }
    return [...groups].map(([folder, notes]) => {
      const sorted = [...notes].sort((a, b) => a.folder.localeCompare(b.folder, 'es') || a.title.localeCompare(b.title, 'es'));
      return { folder, notes: notes.length, books: sorted.slice(0, 36).map(note => ({ id: note.id, title: note.title, folder: note.folder, readable: note.readable })) };
    }).sort((a, b) => b.notes - a.notes || a.folder.localeCompare(b.folder, 'es'));
  }, [listing]);
  return { listing, error, shelves, reload };
}
