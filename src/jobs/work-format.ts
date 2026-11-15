import type { WorkTokens } from '../../shared/hermes-work';

/** «45 s», «3 min», «1 h 20 min», «2 d 3 h»: how long something ran, rounded to what is useful. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** «850», «12,4 mil», «3,1 M». */
export function count(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} mil`;
  return `${(value / 1_000_000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} M`;
}

/** «0,05 $», «< 0,01 $»; null when Hermes recorded no cost. */
export function cost(usd: number | null | undefined): string | null {
  if (usd === null || usd === undefined) return null;
  if (usd > 0 && usd < 0.01) return '< 0,01 $';
  return `${usd.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

/** «12,4 mil tokens · 0,05 $», or «sin medir» when no session could be matched. */
export function tokens(used: WorkTokens | null | undefined): string {
  if (!used) return 'sin medir';
  const money = cost(used.costUsd);
  return `${count(used.input + used.output)} tokens${money ? ` · ${money}` : ''}`;
}
