import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { catalogPlaces, servicePlaces } from './data/city';
import { getStatus, getHermesCatalog, type Status, type DocumentSource } from './api/client';
import { LibraryPanel } from './ui/library-panel';
import { HermesPanel, type ProfileTab } from './ui/hermes-panel';
import { sceneCopy } from './ui/scene-copy';
import type { ProfileRoom, RoomStation } from './world/profile-interior';
import { ResourcePanel } from './ui/resource-panel';
import { IntegrationsPanel } from './ui/integrations-panel';
import { serviceGroups } from './data/service-groups';
import type { HermesCatalog } from '../shared/hermes-catalog';
import './ui/hermes-catalog.css';
import { useHermesActivity } from './data/use-hermes-activity';
import { gatewaySummary } from './data/activity-format';
import { ActivityLog } from './ui/activity-log';
import { VaultPanel } from './ui/vault-panel';
import { VaultBook } from './ui/vault-book';
import { useVaultNotes } from './data/use-vault-notes';
import { lightModeLabels, useDaylightClock, type LightMode } from './world/daylight';

const lightModes: LightMode[] = ['auto', 'day', 'dusk', 'night'];
// The 3D world (three.js and its effects) loads in its own chunk, after the interface is usable.
const City = lazy(() => import('./world/city').then(module => ({ default: module.City })));
// If that chunk cannot be downloaded (network, or a rebuild while the tab was open), only the scene fails.
class WorldBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="canvas-fallback" role="alert">No se pudo cargar la ciudad 3D. Recarga la página; el directorio y el chat siguen disponibles.</div> : this.props.children; }
}

