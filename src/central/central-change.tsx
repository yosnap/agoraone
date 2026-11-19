import { useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { confirmCentralChange, getWritePermissions, previewCentralChange, type ChangePreview, type ChangeRequest, type CurrentRow } from '../api/central-write';
import { ChangeReview as SharedReview } from '../ui/change-review';
import { useCentralRead } from './use-central-view';

// The two steps of every change to Central: «Revisar el cambio» asks the core for the exact change (before and after,
// field by field) and «Guardar en Central» sends exactly that, once. A conflict (changed in Central meanwhile) shows
// what Central has now and offers to review again; nothing is retried by itself.

type Conflict = { message: string; current: CurrentRow[] };
/** «Crear en Central» for a client Central already has: link with that one instead. */
type Exists = { message: string; centralId: string | null; centralName: string };
type State = { preview: ChangePreview | null; busy: boolean; error: string; conflict: Conflict | null; exists: Exists | null };
const IDLE: State = { preview: null, busy: false, error: '', conflict: null, exists: null };
const CONFLICTS = new Set(['conflict', 'status_locked', 'duplicate']);

const messageOf = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);
const conflictOf = (error: unknown): Conflict | null => {
  if (!(error instanceof ApiError) || error.status !== 409 || !CONFLICTS.has(String(error.data?.status))) return null;
  const current = Array.isArray(error.data?.current) ? (error.data.current as CurrentRow[]) : [];
  return { message: error.message, current };
};

/** The state of one change: `ask` shows its preview, `send` saves it in Central and calls `onDone` with what to say. */
export function useCentralChange(onDone: (said: string) => void) {
  const [state, setState] = useState<State>(IDLE);
  const ask = async (change: ChangeRequest) => {
    setState({ ...IDLE, busy: true });
    try { setState({ ...IDLE, preview: await previewCentralChange(change) }); }
    catch (error) {
      if (error instanceof ApiError && error.data?.status === 'exists') {
        const id = typeof error.data.centralId === 'string' ? error.data.centralId : null;
        setState({ ...IDLE, exists: { message: error.message, centralId: id, centralName: String(error.data.centralName ?? '') } });
        return;
      }
      const conflict = conflictOf(error);
      setState({ ...IDLE, conflict, error: conflict ? '' : messageOf(error, 'No se pudo preparar el cambio.') });
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
      const done = await confirmCentralChange(preview.token);
      setState(IDLE);
      onDone(done.warning ?? `${done.title}: guardado en Central.`);
    } catch (error) {
      const conflict = conflictOf(error);
      const kind = error instanceof ApiError ? String(error.data?.status ?? '') : '';
      // Still being sent (from another window): the preview stays, never the form, so it is not asked again.
      // Central busy (nothing written) keeps it too so the user may press again; anything else is reviewed anew.
      const keep = kind === 'repeated' || kind === 'busy' || kind === 'unreachable';
      setState({ preview: keep && !conflict ? preview : null, busy: false, conflict, exists: null,
        error: conflict ? '' : messageOf(error, 'No se pudo guardar en Central.') });
    } finally { sending.current = false; }
  };
  return { ...state, ask, send, reset: () => setState(IDLE) };
}

/** Whether the saved key may change Central (read once per visit of the section, with the other readings). */
export function useWritePermissions() {
  const read = useCentralRead('permisos-escritura', getWritePermissions);
  return { central: read.data?.central === true, quotes: read.data?.quotes === true, problem: read.data?.problem ?? null,
    quotesProblem: read.data?.quotesProblem ?? null };
}

/** The review of a change to Central (src/ui/change-review.tsx); `onLink` links with the existing client of a
 * «Crear en Central» that Central already has. */
export function ChangeReview({ change, onCancel, onReview, onLink }: {
  change: ReturnType<typeof useCentralChange>; onCancel: () => void; onReview: () => void; onLink?: (centralId: string) => void;
}) {
  const exists = change.exists && { message: change.exists.message, id: change.exists.centralId };
  return <SharedReview change={{ ...change, exists }} where="Central" onCancel={onCancel} onReview={onReview} onLink={onLink} linkLabel="Enlazar con el existente"/>;
}
