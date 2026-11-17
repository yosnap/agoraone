import { useState } from 'react';

/** A slider for the music card (the point of the song or the volume): it moves with the finger and only tells the
 * player when it is let go, so Apple Music or Spotify get one order, not dozens. */
export function MusicSlider({ label, value, max, step = 1, onCommit, className = '', format }: {
  label: string; value: number; max: number; step?: number; onCommit: (value: number) => void; className?: string; format?: (value: number) => string;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  // After letting go, the slider stays where it was dropped until the player reports a new value (no jump back).
  const [sentFrom, setSentFrom] = useState<number | null>(null);
  const [sentAt, setSentAt] = useState(0);
  if (sentFrom !== null && (value !== sentFrom || Date.now() - sentAt > 5000)) { setSentFrom(null); setDraft(null); }
  const shown = draft ?? value;
  const commit = () => { if (draft !== null && sentFrom === null) { onCommit(draft); setSentFrom(value); setSentAt(Date.now()); } };
  return <input type="range" className={`music-slider ${className}`} aria-label={label} min={0} max={Math.max(max, 1)} step={step} value={Math.min(shown, Math.max(max, 1))}
    aria-valuetext={format?.(shown)} disabled={max <= 0}
    style={{ ['--filled' as string]: `${max > 0 ? Math.min(100, (shown / max) * 100) : 0}%` }}
    onChange={event => { setSentFrom(null); setDraft(Number(event.target.value)); }} onPointerUp={commit} onKeyUp={commit} onBlur={commit}/>;
}
