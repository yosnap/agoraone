import { Fragment, type ReactNode } from 'react';

// A small Markdown reader for Obsidian notes. It only builds React elements (never raw HTML), so a
// note cannot inject markup or scripts. Wikilinks open other notes of the same vault; web links
// open in a new tab; embeds and other files are shown as names only, since attachments are never read.
export type WikiResolver = (target: string) => (() => void) | null;
export type Heading = { level: number; text: string; anchor: string };

const anchorOf = (text: string, index: number) => `h-${index}-${text.toLocaleLowerCase('es').replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 40)}`;
const safeHref = (href: string) => /^(https?:|mailto:)/i.test(href) ? href : null;
const headingLine = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const hiddenLine = /^\[línea oculta \d+\]$/;
// Lines longer than this are shown as plain text: inline parsing stays linear on any note.
const maxInlineLine = 10_000;

// Every bracketed form is bounded so a line full of unclosed «[» cannot make the scan quadratic.
const inlinePattern = new RegExp([
  '(`[^`\\n]{1,2000}`)', '(!\\[\\[[^\\]\\n]{1,500}\\]\\])', '(\\[\\[[^\\]\\n]{1,500}\\]\\])',
  '(!?\\[[^\\]\\n]{0,500}\\]\\((?:[^()\\s]|\\([^()\\s]{0,200}\\)){1,2048}(?:\\s+"[^"\\n]{0,200}")?\\))',
  '(\\*\\*[^*\\n]{1,2000}\\*\\*|(?<![\\p{L}\\p{N}])__[^_\\n]{1,2000}__(?![\\p{L}\\p{N}]))', '(~~[^~\\n]{1,2000}~~)', '(==[^=\\n]{1,2000}==)',
  '(\\*[^*\\s][^*\\n]{0,2000}\\*|(?<![\\p{L}\\p{N}_])_[^_\\s][^_\\n]{0,2000}_(?![\\p{L}\\p{N}_]))',
  '((?:^|(?<=\\s))#[\\p{L}\\p{N}_/-]+)',
].join('|'), 'gu');

function inline(text: string, resolve: WikiResolver, key = 'i'): ReactNode[] {
  if (text.length > maxInlineLine) return [text];
  const out: ReactNode[] = [];
  const pattern = new RegExp(inlinePattern);
  let last = 0, match: RegExpExecArray | null, n = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0], id = `${key}-${n++}`;
    if (match[1]) out.push(<code key={id}>{token.slice(1, -1)}</code>);
    else if (match[2]) out.push(<span key={id} className="md-embed">📎 {token.slice(3, -2).split('|')[0]}</span>);
    else if (match[3]) {
      const [target, alias] = token.slice(2, -2).split('|');
      const note = target.split('#')[0].trim(), label = (alias ?? target).trim();
      // «[[#Sección]]» points inside the note being read: shown as a link-like label, never as missing.
      const open = note ? resolve(note) : null;
      out.push(open ? <button key={id} type="button" className="md-wikilink" onClick={open}>{label}</button>
        : <span key={id} className={note ? 'md-wikilink missing' : 'md-wikilink'} title={note ? 'No está en el vault' : undefined}>{label}</span>);
    } else if (match[4]) {
      const image = token.startsWith('!'), [, label, href] = /^!?\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)$/.exec(token) ?? [];
      const url = safeHref(href ?? '');
      out.push(image ? <span key={id} className="md-embed">🖼 {label || href}</span>
        : url ? <a key={id} href={url} target="_blank" rel="noopener noreferrer">{label || url}</a> : <span key={id}>{label}</span>);
    } else if (match[5]) out.push(<strong key={id}>{inline(token.slice(2, -2), resolve, id)}</strong>);
    else if (match[6]) out.push(<s key={id}>{inline(token.slice(2, -2), resolve, id)}</s>);
    else if (match[7]) out.push(<mark key={id}>{token.slice(2, -2)}</mark>);
    else if (match[8]) out.push(<em key={id}>{inline(token.slice(1, -1), resolve, id)}</em>);
    else out.push(<span key={id} className="md-tag">{token.trim()}</span>);
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Splits YAML frontmatter from the body. Only a block made of «key: value» lines, indented list
 * items or continuations counts; anything else (a note that merely starts with a rule) stays body.
 */
function frontmatter(source: string) {
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/.exec(source);
  const none = { props: [] as [string, string][], body: source };
  if (!match) return none;
  const props: [string, string[]][] = [];
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const pair = /^([^\s:][^:]*):(?:\s+(.*)|\s*)$/.exec(line);
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (pair) props.push([pair[1].trim(), pair[2]?.trim() ? [pair[2].trim()] : []]);
    else if (item && props.length) props.at(-1)![1].push(item[1].trim());
    else if (/^\s+\S/.test(line) && props.length) props.at(-1)![1].push(line.trim());
    else return none;
  }
  return { props: props.map(([name, values]) => [name, values.join(', ')] as [string, string]), body: source.slice(match[0].length) };
}