export default function App() {
  const [selected, setSelected] = useState<string | null>(null);
  const [firstPerson, setFirstPerson] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [connected, setConnected] = useState(false);
  const [catalog, setCatalog] = useState<HermesCatalog | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const places = useMemo(() => catalogPlaces(catalog), [catalog]);
  const selectablePlaces = useMemo(() => [...places, ...servicePlaces(catalog)], [places, catalog]);
  const [inside, setInside] = useState(false);
  const [integrationsInside, setIntegrationsInside] = useState(false);
  const [profileRoom, setProfileRoom] = useState<string | null>(null);
  const [profileTab, setProfileTab] = useState<ProfileTab>('info');
  const [libraryTab, setLibraryTab] = useState<'chat' | 'documents'>('chat');
  // Attachment waiting in each chat, keyed by 'library' (Luma) or profile id.
  const [attachments, setAttachments] = useState<Record<string, DocumentSource>>({});
  const [lightMode, setLightMode] = useState<LightMode>('auto');
  const daylight = useDaylightClock(lightMode);
  const hermesActivity = useHermesActivity(status?.csrf);
  const [logOpen, setLogOpen] = useState(false);
  const [vaultRoom, setVaultRoom] = useState<string | null>(null);
  const [vaultFolder, setVaultFolder] = useState<string | null>(null);
  // The note opened as a book, with the vault it belongs to.
  const [book, setBook] = useState<{ vault: string; note: string; edit?: boolean } | null>(null);
  const [walkHint, setWalkHint] = useState('Entrar al recorrido · WASD / ratón · Esc para salir');
  useEffect(() => { getStatus().then(setStatus).catch(() => setStatus({ state: 'offline', csrf: '', detail: 'Backend sin conexión. Arráncalo con npm run dev.' })); }, []);
  useEffect(() => {
    if (!status?.csrf) return;
    let live = true;
    const refresh = () => getHermesCatalog().then(data => { if (live) { setCatalog(data); setCatalogError(''); } })
      .catch(() => { if (live) setCatalogError('No se pudo actualizar Hermes. Los datos anteriores pueden estar desactualizados.'); });
    void refresh();
    const timer = setInterval(() => { if (!window.document.hidden) void refresh(); }, 30000);
    return () => { live = false; clearInterval(timer); };
  }, [status?.csrf]);
  useEffect(() => { if (selected && !selectablePlaces.some(place => place.id === selected)) setSelected(null); }, [selectablePlaces, selected]);
  const place = selectablePlaces.find(p => p.id === selected);
  const vault = useVaultNotes(vaultRoom ?? (place?.kind === 'vault' ? place.id : null) ?? book?.vault ?? null);
  const enterVault = (id: string) => { setInside(false); setIntegrationsInside(false); setProfileRoom(null); setVaultRoom(id); setFirstPerson(true); setSelected(null); };
  const openBook = (vaultId: string, note: string, edit = false) => { setBook({ vault: vaultId, note, edit }); setLogOpen(false); };
  const closeBook = useCallback(() => setBook(null), []);
  const turnPage = useCallback((note: string) => setBook(previous => previous && { ...previous, note }), []);
  const openShelf = (folder: string | null) => { if (vaultRoom) { setVaultFolder(folder); setSelected(vaultRoom); setLogOpen(false); } };
  // A note or document goes to the chosen chat (Luma or a profile); it is sent only with the user's next message there.
  const consultTargets = useMemo(() => [{ id: 'library', label: 'Luma' }, ...(catalog?.profiles ?? []).map(profile => ({ id: profile.id, label: profile.label }))], [catalog]);
  const attach = (target: string, source?: DocumentSource) => setAttachments(previous => { const next = { ...previous }; if (source) next[target] = source; else delete next[target]; return next; });
  // A renamed or deleted library copy updates or leaves every chat it was attached to.
  const changeAttachment = (id: string, source?: DocumentSource) => setAttachments(previous => Object.fromEntries(Object.entries(previous).flatMap(([target, item]) => item.id !== id ? [[target, item]] : source ? [[target, source]] : [])));
  // A profile that leaves the catalogue drops its pending attachment, so it never comes back unasked.
  useEffect(() => setAttachments(previous => {
    const kept = Object.entries(previous).filter(([target]) => consultTargets.some(item => item.id === target));
    return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept);
  }), [consultTargets]);
  const consult = (source: DocumentSource, target: string) => {
    attach(target, source); setSelected(target); setVaultFolder(null); setBook(null); setLogOpen(false);
    if (target === 'library') setLibraryTab('chat'); else setProfileTab('chat');
  };
  const enterIntegrations = () => { setVaultRoom(null); setInside(false); setProfileRoom(null); setIntegrationsInside(true); setFirstPerson(true); setSelected(null); };
  const enterProfile = (id: string) => { setVaultRoom(null); setInside(false); setIntegrationsInside(false); setProfileRoom(id); setFirstPerson(true); setSelected(null); };
  const select = (id: string) => {
    if (id.startsWith('service-')) { setVaultRoom(null); setInside(false); setProfileRoom(null); setIntegrationsInside(true); setFirstPerson(true); }
    if (id !== selected) setVaultFolder(null);
    if (id !== selected) setProfileTab('info');
    setSelected(id); setLibraryTab('chat'); setLogOpen(false);
  };
  const browse = () => { setSelected('library'); setLibraryTab('documents'); };
  const exit = () => { setBook(null); setVaultRoom(null); setVaultFolder(null); setInside(false); setIntegrationsInside(false); setProfileRoom(null); setFirstPerson(false); setSelected(null); };
  // The profile's own space: same look, theme and real declarations as in the city.
  const room = useMemo<ProfileRoom | undefined>(() => {
    const profile = catalog?.profiles.find(item => item.id === profileRoom);
    const building = places.find(item => item.id === profileRoom);
    if (!profile || !building) return undefined;
    const services = serviceGroups(catalog).flatMap(service => service.bindings.filter(binding => binding.profile.id === profile.id).map(binding => ({ id: service.id, name: service.name, enabled: binding.server.enabled })));
    return { profile, style: building.buildingStyle || 'archive', seed: building.position[0] + building.position[2], services };
  }, [catalog, places, profileRoom]);
  useEffect(() => { if (profileRoom && catalog && !room) setProfileRoom(null); }, [profileRoom, catalog, room]);
  const station = (kind: RoomStation) => { if (room) { setSelected(room.profile.id); setProfileTab(kind === 'chat' ? 'chat' : 'info'); } };
  // The book shows once its vault's listing is loaded; navigation is blocked exactly while it shows.
  const bookOpen = !!book && vault.listing?.vault.id === book.vault;
  const vaultName = catalog?.vaults?.find(item => item.id === vaultRoom)?.name ?? '';
  const kind = vaultRoom ? 'vault' : integrationsInside ? 'integrations' : room ? 'profile' : inside ? 'library' : 'city';
  const copy = sceneCopy(kind, firstPerson, vaultRoom ? vaultName : room?.profile.label);
  const indoors = kind !== 'city';
  return <main className={indoors || daylight.night > 0.5 ? 'inside-world' : undefined}>
    <div className="world"><WorldBoundary><Suspense fallback={<div className="canvas-fallback" role="status">Cargando la ciudad…</div>}><City places={places} selected={selected} onSelect={select} firstPerson={firstPerson} blocked={!!selected || bookOpen} inside={inside} integrations={integrationsInside} room={room} onStation={station} services={serviceGroups(catalog)} onBrowse={browse} onExit={exit} daylight={daylight} activity={hermesActivity.activity} vault={vaultRoom ? { name: vaultName, shelves: vault.shelves } : undefined} onShelf={openShelf} onBook={id => vaultRoom && openBook(vaultRoom, id)}/></Suspense></WorldBoundary></div>
    <header className="topbar"><a className="brand" href="/">a<span>AGORA<span className="brand-light">ONE</span></span></a><span className="top-note">TU MUNDO, EN UN LUGAR</span><div className="local-status"><i/> LOCAL · MAC</div></header>
    <section className={`intro ${indoors || daylight.night > 0.5 ? 'interior-intro' : ''}`}><div className="eyebrow">{copy.eyebrow}</div><h1>{copy.title}</h1><p>{copy.text}</p></section>
    <nav className="view-switch" aria-label="Modo de cámara"><button className={!firstPerson ? 'active' : ''} onClick={exit}>↗ Vista ciudad</button><button className={firstPerson ? 'active' : ''} onClick={() => setFirstPerson(true)}>◎ Primera persona</button>
      <button aria-pressed={logOpen} title="Registro de lo que Hermes ha hecho en las últimas 24 horas" onClick={() => { setSelected(null); setLogOpen(!logOpen); }}>◷ Registro</button>
      <button title="Iluminación de la ciudad: hora real de Madrid o fija" onClick={() => setLightMode(lightModes[(lightModes.indexOf(lightMode) + 1) % lightModes.length])}>☀ {lightModeLabels[lightMode]}</button></nav>
    {firstPerson && !selected && <button id="walk-button" className="walk-button" onClick={() => {
      const canvas = window.document.querySelector('canvas');
      if (!canvas) return;
      canvas.focus();
      Promise.resolve(canvas.requestPointerLock()).catch(() => {
        setWalkHint('Ratón libre · WASD para caminar · arrastra para mirar');
        canvas.focus();
      });
    }}>{walkHint}</button>}
    {vaultRoom ? <nav className="interior-tools" aria-label="Acciones del vault"><button onClick={() => openShelf(null)}>Ver notas</button><button onClick={exit}>Salir del vault</button></nav> : room ? <nav className="interior-tools" aria-label={`Acciones del espacio de ${room.profile.label}`}><button onClick={() => station('identity')}>Ver ficha</button><button onClick={() => station('chat')}>Conversar con {room.profile.label}</button><button onClick={exit}>Salir del espacio</button></nav> : integrationsInside ? <nav className="interior-tools" aria-label="Acciones del centro de integraciones"><button onClick={() => select('mcp-center')}>Ver MCPs</button><button onClick={exit}>Salir del centro</button></nav> : inside ? <nav className="interior-tools" aria-label="Acciones de biblioteca"><button onClick={browse}>Abrir catálogo</button><button onClick={() => select('library')}>Hablar con Luma</button><button onClick={exit}>Salir de la biblioteca</button></nav> : <aside className="directory"><div className="eyebrow">TU HERMES <span>{catalog?.profiles.length || 0} perfiles</span></div>
      <div className="catalog-status" role="status">{catalog ? <>{catalog.spaces.length} proyectos · {catalog.vaults?.length || 0} vaults · {serviceGroups(catalog).length} nombres MCP<p>Lectura: {new Date(catalog.scannedAt).toLocaleTimeString()} · actualización cada 30 s</p><p>Selecciona un perfil o MCP para ver sus vínculos declarados.</p></> : 'Detectando instalación…'}
        {catalogError && <p className="error">{catalogError}</p>}
        {!!catalog?.warnings.length && <details><summary>Detalles de detección ({catalog.warnings.length})</summary>{catalog.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
      </div>
      {places.map(p => <button key={p.id} onClick={() => select(p.id)} className={selected === p.id ? 'chosen' : ''}><span className="place-dot" style={{ background: p.color }}/><span><strong>{p.name}</strong><small>{p.kind === 'profile' ? 'Identidad y memoria · Hermes' : p.kind === 'space' ? 'Espacio registrado · Hermes' : p.kind === 'vault' ? 'Notas de Obsidian · solo lectura' : p.kind === 'service' ? 'Configurado · conexión no comprobada' : 'Luma · biblioteca propia de AgoraOne'}</small></span><span className="arrow">↗</span></button>)}</aside>}
    <div className="world-caption"><span>{copy.caption}</span><small>{copy.hint}</small></div>
    {logOpen && !place && <ActivityLog activity={hermesActivity.activity} catalog={catalog} error={hermesActivity.error} onSelect={select} onClose={() => setLogOpen(false)}/>}
    {place && <aside className="detail-panel" aria-label={`Espacio ${place.name}`}><button className="close" aria-label="Cerrar espacio" onClick={() => setSelected(null)}>×</button><div className="eyebrow">{place.kind === 'profile' ? 'PERFIL HERMES' : place.kind === 'space' ? 'ESPACIO HERMES' : place.kind === 'vault' ? 'OBSIDIAN · VAULT LOCAL' : place.kind === 'service' ? 'MCP · SERVICIO CONFIGURADO' : 'BIBLIOTECA · AGORAONE'}</div><h2>{place.character || place.name}<span style={{ background: place.color }}/></h2><p className="description">{place.description}</p>
      {place.id === 'library' ? <LibraryPanel status={status} onConnected={() => setConnected(true)} inside={inside} onEnter={() => { setVaultRoom(null); setIntegrationsInside(false); setProfileRoom(null); setInside(true); setFirstPerson(true); setSelected(null); }} tab={libraryTab} onTab={setLibraryTab} document={attachments.library} onDetach={() => attach('library')} targets={consultTargets} onConsult={consult} onChanged={changeAttachment}/> : catalog && (place.id === 'mcp-center' ? <IntegrationsPanel catalog={catalog} inside={integrationsInside} onEnter={enterIntegrations} onSelect={select}/> : place.kind === 'vault' ? <VaultPanel key={place.id} vaultId={place.id} listing={vault.listing} error={vault.error} inside={vaultRoom === place.id} onEnter={() => enterVault(place.id)} folder={vaultFolder} onFolder={setVaultFolder} onRead={id => openBook(place.id, id)} reading={book?.vault === place.id ? book.note : null} onCreated={id => { vault.reload(); openBook(place.id, id, true); }}/> : place.kind === 'service' ? <ResourcePanel key={place.id} id={place.id} catalog={catalog} onSelect={select} activity={hermesActivity.activity}/> : <HermesPanel key={place.id} id={place.id} catalog={catalog} onSelect={select} status={status} onConnected={() => setConnected(true)} tab={profileTab} onTab={setProfileTab} inside={profileRoom === place.id} onEnter={() => enterProfile(place.id)} activity={hermesActivity} document={attachments[place.id]} onDetach={() => attach(place.id)}/>)}
    </aside>}
    {bookOpen && book && vault.listing && <VaultBook vaultId={book.vault} vaultName={vault.listing.vault.name} noteId={book.note} notes={vault.listing.notes}
      onOpen={turnPage} onClose={closeBook} targets={consultTargets} onConsult={consult} onChanged={vault.reload} startEditing={book.edit}/>}
    <footer className="statusbar"><span>● {connected ? 'Hermes conectado · respuesta real recibida' : status?.state === 'configured' ? 'Hermes configurado · respuesta por verificar' : 'Hermes pendiente de conexión'}</span><span role="status" title="Dato real leído del estado del gateway de Hermes cada 15 s">◉ {hermesActivity.error ? 'Gateway Hermes · no se pudo leer su estado' : gatewaySummary(hermesActivity.activity)}</span><span>Paseos y peatones: ambiente, no tareas reales · sin llamadas a modelos</span></footer>
  </main>;
}
