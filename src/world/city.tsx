import type { AgentStatus } from '../office/agent-state';
import { Canvas } from '@react-three/fiber';
import { PCFShadowMap } from 'three';
import { Component, Suspense, type ReactNode } from 'react';
import { cityExtent, type Place } from '../data/city';
import { Building } from './building';
import { Navigation } from './navigation';
import { LibraryInterior, libraryObstacles } from './library-interior';
import { ProfileInterior, profileObstacles, type ProfileRoom, type RoomStation } from './profile-interior';
import { shellBackground } from './profile-shell';
import { ResourceLinks } from './resource-links';
import { IntegrationsInterior, integrationObstacles } from './integrations-interior';
import { VaultInterior, vaultObstacles } from './vault-interior';
import type { VaultShelf } from '../data/use-vault-notes';
import { CityLighting, Reflections } from './city-lighting';
import { CityStreets } from './city-streets';
import { CityNature } from './city-nature';
import { CityPedestrians } from './city-pedestrians';
import { DaylightProvider, daylightAt, type Daylight } from './daylight';
import { SceneEffects } from './scene-effects';
import type { HermesActivity } from '../../shared/hermes-activity';
import type { ServiceGroup } from '../data/service-groups';
import type { CodingSession } from '../api/core';
import { CodingCrew } from './coding-crew';

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="canvas-fallback">No se pudo iniciar WebGL. Puedes usar el directorio de espacios y el chat.</div> : this.props.children; }
}

export function City({ places, paused = false, statuses = {}, coding = [], selected, onSelect, firstPerson, blocked, inside = false, integrations = false, room, services = [], onBrowse, onExit, onStation, activity, vault, onShelf, onBook, daylight = daylightAt(new Date(), 'day') }: {
  places: Place[]; paused?: boolean; statuses?: Record<string, AgentStatus>; coding?: CodingSession[];
  selected: string | null; onSelect: (id: string) => void; firstPerson: boolean; blocked: boolean;
  inside?: boolean; onBrowse: () => void; onExit: () => void;
  integrations?: boolean; services?: ServiceGroup[]; daylight?: Daylight;
  room?: ProfileRoom; onStation?: (station: RoomStation) => void; activity?: HermesActivity | null;
  vault?: { name: string; shelves: VaultShelf[] }; onShelf?: (folder: string | null) => void; onBook?: (id: string) => void;
}) {
  const extent = cityExtent(places);
  const library = places.find(place => place.id === 'library');
  const interior = vault ? { key: 'vault', background: '#2f2a44', obstacles: vaultObstacles, node: <VaultInterior name={vault.name} shelves={vault.shelves} onOpen={folder => onShelf?.(folder)} onBook={id => onBook?.(id)} onExit={onExit}/> }
    : integrations ? { key: 'integrations', background: '#18343d', obstacles: integrationObstacles, node: <IntegrationsInterior services={services} activity={activity} onSelect={onSelect} onExit={onExit}/> }
    : room ? { key: `profile:${room.profile.id}`, background: shellBackground[room.style] ?? '#d9d2c4', obstacles: profileObstacles, node: <ProfileInterior room={room} activity={activity?.profiles[room.profile.id]} onStation={station => onStation?.(station)} onService={onSelect} onExit={onExit}/> }
    : inside ? { key: 'library', background: '#213c36', obstacles: libraryObstacles, node: <LibraryInterior seed={library ? library.position[0] + library.position[2] : 0} onBrowse={onBrowse} onChat={() => onSelect('library')} onExit={onExit}/> }
    : null;
  return <SceneBoundary><Canvas frameloop={paused ? 'never' : 'always'} tabIndex={0} shadows={{ type: PCFShadowMap }} dpr={[1, 1.7]} camera={{ position: [24, 25, 30], fov: 43, far: 1000 }} onCreated={({ gl }) => { gl.domElement.tabIndex = 0; }} fallback={<p>WebGL no disponible. Usa el directorio.</p>}><DaylightProvider value={daylight}>
    {interior ? <><color attach="background" args={[interior.background]}/><Suspense fallback={null}>{interior.node}</Suspense><Reflections/></> : <Suspense fallback={null}>
    <CityLighting extent={extent} firstPerson={firstPerson}/>
    <CityStreets places={places} extent={extent}/>
    <CityNature places={places} extent={extent}/>
    <CityPedestrians places={places} extent={extent}/>
    {places.map(place => <Building key={place.id} place={place} selected={selected === place.id} onSelect={() => onSelect(place.id)} activity={activity?.profiles[place.id]} status={statuses[place.id]}/>)}
    {places.filter(place => place.kind === 'workshop').map(place => <CodingCrew key={place.id} place={place} sessions={coding} onSelect={() => onSelect(place.id)}/>)}
    <ResourceLinks places={places} selected={selected}/>
    </Suspense>}
    <SceneEffects/>
    <Navigation places={places} firstPerson={firstPerson} blocked={blocked} inside={!!interior} room={interior?.key} obstacles={interior?.obstacles}/>
  </DaylightProvider></Canvas></SceneBoundary>;
}
