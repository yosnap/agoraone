/** How an answer is cut to be spoken while it is still being written (1.7): plain words, then whole sentences only
 * (never the half sentence still arriving), the first one alone so the voice starts soon, the rest in pieces of a
 * few sentences. Pure, so it is tested apart from the audio. */

export const MAX_SPOKEN = 700;
const PIECE = 220;

/** Plain words: no Markdown, links, code or citation marks. A code block still open is left out whole. */
export function plainWords(text: string): string {
  return text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => alias ?? target)
    .replace(/\[[^\]]{1,40}\]/g, '').replace(/[*_#>`|~]/g, '').replace(/\s+/g, ' ').trim();
}

/** Where the text that is sure ends: after the last sentence mark followed by a space, or everything when final.
 * Never past a bracket still open: a citation or link half arrived («[Proyecto: Ac») may still vanish. */
export function settled(plain: string, final: boolean): number {
  if (final) return plain.length;
  const open = Math.max(plain.lastIndexOf('[') > plain.lastIndexOf(']') ? plain.lastIndexOf('[') : -1,
    plain.lastIndexOf('(') > plain.lastIndexOf(')') ? plain.lastIndexOf('(') : -1);
  const sure = open >= 0 ? plain.slice(0, open) : plain;
  let end = 0;
  for (const match of sure.matchAll(/[.!?…:;]["»)]?\s/g)) end = (match.index ?? 0) + match[0].length;
  return end;
}

/** The new text cut into pieces: the first piece of an answer is one sentence; later ones join sentences. */
export function pieces(text: string, first: boolean): string[] {
  // A sentence without marks for too long (a list) is cut at commas or spaces, so no piece is cut short later.
  const sentences = text.split(/(?<=[.!?…:;]["»)]?)\s+/).map(s => s.trim()).filter(Boolean).flatMap(sentence => {
    const parts: string[] = [];
    let rest = sentence;
    while (rest.length > PIECE * 1.5) {
      const window = rest.slice(0, PIECE);
      const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf(' '));
      const at = cut > PIECE / 2 ? cut + 1 : PIECE;
      parts.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    return rest ? [...parts, rest] : parts;
  });
  const out: string[] = [];
  for (const sentence of sentences) {
    const last = out.at(-1);
    if (last !== undefined && !(first && out.length === 1) && last.length + sentence.length + 1 <= PIECE) out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out;
}

export type Progress = { plain: string; taken: number; queued: number; final: boolean };
export const fresh = (): Progress => ({ plain: '', taken: 0, queued: 0, final: false });

/** The answer as written so far (or final): the new pieces to say and how far it has got. Up to the spoken limit,
 * there only up to the last whole sentence (or the last space when a long text has none). */
export function advance(progress: Progress, text: string, final: boolean): { next: Progress; add: string[] } {
  if (progress.final) return { next: progress, add: [] };
  const plain = plainWords(text);
  // A text that does not continue what was being said (rewritten while streaming): only its new part counts.
  const from = plain.startsWith(progress.plain.slice(0, progress.taken)) ? progress.taken : plain.length;
  const long = plain.length > MAX_SPOKEN;
  const window = plain.slice(0, MAX_SPOKEN);
  const end = long ? settled(window, false) || Math.max(window.lastIndexOf(' '), 1) : settled(plain, final);
  const add = end > from ? pieces(plain.slice(from, end), progress.queued === 0) : [];
  return { next: { plain, taken: Math.max(end, from), queued: progress.queued + add.length, final: final || long }, add };
}
