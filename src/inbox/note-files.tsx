import { useRef, useState } from 'react';
import { createVaultFile } from '../api/client';
import { fetchMailFile, getMailSources, saveRepoFile, type MailFile, type MailSources } from '../api/core';
import { vaultName } from './project-note-text';

export type Chosen = { parts: number[]; urls: string[] };
type Where = { kind: 'vault'; vaultId: string; folder: string } | { kind: 'repo'; client: string; project: string; folder: string };
const size = (bytes: number) => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** «<note title> - <file name>», a name the vault and a repository accept, keeping the file's extension. */
export function fileName(title: string, name: string): string {
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return `${vaultName(`${title} - ${dot > 0 ? name.slice(0, dot) : name}`, 200) || 'Adjunto'}${extension ? `.${extension}` : ''}`;
}

/** The name each ticked attachment gets next to the note, unique (two «factura.pdf» become «… (2).pdf»): the
 * same name the note links to and the file is saved with. */
export function attachmentNames(sources: MailSources, chosen: Chosen, title: string): Map<number, string> {
  const names = new Map<number, string>(), taken = new Set<string>();
  for (const a of sources.attachments.filter(a => chosen.parts.includes(a.part))) {
    let name = fileName(title.trim() || 'Nota', a.name);
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      const dot = a.name.lastIndexOf('.');
      name = fileName(title.trim() || 'Nota', dot > 0 ? `${a.name.slice(0, dot)} (${n})${a.name.slice(dot)}` : `${a.name} (${n})`);
    }
    taken.add(name.toLowerCase());
    names.set(a.part, name);
  }
  return names;
}

/** What is added at the end of the note: the attachments saved next to it and every shared document of the mail. */
export function filesSection(sources: MailSources | null, chosen: Chosen, title: string, repo: boolean): string {
  if (!sources) return '';
  const lines: string[] = [];
  const names = [...attachmentNames(sources, chosen, title).values()];
  if (names.length) lines.push('## Adjuntos', ...names.map(name => repo ? `- [${name}](<./${name}>)` : `- [[${name}]]`), '');
  if (sources.links.length) lines.push('## Documentos enlazados', ...sources.links.map(l =>
    `- ${l.service}: ${l.url}${chosen.urls.includes(l.url) ? ' (con una copia junto a la nota)' : ''}`), '');
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/** Saves the ticked files next to the note, one by one, skipping those already saved; returns what failed. */
export async function saveFiles(itemId: number, sources: MailSources, chosen: Chosen, title: string, where: Where, done: Set<string>): Promise<string[]> {
  const failed: string[] = [];
  const names = attachmentNames(sources, chosen, title);
  const all: { key: string; label: string; name?: string; source: MailFile }[] = [
    ...sources.attachments.filter(a => names.has(a.part)).map(a => ({ key: `a${a.part}`, label: a.name, name: names.get(a.part), source: { kind: 'attachment' as const, part: a.part } })),
    ...sources.links.filter(l => chosen.urls.includes(l.url)).map(l => ({ key: l.url, label: `${l.service} (${l.url})`, source: { kind: 'link' as const, url: l.url } })),
  ];
  for (const file of all.filter(f => !done.has(f.key))) {
    try {
      if (where.kind === 'repo') await saveRepoFile({ ...file.source, client: where.client, project: where.project, folder: where.folder, name: file.name ?? '', prefix: title.trim(), inboxId: itemId });
      else {
        const { name, data } = await fetchMailFile(itemId, file.source);
        await createVaultFile(where.vaultId, where.folder, file.name ?? fileName(title.trim(), name), data);  // an attachment keeps the name the note links to
      }
      done.add(file.key);
    } catch (failure) { failed.push(`${file.label}: ${failure instanceof Error ? failure.message : 'no se pudo guardar'}`); }
  }
  return failed;
}

/** The mail's attachments and shared documents, each with a box to save it next to the note (none ticked at first). */
export function NoteFiles({ itemId, chosen, locked, onChange, onSources }: {
  itemId: number; chosen: Chosen; locked: boolean; onChange: (next: Chosen) => void; onSources: (sources: MailSources) => void;
}) {
  const [sources, setSources] = useState<MailSources | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);
  if (!asked.current) {
    asked.current = true;
    void getMailSources(itemId).then(found => { setSources(found); onSources(found); })
      .catch(failure => setError(failure instanceof Error ? failure.message : 'No se pudieron leer los adjuntos.'));
  }
  if (error) return <small className="muted">{error}</small>;
  if (!sources || (!sources.attachments.length && !sources.links.length)) return null;
  const toggle = <T,>(list: T[], value: T, on: boolean) => on ? [...list, value] : list.filter(v => v !== value);
  return <fieldset className="note-files" disabled={locked}>
    <legend>Archivos del correo</legend>
    {sources.attachments.map(a => !a.savable ? <small key={a.part} className="muted">{a.name} · {size(a.bytes)} — de un tipo que no se guarda junto a la nota.</small>
      : <label key={a.part} className="check"><input type="checkbox" checked={chosen.parts.includes(a.part)}
      onChange={event => onChange({ ...chosen, parts: toggle(chosen.parts, a.part, event.target.checked) })}/> {a.name} <small className="muted">· {size(a.bytes)}</small></label>)}
    {sources.links.map(l => l.downloadable
      ? <label key={l.url} className="check"><input type="checkbox" checked={chosen.urls.includes(l.url)}
          onChange={event => onChange({ ...chosen, urls: toggle(chosen.urls, l.url, event.target.checked) })}/> Descargar de {l.service} <small className="muted">· {l.url}</small></label>
      : <small key={l.url} className="muted">{l.service}: {l.url} — hay que descargarlo a mano (pide entrar en su web); queda enlazado en la nota.</small>)}
    <small className="muted">Lo que marques se guarda junto a la nota, sin sobrescribir nada. Los enlaces quedan siempre listados en la nota.</small>
  </fieldset>;
}
