import type { ReactNode } from 'react';

/** Release notes keep `code` and **bold** from their Markdown; anything else is plain text (never HTML). */
export function InlineText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(match[1] !== undefined ? <code key={at}>{match[1]}</code> : <strong key={at}>{match[2]}</strong>);
    last = at + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
