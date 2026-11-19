import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { confirmCrmdevChange, previewCrmdevChange, type CrmdevChangePreview, type CrmdevChangeRequest } from '../api/crmdev';
import type { ReviewCurrent, ReviewState } from '../ui/change-review';
import { crmdevStore } from './use-crmdev-view';

// The two steps of every change to CRMDev: «Revisar el cambio» asks the core for the exact change (before and after,
// field by field, read from CRMDev now) and «Guardar en CRMDev» sends exactly that, once. If it changed in CRMDev
// meanwhile, what there is now is shown and nothing is retried by itself. After saving, what is on screen is read again
// (the core has already forgotten the lists the change made old).

type Conflict = NonNullable<ReviewState['conflict']>;
type Exists = NonNullable<ReviewState['exists']>;
type State = { preview: CrmdevChangePreview | null; busy: boolean; error: string; conflict: Conflict | null; exists: Exists | null };
const IDLE: State = { preview: null, busy: false, error: '', conflict: null, exists: null };

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

/** The state of one change: `ask` shows its preview, `send` saves it in CRMDev and calls `onDone` with what to say. */
export function useCrmdevChange(onDone: (said: string) => void) {
  const [state, setState] = useState<State>(IDLE);
  const ask = async (change: CrmdevChangeRequest) => {
    setState({ ...IDLE, busy: true });
    try { setState({ ...IDLE, preview: await previewCrmdevChange(change) }); }
    catch (error) {
      const exists = existsOf(error), conflict = conflictOf(error);
      setState({ ...IDLE, exists, conflict, error: exists || conflict ? '' : messageOf(error, 'No se pudo preparar el cambio.') });
    }
  };
  // Marked at once (not with the state, which a second click in the same moment would still see as idle).
  const sending = useRef(false);
  const send = async () => {
    const preview = state.preview;
    if (!preview || sending.current) return;
    sending.current = true;
    setState({ ...state, busy: true, error: '' });
    try {
      const done = await confirmCrmdevChange(preview.token);
      setState(IDLE);
      crmdevStore.forget({ keep: true });
      onDone(done.warning ?? `${done.title}: guardado en CRMDev.`);
    } catch (error) {
      const conflict = conflictOf(error), exists = existsOf(error), kind = kindOf(error);
      // Still being sent (from another window), or CRMDev busy or not heard (nothing sent, or read again before
      // sending): the preview stays so the user may press again; anything else is reviewed anew.
      const keep = kind === 'repeated' || kind === 'busy' || kind === 'unreachable';
      // What is on screen is old, or CRMDev may have changed: read again (the core already forgot those lists).
      if (conflict || exists || kind === 'unknown' || kind === 'unreachable' || kind === 'error') crmdevStore.forget({ keep: true });
      setState({ preview: keep && !conflict && !exists ? preview : null, busy: false, conflict, exists,
        error: conflict || exists ? '' : messageOf(error, 'No se pudo guardar en CRMDev.') });
    } finally { sending.current = false; }
  };
  return { ...state, ask, send, reset: () => setState(IDLE) };
}
