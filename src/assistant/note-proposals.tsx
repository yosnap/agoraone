import { useRef, useState } from 'react';
import { createVaultNote, getHermesCatalog } from '../api/client';
import { dismissProposal } from '../api/core';
import { Markdown } from '../ui/markdown';
import { ModernSelect } from '../ui/modern-select';

export type ProposedNote = { title: string; folder: string; content: string };
type NoteProposal = { id: string; note: ProposedNote; state: 'open' | 'busy' | 'made' | 'dismissed' | 'failed'; result?: string };

/** The notes Watson proposed in this conversation (1.7), each shown whole: nothing is written until «Crear la
 * nota» (the button, so the vault, title and folder can be checked first). It is created through the vault's own route: confirmed,
 * never overwriting another note. */
export function useNoteProposals() {
  const [list, setList] = useState<NoteProposal[]>([]);
  const settle = (id: string, change: Partial<NoteProposal>) => setList(all => all.map(p => p.id === id ? { ...p, ...change } : p));
  const create = async (proposal: NoteProposal, vault: string, edited: ProposedNote) => {
    if (proposal.state !== 'open' || !vault) return;
    settle(proposal.id, { state: 'busy' });
    try {
      const made = await createVaultNote(vault, edited.folder, edited.title, edited.content);
      void dismissProposal(proposal.id).catch(() => undefined);  // used: Watson's proposal is let go
      settle(proposal.id, { state: 'made', result: `Nota creada: ${made.folder ? `${made.folder}/` : ''}${made.title}.` });
    } catch (failure) { settle(proposal.id, { state: 'open', result: failure instanceof Error ? failure.message : 'No se pudo crear la nota.' }); }
  };
  const dismiss = (proposal: NoteProposal) => { settle(proposal.id, { state: 'dismissed', result: 'Nota descartada: no se ha creado nada.' }); void dismissProposal(proposal.id).catch(() => undefined); };
  return {
    list, create, dismiss,
    add: (id: string, note: ProposedNote) => setList(all => all.some(p => p.id === id) ? all : [...all, { id, note, state: 'open' }]),
    clear: () => setList([]),
    open: () => list.filter(p => p.state === 'open'),
  };
}

function NoteCard({ proposal, state, vaults }: { proposal: NoteProposal; state: ReturnType<typeof useNoteProposals>; vaults: { id: string; name: string }[] }) {
  const [title, setTitle] = useState(proposal.note.title);
  const [folder, setFolder] = useState(proposal.note.folder);
  const [vault, setVault] = useState(vaults[0]?.id ?? '');
  const open = proposal.state === 'open' || proposal.state === 'busy';
  return <article className="card note-proposal" aria-label="Nota propuesta">
    <strong>Nota propuesta</strong>
    {open ? <>
      <div className="note-proposal-fields">
        <label className="field">Título<input value={title} onChange={event => setTitle(event.target.value)} maxLength={200}/></label>
        <label className="field">Carpeta<input value={folder} onChange={event => setFolder(event.target.value)} placeholder="(raíz)"/></label>
        {vaults.length > 1 && <label className="field">Vault<ModernSelect value={vault} onChange={setVault} options={vaults.map(v => ({ value: v.id, label: v.name }))}/></label>}
      </div>
      <details open><summary>Texto</summary><div className="note-proposal-text"><Markdown source={proposal.note.content} resolve={() => null}/></div></details>
      {!vaults.length && <p className="muted">No hay ningún vault de Obsidian disponible.</p>}
      <div className="inbox-actions">
        <button type="button" className="button primary" disabled={proposal.state === 'busy' || !vault || !title.trim()}
          onClick={() => void state.create(proposal, vault, { title: title.trim(), folder: folder.trim(), content: proposal.note.content })}>{proposal.state === 'busy' ? 'Creando…' : 'Crear la nota'}</button>
        <button type="button" className="button" onClick={() => state.dismiss(proposal)}>Descartar</button>
      </div>
    </> : null}
    {proposal.result && <small className={proposal.state === 'made' ? 'ok-note' : 'muted'} role="status">{proposal.result}</small>}
  </article>;
}

export function NoteProposals({ state }: { state: ReturnType<typeof useNoteProposals> }) {
  const [vaults, setVaults] = useState<{ id: string; name: string }[]>([]);
  const asked = useRef(false);
  if (!asked.current && state.list.length) {
    asked.current = true;
    void getHermesCatalog().then(catalog => setVaults((catalog.vaults ?? []).filter(v => v.available))).catch(() => undefined);
  }
  if (!state.list.length) return null;
  return <>{state.list.map(proposal => <NoteCard key={proposal.id} proposal={proposal} state={state} vaults={vaults}/>)}</>;
}
