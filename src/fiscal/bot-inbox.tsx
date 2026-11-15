import { useState } from 'react';
import { createProfileSkill, getHermesCatalog } from '../api/client';
import type { FiscalFolder } from '../api/core';
import { LoadError } from '../ui/load-state';
import { ModernSelect } from '../ui/modern-select';

const CATEGORY = 'agoraone';
const NAME = 'guardar-facturas';

/** The skill text: the bot keeps what it is sent, untouched, in the folder's «Recibos por revisar». */
export function skillBody(folderPath: string, inbox: string): string {
  return [
    '# Guardar facturas y tickets para AgoraOne', '',
    'Cuando el usuario te envíe una foto o un PDF de una factura, un ticket o un recibo para guardarlo:', '',
    `1. Guarda el archivo tal cual, sin modificarlo, en la carpeta \`${folderPath}/${inbox}\` (créala si no existe).`,
    '2. Llámalo «AAAA-MM-DD proveedor importe» con su extensión original; omite lo que no sepas. Si ya existe un archivo con ese nombre, añade « (2)»: nunca sobrescribas.',
    '3. No lo guardes en ningún otro sitio ni lo envíes a nadie, y no muevas ni borres nada de esa carpeta: AgoraOne lo revisa y lo archiva en su trimestre.',
    '4. Responde en una frase que lo has guardado para AgoraOne.', '',
    'Solo fotos (JPG, PNG, HEIC) o PDF de hasta 15 MB.',
  ].join('\n');
}

/** Getting invoices through the user's own Hermes bot (Telegram…): AgoraOne writes, on «Crear la skill», a
 * skill in the chosen profile that tells the bot to save them in a fiscal folder's «Recibos por revisar»;
 * AgoraOne then shows them here as pending receipts. Hermes itself is not changed. */
export function BotInbox({ folders, inbox }: { folders: FiscalFolder[]; inbox: string }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<{ value: string; label: string }[] | null>(null);
  const [profileId, setProfileId] = useState('');
  const [folderId, setFolderId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const folder = folders.find(f => f.id === (folderId ?? folders[0]?.id));
  const start = () => {
    setOpen(true); setDone(''); setError('');
    if (profiles === null) getHermesCatalog().then(catalog => {
      const list = catalog.profiles.map(p => ({ value: p.id, label: p.name === 'default' ? `${p.label || 'Hermes principal'} (perfil raíz)` : p.label || p.name }));
      setProfiles(list); setProfileId(current => current || list[0]?.value || '');
    }).catch(() => setError('No se pudo leer la lista de perfiles de Hermes.'));
  };
  const create = async () => {
    if (!folder || !profileId) return;
    setBusy(true); setError('');
    try {
      await createProfileSkill(profileId, { category: CATEGORY, name: NAME, description: `Guarda en «${inbox}» las facturas y tickets que te envía el usuario, para que AgoraOne los archive.`,
        body: skillBody(folder.path, inbox) });
      setDone(`Skill creada. Desde ahora, envía a ese bot la foto o el PDF de una factura y aparecerá aquí para archivarla (la próxima vez que abras Fiscal o pulses «Actualizar»).`);
      setOpen(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se pudo crear la skill.'); } finally { setBusy(false); }
  };
  if (!folders.length) return null;
  return <div className="bot-inbox">
    {!open ? <p className="bot-inbox-line muted">También puedes enviar facturas a tu bot de Hermes (por Telegram, por ejemplo). <button type="button" className="button" onClick={start}>Prepararlo</button></p>
      : <div className="card">
        <h3>Recibir facturas por tu bot de Hermes</h3>
        <p>AgoraOne le crea al perfil una skill para que guarde lo que le envíes en «{inbox}», dentro de la carpeta fiscal que elijas, y aquí aparece para que lo revises y lo archives en su trimestre. No se cambia nada más de Hermes.</p>
        <div className="field-row">
          <label className="field">Perfil<ModernSelect value={profileId} onChange={setProfileId} options={profiles ?? []}/></label>
          {folders.length > 1 && <label className="field">Carpeta fiscal<ModernSelect value={String(folder?.id ?? '')} onChange={value => setFolderId(Number(value))}
            options={folders.map(f => ({ value: String(f.id), label: f.name }))}/></label>}
        </div>
        {folder && <details><summary>Texto exacto de la skill</summary><pre className="reply-body">{skillBody(folder.path, inbox)}</pre></details>}
        <p className="muted">La skill incluye la ruta de la carpeta y, como cualquier skill, la lee el modelo que use ese perfil.</p>
        {error && <LoadError message={error}/>}
        <div className="field-row">
          <button type="button" className="button primary" disabled={busy || !profileId || !folder} onClick={() => void create()}>{busy ? 'Creando…' : 'Crear la skill'}</button>
          <button type="button" className="button" disabled={busy} onClick={() => setOpen(false)}>Cancelar</button>
        </div>
      </div>}
    {done && <p className="ok-note" role="status">{done}</p>}
  </div>;
}
