import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createProfileSkill, listProfileSkills, readProfileSkill, saveProfileSkill } from '../api/client';
import type { ProfileSkill, ProfileSkillDetail } from '../../shared/hermes-skills';
import { MarkdownField } from './markdown-field';
import { Markdown } from './markdown';
import { HiddenLines } from './hidden-lines';
import { folderColor } from './vault-folders';
import './hermes-catalog.css';
import { Loading, LoadError } from './load-state';

const markers = (text: string) => text.match(/^\s*\[línea oculta \d+\]\s*$/gm)?.map(line => line.trim()) ?? [];
const nameHelp = '1 a 64 caracteres, empezando por letra o número; solo letras minúsculas, números, guion y guion bajo.';

// The real skills of a profile, kept in its skills/ folder in Hermes: browsed by category, read as
// Markdown, and edited or created with confirmation and a previous copy (user's decision, 20/10/2026).
// Reading a skill never reaches the model; only the profile's own agent uses them.
export function ProfileSkills({ profileId }: { profileId: string }) {
  const [skills, setSkills] = useState<ProfileSkill[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProfileSkillDetail | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const latest = useRef(0);
  const [creating, setCreating] = useState(false);
  const [category, setCategory] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    const turn = ++latest.current;
    setSkills(null); setError(''); setSelected(null); setDetail(null); setEditing(false); setDraft(null); setRevealed(false);
    try {
      const data = await listProfileSkills(profileId);
      if (turn === latest.current) { setSkills(data.skills); setTruncated(data.truncated); }
    } catch { if (turn === latest.current) setError('No se pudo leer la carpeta skills del perfil. Puede haber cambiado en Hermes.'); }
  }
  useEffect(() => { void load(); }, [profileId]);
  async function open(skillId: string, reveal = false) {
    const turn = ++latest.current;
    setSelected(skillId); setDetail(null); setEditing(false); setDraft(null); setRevealed(reveal); setConflict(false); setNotice('');
    try {
      const data = await readProfileSkill(profileId, skillId, reveal);
      if (turn === latest.current) setDetail(data);
    } catch { if (turn === latest.current) { setSelected(null); setRevealed(false); setError('Esta skill no se pudo leer: puede ser demasiado grande o haber cambiado.'); } }
  }
  const toggleReveal = () => void open(detail?.id ?? '', !revealed);
  async function save() {
    if (!detail || draft === null) return;
    setSaving(true); setError('');
    try {
      const result = await saveProfileSkill(profileId, detail.id, { content: draft, revision: detail.revision, revealed });
      setEditing(false); setDraft(null);
      setNotice(`«${detail.name}» guardada en Hermes.${result.backup ? ' Se ha guardado una copia de la versión anterior.' : ''}`);
      await open(detail.id, revealed);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar la skill.');
      setConflict(e instanceof ApiError && e.status === 409); setSaving(false);
    }
  }
  async function create() {
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await createProfileSkill(profileId, { category, name, description, body });
      setCreating(false); setCategory(''); setName(''); setDescription(''); setBody('');
      setNotice(`Skill «${result.name}» creada en la carpeta skills del perfil${result.category ? ` (categoría ${result.category})` : ''}.`);
      await load();
      void open(result.id, false);
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo crear la skill.'); setSaving(false); }
  }
  const groups = useMemo(() => {
    if (!skills) return [];
    const asked = query.trim().toLocaleLowerCase('es');
    const visible = asked ? skills.filter(skill => `${skill.category} ${skill.name} ${skill.description}`.toLocaleLowerCase('es').includes(asked)) : skills;
    const byCategory = new Map<string, ProfileSkill[]>();
    for (const skill of visible) byCategory.set(skill.category, [...(byCategory.get(skill.category) ?? []), skill]);
    return [...byCategory].sort(([a], [b]) => a.localeCompare(b, 'es', { numeric: true })).map(([label, items]) => [label, items.sort((a, b) => a.name.localeCompare(b.name, 'es'))] as const);
  }, [skills, query]);
  const changed = detail !== null && draft !== null && draft !== detail.content;
  const before = detail ? markers(detail.content) : [];
  const removed = draft !== null ? before.filter(marker => !markers(draft).includes(marker)).length : 0;
  const skill = detail;
  return <section className="profile-skills" aria-label="Skills del perfil">
    <p className="notice">Las skills reales de este perfil, guardadas en su carpeta <code>skills/</code> de Hermes. Leerlas no las envía al modelo; son el propio agente del perfil quien las usa. Editarlas o crearlas se confirma y guarda antes una copia.</p>
    {error && <LoadError message={error} onRetry={skills ? undefined : () => void load()}/>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <label htmlFor="skills-search">Buscar en sus skills</label>
    <input id="skills-search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Nombre, categoría o descripción…"/>
    {!skills && !error && <Loading label="Leyendo las skills del perfil…"/>}
    {skills && <>
      <small>{skills.length} {skills.length === 1 ? 'skill' : 'skills'}{truncated ? ' (se muestran 300; hay más)' : ''} en {groups.length || 'ninguna'} {groups.length === 1 ? 'categoría' : 'categorías'}.</small>
      {groups.length > 0 && <details className="skills-groups" open>{groups.map(([label, items]) => <details key={label || 'raíz'} className="skills-category" open>
        <summary><span className="skills-dot" style={{ background: folderColor(label) }} aria-hidden="true"/>{label ? <strong>{label}</strong> : <strong>Skills sueltas</strong>}<small>{items.length} {items.length === 1 ? 'skill' : 'skills'}</small></summary>
        <div>{items.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => open(item.id)} disabled={!item.readable}>
          <strong>{item.name}</strong><small>{item.description || 'Sin descripción'}</small>{!item.readable && <small>· demasiado grande para abrir</small>}
        </button>)}</div>
      </details>)}</details>}
      {!groups.length && <p>No hay skills que coincidan{query ? ' con «' + query.trim() + '»' : ' en la carpeta skills del perfil'}.</p>}
    </>}
    {skill && <>
      <div className="skill-detail">
        <h4><span className="skills-dot" style={{ background: folderColor(skill.category) }} aria-hidden="true"/>{skill.name}{skill.category && <small>· {skill.category}</small>}<small>· {skill.bytes} bytes</small></h4>
        <HiddenLines count={skill.hidden} revealed={revealed} disabled={editing} onToggle={toggleReveal}/>
        {editing && draft !== null
          ? <div className="profile-editor">
            <MarkdownField label={`Texto de ${skill.name} (Markdown)`} value={draft} onChange={setDraft} disabled={saving} minHeight={320} autoFocus/>
            {removed > 0 && <small>Si se quitaron «líneas ocultas», esas líneas se borrarán del archivo al guardar.</small>}
            {error && <p className="error" role="alert">{error}{conflict && <button type="button" onClick={() => void open(skill.id)}>Descartar y recargar</button>}</p>}
            <div className="editor-actions">
              <button type="button" className="primary" disabled={saving || !changed} onClick={() => void save()}>{saving ? 'Guardando…' : 'Guardar en Hermes'}</button>
              <button type="button" disabled={saving} onClick={() => { setEditing(false); setDraft(null); setConflict(false); setNotice(''); }}>Cancelar</button>
            </div>
          </div>
          : <><div className="skill-body"><Markdown source={skill.content} resolve={() => null}/></div>
            {skill.readable && <button type="button" className="edit-file" onClick={() => { setNotice(''); setEditing(true); setDraft(skill.content); }}>Editar esta skill</button>}</>}
      </div>
    </>}
    {creating
      ? <form className="skill-create" onSubmit={event => { event.preventDefault(); void create(); }}>
        <h4>Crear una skill en la carpeta <code>skills/{category || '…'}</code> del perfil</h4>
        <label htmlFor="skill-category">Categoría (carpeta){category ? '' : ' — crea una nueva o reutiliza una existente'}</label>
        <input id="skill-category" value={category} onChange={event => setCategory(event.target.value)} maxLength={64} disabled={saving} placeholder="por ejemplo: escritura" list="skill-categories"/>
        <datalist id="skill-categories">{skills?.map(item => item.category).filter((value, index, all) => value && index === all.indexOf(value)).sort((a, b) => a.localeCompare(b, 'es'))}</datalist>
        <label htmlFor="skill-name">Nombre de la skill</label>
        <input id="skill-name" value={name} onChange={event => setName(event.target.value)} maxLength={64} disabled={saving} placeholder="por ejemplo: tono-de-correo" required/>
        <label htmlFor="skill-description">Descripción (qué hace y cuándo usarla)</label>
        <input id="skill-description" value={description} onChange={event => setDescription(event.target.value)} maxLength={500} disabled={saving}/>
        <label htmlFor="skill-body">Instrucciones (Markdown)</label>
        <MarkdownField label="Instrucciones de la skill (Markdown)" value={body} onChange={setBody} disabled={saving} minHeight={200}/>
        <small>{nameHelp} La descripción y el nombre se escriben en el encabezado de SKILL.md; Hermes la usará en sus próximas conversaciones.</small>
        <div className="editor-actions">
          <button type="submit" className="primary" disabled={saving || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(category) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || !body.trim()}>{saving ? 'Creando…' : 'Crear en Hermes'}</button>
          <button type="button" disabled={saving} onClick={() => setCreating(false)}>Cancelar</button>
        </div>
      </form>
      : <button type="button" className="vault-new" onClick={() => setCreating(true)}>+ Nueva skill</button>}
  </section>;
}
