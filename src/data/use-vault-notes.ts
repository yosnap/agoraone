import { useEffect, useMemo, useState } from 'react';
import { listVaultNotes, type VaultListing } from '../api/client';

/** Note listing (titles and folders only) of the vault being viewed; reloads when the vault changes. */
export function useVaultNotes(vaultId: string | null) {
  const [listing, setListing] = useState<VaultListing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setListing(null); setError('');
    if (!vaultId) return;
    let live = true;
    listVaultNotes(vaultId).then(data => { if (live) setListing(data); })
      .catch(() => { if (live) setError('No se pudo leer el vault. Puede estar en un volumen desconectado.'); });
    return () => { live = false; };
  }, [vaultId]);
  // Shelves for the 3D room: one per top-level folder, largest first.
  const shelves = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of listing?.notes ?? []) { const top = note.folder.split('/')[0]; counts.set(top, (counts.get(top) ?? 0) + 1); }
    return [...counts].map(([folder, notes]) => ({ folder, notes })).sort((a, b) => b.notes - a.notes || a.folder.localeCompare(b.folder, 'es'));
  }, [listing]);
  return { listing, error, shelves };
}
