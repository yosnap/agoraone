import { MarkdownField } from './markdown-field';
import { useState } from 'react';
import type { HermesFile } from '../../shared/hermes-catalog';
import { saveProfileFile } from '../api/client';

const delimiter = '\n§\n'; // Hermes keeps MEMORY.md and USER.md as entries separated by this line
type Entry = { key: number; text: string };
let nextKey = 0;
const entry = (text: string): Entry => ({ key: nextKey++, text });
// Same rule as Hermes: trimmed, non-empty, first occurrence wins.
const cleaned = (entries: Entry[]) => [...new Set(entries.map(item => item.text.trim()).filter(Boolean))];

// Edits one real identity file of a Hermes profile. Personality is free text; memories are cards,
// one per Hermes entry, under Hermes' own size limit. Saving asks for confirmation first.
// The draft keeps the version it started from, so a change made by Hermes meanwhile is reported, not overwritten.
export function ProfileFileEditor({ profileId, file, title, limit, revealed, onSaved, onCancel, onReload }: {
  profileId: string; file: HermesFile; title: string; limit: number | null; revealed: boolean;
  onSaved: (message: string) => void; onCancel: () => void; onReload: () => void;
}) {
  const [base] = useState(() => ({ revision: file.state === 'available' ? file.revision ?? null : null, revealed, hiddenChars: file.hiddenChars ?? 0, text: file.state === 'available' ? file.content ?? '' : '' }));
  const [text, setText] = useState(base.text);
  const [entries, setEntries] = useState<Entry[]>(() => { const list = base.text.split(delimiter).map(item => item.trim()).filter(Boolean).map(entry); return list.length ? list : [entry('')]; });
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const memory = limit !== null;
  const markers = (memory ? entries.map(item => item.text).join('\n') : text).includes('[línea oculta ');
  // Hidden lines count with their real length while their markers are kept.
  const used = memory ? [...cleaned(entries).join(delimiter)].length + (markers ? base.hiddenChars : 0) : 0;
  const over = memory && used > limit;
  const changedInHermes = file.state === 'available' && file.revision !== base.revision;
  async function save() {
    setSaving(true); setError('');
    try {
      const result = await saveProfileFile(profileId, file.name, { ...(memory ? { entries: entries.map(item => item.text) } : { content: text }), revision: base.revision, revealed: base.revealed });
      onSaved(result.backup ? `${title} guardado en Hermes. Se ha guardado una copia de la versión anterior.` : `${title} creado en Hermes.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'No se pudo guardar.';
      setError(message); setConflict(/cambió en Hermes/.test(message)); setConfirming(false);
    } finally { setSaving(false); }
  }
  return <div className="profile-editor" role="group" aria-label={`Editar ${title}`}>
    {changedInHermes && !conflict && <p className="notice" role="status">Hermes ha cambiado este archivo mientras lo editabas. Si guardas, se te pedirá recargarlo; tu borrador no se aplicará sobre la versión nueva.</p>}
    {memory ? <>
      {entries.map((item, index) => <div className="memory-card" key={item.key}>
        <textarea aria-label={`${title}: entrada ${index + 1}`} value={item.text} disabled={saving} onChange={event => setEntries(list => list.map(other => other.key === item.key ? { ...other, text: event.target.value } : other))}/>
        <button type="button" disabled={saving} onClick={() => setEntries(list => list.length > 1 ? list.filter(other => other.key !== item.key) : [entry('')])} aria-label={`Quitar entrada ${index + 1}`}>Quitar</button>
      </div>)}
      <button type="button" className="add-entry" disabled={saving} onClick={() => setEntries(list => [...list, entry('')])}>+ Añadir entrada</button>
      <small className={over ? 'error' : ''}>{used} / {limit} caracteres, el límite de Hermes para este archivo{over ? '. Acorta o quita alguna entrada para poder guardar.' : '.'}</small>
    </> : <MarkdownField label={title} value={text} disabled={saving} onChange={setText} minHeight={260}/>}
    {markers && <small>Las líneas «[línea oculta N]» son datos que parecen claves: déjalas para conservarlas tal cual o bórralas para eliminarlas.</small>}
    {error && <p className="error" role="alert">{error}{conflict && <> <button onClick={onReload}>Descartar y recargar</button></>}</p>}
    {confirming ? <div className="notice editor-confirm" role="alertdialog" aria-label="Confirmar guardado">
      <p>Se guardará en el perfil real de Hermes. Telegram, Desktop y AgoraOne lo usarán en sus próximas conversaciones; las ya abiertas pueden seguir con la versión anterior. Antes se guarda una copia de la versión actual.</p>
      <div><button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Guardando…' : 'Confirmar y guardar'}</button><button disabled={saving} onClick={() => setConfirming(false)}>Volver</button></div>
    </div> : <div className="editor-actions">
      <button className="primary" disabled={saving || over || conflict} onClick={() => setConfirming(true)}>Guardar en Hermes</button>
      <button disabled={saving} onClick={onCancel}>Cancelar</button>
    </div>}
  </div>;
}
