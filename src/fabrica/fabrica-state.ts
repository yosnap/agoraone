import { useSyncExternalStore } from 'react';
import { getAddons, type Addon, type AddonStatus } from '../api/core';
import type { FabricaPage } from '../api/fabrica';

// What the «Mi fábrica» section knows: the add-on's status as Conectores reads it (its folder and whether its panel
// answers at /salud). Read when the section opens and with «Volver a comprobar»; never on a timer, except a few
// checks right after «Arrancar la fábrica», to say whether it came up.

export type FabricaState = 'running' | 'stopped' | 'missing' | 'wrong' | 'unreadable';

export function fabricaState(status: AddonStatus): FabricaState {
  return status === 'responding' ? 'running' : status === 'detected' ? 'stopped' : status === 'not_configured' ? 'missing'
    : status === 'not_found' ? 'wrong' : 'unreadable';
}

export const stateTexts: Record<FabricaState, { label: string; text: string }> = {
  running: { label: 'En marcha', text: 'Su panel responde. Cada pantalla se abre en una ventana encima de AgoraOne, con su mismo tamaño; al cerrarla vuelves aquí.' },
  stopped: { label: 'Parada', text: 'La carpeta es la de tu fábrica, pero su panel no responde. Arráncala con su servicio de macOS o en la terminal, desde su carpeta, con «fabrica servicio instalar» (se queda en marcha) o «fabrica servir».' },
  missing: { label: 'Sin carpeta', text: 'Indica la carpeta de tu fábrica en Conectores (y su puerto, si no es 8742).' },
  wrong: { label: 'Carpeta errónea', text: 'La carpeta guardada en Conectores no es la de tu fábrica (no tiene su pyproject.toml): corrígela allí.' },
  unreadable: { label: 'Sin leer', text: 'No se pudo comprobar la fábrica. Vuelve a comprobarlo en un momento.' },
};

/** Whether «Arrancar la fábrica» is offered: stopped and on macOS (its service is launchd's). */
export const canStart = (state: FabricaState, mac: boolean) => state === 'stopped' && mac;
export const onMac = () => typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

/** The panel's screens, in its own order, and what is done in each. */
export const PANEL_PAGES: { page: FabricaPage; label: string; what: string }[] = [
  { page: '', label: 'Estado', what: 'qué está haciendo la fábrica y lo último que ha pasado' },
  { page: 'corridas', label: 'Corridas', what: 'aprobar, aprobar sin el vídeo o rechazar las que esperan; ver sus vídeos y descargar sus archivos' },
  { page: 'publicaciones', label: 'Publicaciones', what: 'lo publicado y cómo va' },
  { page: 'competidores', label: 'Competidores', what: 'revisar, añadir, vigilar o descartar cuentas' },
  { page: 'piezas', label: 'Piezas', what: 'lo que publica la competencia que vigilas' },
  { page: 'ideas', label: 'Ideas', what: 'guardar o descartar ideas' },
  { page: 'senales', label: 'Señales', what: 'lo que pregunta, pide y le cuesta a tu público' },
  { page: 'ajustes', label: 'Ajustes', what: 'cambiar los ajustes de la fábrica, con su confirmación' },
];

export type FabricaRead = { addon: Addon | null; failure: string; loading: boolean };
type Fetcher = () => Promise<{ addons: Addon[] }>;

const EMPTY: FabricaRead = { addon: null, failure: '', loading: false };
let read = EMPTY;
let asked = false;
let generation = 0;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Reads the status unless it is read already (`again`: read anew). Called while rendering: it never notifies right away. */
export function readFabrica(again = false, fetcher: Fetcher = getAddons): Promise<FabricaRead> {
  if (asked && !again) return Promise.resolve(read);
  asked = true;
  const mine = ++generation;
  read = { ...read, failure: '', loading: true };
  if (again) notify();
  return fetcher().then(answer => {
    const addon = answer.addons.find(item => item.id === 'fabrica') ?? null;
    if (generation === mine) read = addon ? { addon, failure: '', loading: false } : { addon: null, failure: 'AgoraOne no conoce la fábrica.', loading: false };
  }, (error: unknown) => {
    if (generation === mine) read = { addon: null, failure: error instanceof Error ? error.message : 'No se pudo comprobar la fábrica.', loading: false };
  }).then(() => { if (generation === mine) notify(); return read; });
}

/** Once per visit: what was read before is not shown as current. */
export function freshFabrica() {
  asked = false;
  read = EMPTY;
}

export function useFabricaRead(): FabricaRead & { reload: () => void } {
  void readFabrica();
  return { ...useSyncExternalStore(subscribe, () => read), reload: () => void readFabrica(true) };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** After «Arrancar»: checks a few times whether the panel answers; true as soon as it does. */
export async function waitUntilRunning(tries = 6, every = 2500, fetcher: Fetcher = getAddons): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    await pause(every);
    const found = await readFabrica(true, fetcher);
    if (found.addon?.status === 'responding') return true;
  }
  return false;
}
