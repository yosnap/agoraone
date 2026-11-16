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

/** Where the text that is sure ends: after the last sentence mark followed by a space, or everything when final. */
export function settled(plain: string, final: boolean): number {
  if (final) return plain.length;
  let end = 0;
  for (const match of plain.matchAll(/[.!?…:;]["»)]?\s/g)) end = (match.index ?? 0) + match[0].length;
  return end;
}

/** The new text cut into pieces: the first piece of an answer is one sentence; later ones join sentences. */
export function pieces(text: string, first: boolean): string[] {
  const sentences = text.split(/(?<=[.!?…:;]["»)]?)\s+/).map(s => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const sentence of sentences) {
    const last = out.at(-1);
    if (last !== undefined && !(first && out.length === 1) && last.length + sentence.length + 1 <= PIECE) out[out.length - 1] = `${last} ${sentence}`;
    else out.push(sentence);
  }
  return out;
}
