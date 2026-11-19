import { useState, useSyncExternalStore } from 'react';
import { ApiError } from '../api/client';
import { confirmCrmdevChange, previewCrmdevChange, type CrmdevChangePreview, type CrmdevChangeRequest } from '../api/crmdev';
import type { ReviewCurrent, ReviewState } from '../ui/change-review';
import { crmdevStore } from './use-crmdev-view';

// The two steps of every change to CRMDev: «Revisar el cambio» asks the core for the exact change (before and after,
// field by field, read from CRMDev now) and «Guardar en CRMDev» sends exactly that, once. If it changed in CRMDev
// meanwhile, what there is now is shown and nothing is retried by itself. After saving, what is on screen is read again
// (the core has already forgotten the lists the change made old).
//
// The state of each change lives here, outside React, under the key of what is edited («tarea:t1»): the reread that
// follows a conflict brings a new row and may re-render or remount the form, and the conflict must still be on screen.

type Conflict = NonNullable<ReviewState['conflict']>;
type Exists = NonNullable<ReviewState['exists']>;
/** A creation whose earlier try never got an answer: the user looks in CRMDev and may then «Crear de todos modos». */
export type Doubtful = { message: string; request: CrmdevChangeRequest };
export type ChangeState = { preview: CrmdevChangePreview | null; busy: boolean; error: string; conflict: Conflict | null; exists: Exists | null;
  doubtful: Doubtful | null };
export type ChangeApi = { preview: typeof previewCrmdevChange; confirm: typeof confirmCrmdevChange };
const IDLE: ChangeState = { preview: null, busy: false, error: '', conflict: null, exists: null, doubtful: null };
const REAL: ChangeApi = { preview: previewCrmdevChange, confirm: confirmCrmdevChange };

/** The key of what a form changes: the kind and the record's id (or what a new one hangs from). */
export const changeKey = (kind: CrmdevChangeRequest['kind'], id = '') => `${kind}:${id}`;

const states = new Map<string, ChangeState>();
const sending = new Set<string>();
const listeners = new Set<() => void>();
const listen = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const put = (key: string, state: ChangeState) => { states.set(key, state); listeners.forEach(listener => listener()); };
export const changeOf = (key: string): ChangeState => states.get(key) ?? IDLE;
/** Forgets one change (a form opened anew, cancelled or done). */
export const resetChange = (key: string) => put(key, IDLE);
/** Forgets every change (a new visit of the section). */
export const clearChanges = () => { states.clear(); listeners.forEach(listener => listener()); };

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const kindOf = (error: unknown) => (error instanceof ApiError ? String(error.data?.status ?? '') : '');
const conflictOf = (error: unknown): Conflict | null => {
  if (!(error instanceof ApiError) || error.status !== 409 || error.data?.status !== 'conflict') return null;
  return { message: error.message, current: Array.isArray(error.data.current) ? (error.data.current as ReviewCurrent[]) : [] };
};
const existsOf = (error: unknown): Exists | null => {
  if (!(error instanceof ApiError) || error.data?.status !== 'exists') return null;
  return { message: error.message, id: typeof error.data.crmdevId === 'string' ? error.data.crmdevId : null };
};

/** «Revisar el cambio»: the exact change, or why it cannot be offered. The request goes as given. */
export async function askChange(key: string, request: CrmdevChangeRequest, api: ChangeApi = REAL) {
  put(key, { ...IDLE, busy: true });
  try { put(key, { ...IDLE, preview: await api.preview(request) }); }
  catch (error) {
    const exists = existsOf(error), conflict = conflictOf(error);
    const doubtful = kindOf(error) === 'doubtful' ? { message: messageOf(error, ''), request } : null;
    put(key, { ...IDLE, exists, conflict, doubtful, error: exists || conflict || doubtful ? '' : messageOf(error, 'No se pudo preparar el cambio.') });
  }
}

/** «Crear de todos modos», after looking in CRMDev: the same creation, now said explicitly. */
export async function askAnyway(key: string, api: ChangeApi = REAL) {
  const doubtful = changeOf(key).doubtful;
  if (doubtful && (doubtful.request.kind === 'tarea-nueva' || doubtful.request.kind === 'cliente-nuevo' || doubtful.request.kind === 'cliente-desde-local')) await askChange(key, { ...doubtful.request, anyway: true }, api);
}

/** «Guardar en CRMDev»: sends the token of the preview once and calls `onDone` with what to say. */
export async function sendChange(key: string, onDone: (said: string) => void, api: ChangeApi = REAL) {
  const state = changeOf(key), preview = state.preview;
  // Marked at once (not with the state, which a second click in the same moment would still see as idle).
  if (!preview || sending.has(key)) return;
  sending.add(key);
  put(key, { ...state, busy: true, error: '' });
  try {
    const done = await api.confirm(preview.token);
    put(key, IDLE);
    crmdevStore.forget({ keep: true });
    onDone(done.warning ?? `${done.title}: guardado en CRMDev.`);
  } catch (error) {
    const conflict = conflictOf(error), exists = existsOf(error), kind = kindOf(error);
    // Still being sent (from another window), or CRMDev busy or not heard (nothing sent, or read again before
    // sending): the preview stays so the user may press again; anything else is reviewed anew.
    const keep = kind === 'repeated' || kind === 'busy' || kind === 'unreachable';
    put(key, { ...IDLE, preview: keep && !conflict && !exists ? preview : null, conflict, exists,
      error: conflict || exists ? '' : messageOf(error, 'No se pudo guardar en CRMDev.') });
    // What is on screen is old, or CRMDev may have changed: read again (the core already forgot those lists).
    if (conflict || exists || kind === 'unknown' || kind === 'unreachable' || kind === 'error') crmdevStore.forget({ keep: true });
  } finally { sending.delete(key); }
}

/** The state of the change of `key`, and its actions. */
export function useCrmdevChange(key: string, onDone: (said: string) => void) {
  const state = useSyncExternalStore(listen, () => changeOf(key), () => changeOf(key));
  return { ...state, ask: (request: CrmdevChangeRequest) => askChange(key, request), send: () => sendChange(key, onDone),
    reset: () => resetChange(key), anyway: () => askAnyway(key) };
}

/** The row being edited in a list: kept by id, so a reread does not close the form; the last row seen stays when it
 * left the list (`gone`, said on screen), never closed silently. */
export function useEditing<T extends { id: string | null }>(rows: T[] | undefined) {
  const [editing, setEditing] = useState<{ id: string; row?: T } | null>(null);
  const current = editing ? rows?.find(row => row.id === editing.id) : undefined;
  const row = current ?? editing?.row;
  return { id: editing?.id ?? null, row: row && editing ? { ...row, id: editing.id } : undefined, gone: Boolean(editing?.row && rows && !current),
    /** `row` is the one on screen; without it (an id from elsewhere), it shows once a reading has it. */
    open: (id: string, row?: T) => setEditing({ id, row }), close: () => setEditing(null) };
}
