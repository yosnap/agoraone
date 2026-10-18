import { useEffect, useRef } from 'react';
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder as hint } from '@codemirror/view';
import { livePreview } from './markdown-live';
import './markdown-editor.css';

// A visual Markdown editor with live preview, like Obsidian's (user's decision, 18/10/2026): it edits the
// text itself, so the file is saved exactly as written; formatting is only shown, never rewritten.

/** Wraps the selection (or inserts an empty pair at the cursor) with a mark such as ** or [[ ]]. */
function wrap(view: EditorView, before: string, after = before) {
  view.dispatch(view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    const wrapped = text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length;
    const insert = wrapped ? text.slice(before.length, text.length - after.length) : `${before}${text}${after}`;
    const anchor = range.empty ? range.from + before.length : range.from;
    return { changes: { from: range.from, to: range.to, insert }, range: range.empty ? EditorSelection.cursor(anchor) : EditorSelection.range(range.from, range.from + insert.length) };
  }));
  view.focus();
  return true;
}

/** Sets (or removes, when already set) a line prefix such as «## », «- » or «> » on every selected line. */
function prefix(view: EditorView, mark: string, strip: RegExp) {
  const { state } = view, changes = [];
  const lines = new Set<number>();
  for (const range of state.selection.ranges)
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) lines.add(n);
  for (const n of lines) {
    const line = state.doc.line(n), current = strip.exec(line.text);
    const has = current?.[0] === mark;
    changes.push({ from: line.from, to: line.from + (current?.[0].length ?? 0), insert: has ? '' : mark });
  }
  view.dispatch({ changes });
  view.focus();
  return true;
}

const external = Annotation.define<boolean>();
const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
const heading = /^#{1,6} /, listMark = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )/;
const actions: { label: string; title: string; run: (view: EditorView) => boolean }[] = [
  { label: 'B', title: `Negrita (${mod}B)`, run: view => wrap(view, '**') },
  { label: 'I', title: `Cursiva (${mod}I)`, run: view => wrap(view, '*') },
  { label: 'S', title: 'Tachado', run: view => wrap(view, '~~') },
  { label: 'H1', title: 'Encabezado 1', run: view => prefix(view, '# ', heading) },
  { label: 'H2', title: 'Encabezado 2', run: view => prefix(view, '## ', heading) },
  { label: 'H3', title: 'Encabezado 3', run: view => prefix(view, '### ', heading) },
  { label: '•', title: 'Lista', run: view => prefix(view, '- ', listMark) },
  { label: '1.', title: 'Lista numerada', run: view => prefix(view, '1. ', listMark) },
  { label: '☐', title: 'Tarea', run: view => prefix(view, '- [ ] ', listMark) },
  { label: '[[ ]]', title: 'Enlace a otra nota', run: view => wrap(view, '[[', ']]') },
  { label: '🔗', title: `Enlace web (${mod}K)`, run: view => wrap(view, '[', '](https://)') },
  { label: '❝', title: 'Cita o aviso', run: view => prefix(view, '> ', /^> /) },
  { label: '</>', title: 'Código', run: view => wrap(view, '`') },
];

export default function MarkdownEditor({ value, onChange, label, notes = [], minHeight = 160, disabled = false, autoFocus = false, placeholder }: {
  value: string; onChange: (value: string) => void; label: string; notes?: string[]; minHeight?: number; disabled?: boolean; autoFocus?: boolean; placeholder?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editable = useRef(new Compartment());
  const latest = useRef({ onChange, notes });
  latest.current = { onChange, notes };
  // The last text this editor sent out: a «value» equal to it is our own typing coming back, not a reload.
  const emitted = useRef(value);
  // The editor lives as long as this component; its text is pushed out on every change.
  useEffect(() => {
    // «[[» suggests the titles of the vault's notes.
    const wikilinks = (context: CompletionContext) => {
      const match = context.matchBefore(/\[\[[^\]\n]*$/);
      if (!match || !latest.current.notes.length) return null;
      // Filtered here, over every title, so a large vault still finds its later notes.
      const typed = match.text.slice(2).toLocaleLowerCase('es');
      const closed = context.state.sliceDoc(context.pos, context.pos + 2) === ']]';
      const options = latest.current.notes.filter(title => title.toLocaleLowerCase('es').includes(typed)).slice(0, 200)
        .map(title => ({ label: title, apply: closed ? title : `${title}]]` }));
      return { from: match.from + 2, options, filter: false };
    };
    const created = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(), markdown({ base: markdownLanguage }), livePreview, EditorView.lineWrapping,
          autocompletion({ override: [wikilinks], icons: false }),
          keymap.of([
            { key: 'Mod-b', run: view => wrap(view, '**') }, { key: 'Mod-i', run: view => wrap(view, '*') },
            { key: 'Mod-k', run: view => wrap(view, '[', '](https://)') },
            ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', role: 'textbox', spellcheck: 'true', lang: 'es' }),
          editable.current.of(EditorView.editable.of(!disabled)),
          ...(placeholder ? [hint(placeholder)] : []),
          EditorView.updateListener.of(update => {
            if (!update.docChanged || update.transactions.some(tr => tr.annotation(external))) return;
            emitted.current = update.state.doc.toString();
            latest.current.onChange(emitted.current);
          }),
        ],
      }),
    });
    view.current = created;
    if (autoFocus) created.focus();
    return () => { created.destroy(); view.current = null; };
  }, []); // created once: value and disabled are synced by the effects below
  // A new value from outside (a reload) replaces the text; the user's own typing already matches it.
  // A reload from outside replaces the text without echoing it back, keeping the cursor where it can be.
  // CodeMirror stores line breaks as \n, so a CRLF text that only differs in them is not a change.
  useEffect(() => {
    const current = view.current;
    if (!current || value === emitted.current || current.state.doc.toString() === value.replace(/\r\n?/g, '\n')) return;
    emitted.current = value;
    const head = Math.min(current.state.selection.main.head, value.length);
    current.dispatch({ changes: { from: 0, to: current.state.doc.length, insert: value }, selection: { anchor: head }, annotations: external.of(true) });
  }, [value]);
  useEffect(() => {
    view.current?.dispatch({ effects: [editable.current.reconfigure(EditorView.editable.of(!disabled))] });
    view.current?.contentDOM.setAttribute('aria-readonly', String(disabled));
  }, [disabled]);
  return <div className="md-editor" style={{ ['--md-min' as string]: `${minHeight}px` }}>
    <div className="md-toolbar" role="toolbar" aria-label="Barra de formato">
      {actions.map(action => <button key={action.title} type="button" title={action.title} aria-label={action.title} disabled={disabled}
        onMouseDown={event => event.preventDefault()} onClick={() => view.current && action.run(view.current)}>{action.label}</button>)}
    </div>
    <div ref={host} className="md-surface"/>
  </div>;
}