/** An opening fence and the rule that closes it: same character, at least as long. */
const fenceOf = (line: string) => /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
const closes = (line: string, fence: string) => new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line);

export function headingsOf(source: string): Heading[] {
  const { body } = frontmatter(source);
  let fence: string | null = null;
  return body.split(/\r?\n/).flatMap((line, index) => {
    if (fence) { if (closes(line, fence)) fence = null; return []; }
    const open = fenceOf(line);
    if (open) { fence = open[1]; return []; }
    const match = headingLine.exec(line);
    return match ? [{ level: match[1].length, text: match[2], anchor: anchorOf(match[2], index) }] : [];
  });
}

const splitRow = (row: string) => row.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));

export function Markdown({ source, resolve }: { source: string; resolve: WikiResolver }) {
  const { props, body } = frontmatter(source);
  const lines = body.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  const isTable = (at: number) => /^\s*\|.*\|\s*$/.test(lines[at] ?? '') && /^\s*\|?\s*:?-{2,}/.test(lines[at + 1] ?? '');
  const isRule = (line: string) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
  const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  while (i < lines.length) {
    const line = lines[i], key = `b${i}`;
    if (!line.trim()) { i++; continue; }
    const fence = fenceOf(line);
    if (fence) {
      const code: string[] = [];
      for (i++; i < lines.length && !closes(lines[i], fence[1]); i++) code.push(lines[i]);
      i++;
      blocks.push(<pre key={key} className="md-code"><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = headingLine.exec(line);
    if (heading) {
      const Tag = `h${Math.min(heading[1].length + 1, 6)}` as 'h2';
      blocks.push(<Tag key={key} id={anchorOf(heading[2], i)}>{inline(heading[2], resolve, key)}</Tag>);
      i++; continue;
    }
    if (isRule(line)) { blocks.push(<hr key={key}/>); i++; continue; }
    if (hiddenLine.test(line.trim())) { blocks.push(<p key={key} className="md-hidden">{line.trim()}</p>); i++; continue; }
    if (isTable(i)) {
      const head = splitRow(line), rows: string[][] = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(splitRow(lines[i]));
      blocks.push(<div key={key} className="md-table"><table><thead><tr>{head.map((cell, c) => <th key={c}>{inline(cell, resolve, `${key}h${c}`)}</th>)}</tr></thead>
        <tbody>{rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{inline(cell, resolve, `${key}${r}-${c}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      const callout = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(quote[0] ?? '');
      blocks.push(<blockquote key={key} className={callout ? 'md-callout' : undefined}>
        {callout && <strong>{callout[2] || callout[1]}</strong>}
        {(callout ? quote.slice(1) : quote).map((text, q) => <p key={q}>{inline(text, resolve, `${key}q${q}`)}</p>)}
      </blockquote>);
      continue;
    }
    if (item.test(line)) {
      // Each item keeps the marker written in the note, so numbering and nesting read as in Obsidian.
      const entries: ReactNode[] = [];
      for (; i < lines.length && item.test(lines[i]); i++) {
        const [, indent, marker, text] = item.exec(lines[i])!;
        const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
        entries.push(<li key={i} style={{ marginLeft: `${Math.min(indent.replace(/\t/g, '  ').length, 12) * 0.6}em` }}>
          <span className="md-marker" aria-hidden={!task}>{task ? (task[1] === ' ' ? '☐' : '☑') : /\d/.test(marker) ? marker : '•'}</span>
          {task && <span className="md-sr">{task[1] === ' ' ? 'Pendiente: ' : 'Hecho: '}</span>}
          <span>{inline(task ? task[2] : text, resolve, `${key}l${i}`)}</span>
        </li>);
      }
      blocks.push(<ul key={key} className="md-list">{entries}</ul>);
      continue;
    }
    const paragraph: string[] = [];
    for (; i < lines.length && lines[i].trim() && !isRule(lines[i]) && !fenceOf(lines[i]) && !/^\s*(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i]) && !hiddenLine.test(lines[i].trim()); i++) paragraph.push(lines[i]);
    if (!paragraph.length) paragraph.push(lines[i++]);
    blocks.push(<p key={key}>{paragraph.map((text, p) => <Fragment key={p}>{p > 0 && <br/>}{inline(text, resolve, `${key}p${p}`)}</Fragment>)}</p>);
  }
  return <div className="markdown">
    {props.length > 0 && <dl className="md-props">{props.map(([name, value], index) => <Fragment key={index}><dt>{name}</dt><dd>{value || '—'}</dd></Fragment>)}</dl>}
    {blocks}
  </div>;
}
