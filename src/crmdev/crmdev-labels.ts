// CRMDev's values in Spanish of Spain. A value CRMDev adds later is shown as it comes: never hidden, never guessed.

export const projectStatusLabels: Record<string, string> = {
  NOT_STARTED: 'Sin empezar', IN_PROGRESS: 'En curso', ON_HOLD: 'En pausa', COMPLETED: 'Terminado', CANCELLED: 'Cancelado',
};
export const taskStatusLabels: Record<string, string> = {
  TODO: 'Por hacer', IN_PROGRESS: 'En curso', IN_REVIEW: 'En revisión', DONE: 'Hecha', CANCELLED: 'Cancelada',
};
export const ticketStatusLabels: Record<string, string> = {
  OPEN: 'Abierto', IN_PROGRESS: 'En curso', WAITING_CLIENT: 'Esperando al cliente', RESOLVED: 'Resuelto', CLOSED: 'Cerrado',
};
export const clientStatusLabels: Record<string, string> = {
  LEAD: 'Contacto', PROSPECT: 'Posible cliente', CUSTOMER: 'Cliente', INACTIVE: 'Inactivo', CHURNED: 'Perdido',
};
export const priorityLabels: Record<string, string> = { LOW: 'Baja', MEDIUM: 'Media', HIGH: 'Alta', URGENT: 'Urgente' };
export const categoryLabels: Record<string, string> = {
  BUG: 'Error', FEATURE_REQUEST: 'Petición de función', QUESTION: 'Pregunta', SUPPORT: 'Soporte', BILLING: 'Facturación',
  PERFORMANCE: 'Rendimiento', SECURITY: 'Seguridad', OTHER: 'Otra',
};
export const projectTypeLabels: Record<string, string> = { GITHUB: 'GitHub' };

/** The Spanish label of a value, the value itself when unknown, or «—» when missing. */
export const labelOf = (labels: Record<string, string>, value: string | null | undefined) => (value ? labels[value] ?? value : '—');

/** The options of a filter: «Todos» (empty value) and then each known value. */
export const filterOptions = (labels: Record<string, string>, all = 'Todos') =>
  [{ value: '', label: all }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))];

const GOOD = new Set(['COMPLETED', 'DONE', 'RESOLVED', 'CLOSED', 'CUSTOMER']);
const WAITING = new Set(['ON_HOLD', 'IN_REVIEW', 'WAITING_CLIENT', 'PROSPECT', 'LEAD', 'HIGH']);

/** The tone of the badge of a state or priority: done is good, waiting is amber, urgent is red, the rest grey. */
export function statusTone(value: string | null) {
  if (!value) return 'neutral';
  return GOOD.has(value) ? 'good' : WAITING.has(value) ? 'waiting' : value === 'URGENT' ? 'bad' : 'neutral';
}

const day = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Madrid' });

/** A date of CRMDev as a day of Madrid, or «—». */
export function dayLabel(iso: string | null | undefined) {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime()) ? day.format(at) : '—';
}

/** Minutes as «2 h 30 min», «45 min» or «—». */
export function minutesLabel(minutes: number | null | undefined) {
  if (minutes == null || minutes < 0) return '—';
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? (rest ? `${hours} h ${rest} min` : `${hours} h`) : `${rest} min`;
}
