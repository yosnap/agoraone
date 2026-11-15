import { useRef, useState } from 'react';
import { getVaultReview, type ReviewNote, type VaultReview } from '../api/core';
import { LoadError, Loading } from '../ui/load-state';

function Notes({ notes, onRead }: { notes: ReviewNote[]; onRead: (key: string) => void }) {
  return <ul className="review-notes">{notes.map(note => <li key={note.key}><button type="button" onClick={() => onRead(note.key)}>
    <strong>{note.title}</strong><small>{note.folder || '(raíz)'}</small></button></li>)}</ul>;
}

function Section({ title, count, why, children }: { title: string; count: number; why: string; children: React.ReactNode }) {
  return <details className="review-section" open={count > 0 && count < 40}>
    <summary><span className={`status-badge ${count ? 'paused' : 'good'}`}>{count}</span> {title}</summary>
    <p className="muted">{why}</p>
    {count > 0 && children}
  </details>;
}

const ASK = 'Revisa cómo está ordenado mi vault y propón un primer lote de cambios para ordenarlo: mover notas sueltas o mal archivadas a su carpeta y, solo si hace falta, un título más claro.';

/** The vault's review (1.7): what makes things hard to find, read from the brain's index; nothing changes. From here
 * Watson can be asked for a reorganisation, which it proposes as a batch the user approves change by change. */
export function VaultReviewPanel({ discreet, onRead, onClose, onAsk }: { discreet: boolean; onRead: (key: string) => void; onClose: () => void; onAsk?: (question: string) => void }) {
  const [found, setFound] = useState<VaultReview | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);
  if (!asked.current) { asked.current = true; void getVaultReview(discreet).then(setFound).catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudo revisar.')); }
  return <div className="first-run" role="dialog" aria-modal="true" aria-labelledby="review-title">
    <div className="first-run-panel review-panel">
      <div className="first-run-head"><span className="eyebrow">CEREBRO · REVISIÓN</span><button type="button" className="button" onClick={onClose}>Cerrar</button></div>
      <h1 id="review-title">Revisar el vault</h1>
      <p className="muted">Lo que hace difícil encontrar las cosas, sacado del índice del cerebro. No cambia nada: Watson puede proponer cómo reordenarlo y tú apruebas cada cambio.</p>
      {onAsk && <div className="inbox-actions"><button type="button" className="button primary" onClick={() => onAsk(ASK)}>Pedir a Watson que lo ordene</button></div>}
      {error && <LoadError message={error}/>}
      {!found && !error ? <Loading label="Revisando el vault" lines={4}/> : found && <div className="review-grid">
        <p className="review-total">{found.notes} notas en {found.folders} carpetas.</p>
        <Section title="Notas con contraseñas o claves" count={found.secretCount} why="Solo el título: lo que parece una clave ya está oculto y nunca va a un modelo. Esas cosas estarían mejor en el Llavero o en un gestor de contraseñas.">
          <Notes notes={found.secrets} onRead={onRead}/></Section>
        <Section title="Títulos repetidos" count={found.duplicateCount} why="Varias notas con el mismo título: difíciles de distinguir y de enlazar.">
          <ul className="review-notes">{found.duplicates.map(group => <li key={group.title}><strong>{group.title}</strong> <small>· {group.notes.map(n => n.folder || '(raíz)').join(' · ')}</small></li>)}</ul></Section>
        <Section title="Notas huérfanas" count={found.orphanCount} why="Ninguna otra nota las enlaza y ellas no enlazan a ninguna: quedan aisladas.">
          <Notes notes={found.orphans} onRead={onRead}/></Section>
        <Section title="Notas sueltas en la raíz" count={found.rootCount} why="Fuera de cualquier carpeta."><Notes notes={found.root} onRead={onRead}/></Section>
        <Section title="Notas casi vacías" count={found.tinyCount} why="Menos de una línea de texto."><Notes notes={found.tiny} onRead={onRead}/></Section>
        <Section title="Carpetas con una sola nota" count={found.lonelyCount} why="Quizá podrían unirse a su carpeta madre o a otra parecida.">
          <ul className="review-notes">{found.lonelyFolders.map(folder => <li key={folder}><small>{folder}</small></li>)}</ul></Section>
        <Section title="Carpetas demasiado llenas" count={found.crowdedFolders.length} why="Más de 150 notas en el mismo nivel: conviene dividirlas.">
          <ul className="review-notes">{found.crowdedFolders.map(f => <li key={f.folder}><small>{f.folder} · {f.notes}</small></li>)}</ul></Section>
        <Section title="Carpetas demasiado profundas" count={found.deepCount} why="Más de cuatro niveles: cuesta llegar.">
          <ul className="review-notes">{found.deepFolders.map(folder => <li key={folder}><small>{folder}</small></li>)}</ul></Section>
      </div>}
    </div>
  </div>;
}
