import { useCallback, useState } from 'react';
import { useVaultNotes } from '../data/use-vault-notes';
import { VaultBook } from '../ui/vault-book';
import { LoadError } from '../ui/load-state';

export type NoteRef = { vault: string; note: string };

/** A note of the brain opened as a book, outside the city: same reader, editor and safeguards as the vault's. */
export function NoteReader({ note, onClose }: { note: NoteRef; onClose: () => void }) {
  const [current, setCurrent] = useState(note.note);
  const vault = useVaultNotes(note.vault);
  const turn = useCallback((id: string) => setCurrent(id), []);
  if (vault.error) return <div className="note-reader-error" role="alertdialog" aria-label="No se pudo abrir la nota">
    <LoadError message={vault.error} onRetry={vault.reload}/><button onClick={onClose}>Cerrar</button>
  </div>;
  if (!vault.listing || vault.listing.vault.id !== note.vault) return null;
  return <VaultBook vaultId={note.vault} vaultName={vault.listing.vault.name} noteId={current} notes={vault.listing.notes}
    onOpen={turn} onClose={onClose} targets={[]} onConsult={() => undefined} onChanged={vault.reload}/>;
}
