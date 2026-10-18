import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';

// Live preview for Markdown, like Obsidian's: the text stays exactly as written (this only decorates it),
// marks such as #, ** or [[ ]] are hidden except on the lines the cursor is on, and the rest is shown
// formatted. Nothing here changes the document except ticking a checkbox, which edits its «[ ]».

class Bullet extends WidgetType {
  toDOM() { const span = document.createElement('span'); span.className = 'cm-md-bullet'; span.textContent = '•'; return span; }
}

class Checkbox extends WidgetType {
  constructor(readonly checked: boolean, readonly at: number, readonly editable: boolean) { super(); }
  eq(other: Checkbox) { return other.checked === this.checked && other.at === this.at && other.editable === this.editable; }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = this.checked; box.className = 'cm-md-checkbox';
    box.setAttribute('aria-label', this.checked ? 'Tarea hecha' : 'Tarea pendiente');
    // Read-only while the editor is; click also fires for the space bar, so it works from the keyboard.
    box.disabled = !this.editable;
    box.addEventListener('mousedown', event => event.preventDefault());
    box.addEventListener('click', event => {
      event.preventDefault();
      if (!view.state.facet(EditorView.editable)) return;
      view.dispatch({ changes: { from: this.at + 1, to: this.at + 2, insert: this.checked ? ' ' : 'x' } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

class Rule extends WidgetType {
  toDOM() { const hr = document.createElement('span'); hr.className = 'cm-md-rule'; return hr; }
}

const hide = Decoration.replace({});
const marks = {
  strong: Decoration.mark({ class: 'cm-md-strong' }), em: Decoration.mark({ class: 'cm-md-em' }),
  strike: Decoration.mark({ class: 'cm-md-strike' }), code: Decoration.mark({ class: 'cm-md-code' }),
  link: Decoration.mark({ class: 'cm-md-link' }), wiki: Decoration.mark({ class: 'cm-md-wikilink' }),
  tag: Decoration.mark({ class: 'cm-md-tag' }), highlight: Decoration.mark({ class: 'cm-md-highlight' }),
};

/** Lines touched by any selection: their marks stay visible so they can be edited. */
function activeLines(state: EditorState) {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let line = state.doc.lineAt(range.from).number; line <= state.doc.lineAt(range.to).number; line++) lines.add(line);
  }
  return lines;
}

function frontmatterEnd(state: EditorState) {
  if (state.doc.lines < 2 || state.doc.line(1).text.trim() !== '---') return 0;
  for (let n = 2; n <= Math.min(state.doc.lines, 200); n++) if (state.doc.line(n).text.trim() === '---') return n;
  return 0;
}

function build(view: EditorView): DecorationSet {
  const { state } = view, active = activeLines(state), ranges: Range<Decoration>[] = [];
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number);
  const front = frontmatterEnd(state);
  // A plugin may only hide text within one line (CodeMirror refuses line breaks), so every hidden span is checked.
  const hideIn = (start: number, end: number) => { if (end > start && state.doc.lineAt(start).to >= end) ranges.push(hide.range(start, end)); };
  const replaceIn = (start: number, end: number, widget: WidgetType) => { if (end > start && state.doc.lineAt(start).to >= end) ranges.push(Decoration.replace({ widget }).range(start, end)); };
  const code: [number, number][] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter: node => {
        const name = node.name;
        // Frontmatter is shown as properties, not parsed as Markdown (its closing --- is no heading underline).
        if (front && state.doc.lineAt(node.from).number <= front && name !== 'Document') return false;
        if (['FencedCode', 'CodeBlock', 'InlineCode'].includes(name)) code.push([node.from, node.to]);
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) { ranges.push(Decoration.line({ class: `cm-md-h${heading[1]}` }).range(state.doc.lineAt(node.from).from)); return; }
        if (name === 'HeaderMark' && !isActive(node.from)) {
          const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          hideIn(node.from, after);
          return;
        }
        if (name === 'StrongEmphasis') ranges.push(marks.strong.range(node.from, node.to));
        if (name === 'Emphasis') ranges.push(marks.em.range(node.from, node.to));
        if (name === 'Strikethrough') ranges.push(marks.strike.range(node.from, node.to));
        if (name === 'InlineCode') ranges.push(marks.code.range(node.from, node.to));
        if (['EmphasisMark', 'StrikethroughMark'].includes(name) && !isActive(node.from)) hideIn(node.from, node.to);
        if (name === 'CodeMark' && node.node.parent?.name === 'InlineCode' && !isActive(node.from)) hideIn(node.from, node.to);
        if (name === 'Link') {
          // Only real links ([text](url)); a bare [text], like «[línea oculta 1]», stays as written.
          if (!node.node.getChild('URL')) return false;
          const text = node.node.getChildren('LinkMark');
          if (text.length >= 2) ranges.push(marks.link.range(text[0].to, text[1].from));
          if (!isActive(node.from) && text.length >= 2) { hideIn(node.from, text[0].to); hideIn(text[1].from, node.to); }
          return false;
        }
        if (name === 'ListMark' && !isActive(node.from)) {
          const marker = state.doc.sliceString(node.from, node.to);
          const task = node.node.parent?.getChild('Task');
          if (!task && /^[-*+]$/.test(marker)) replaceIn(node.from, node.to, new Bullet());
          if (task) hideIn(node.from, Math.min(node.to + 1, task.from));
          return;
        }
        if (name === 'TaskMarker' && !isActive(node.from)) {
          const checked = /x/i.test(state.doc.sliceString(node.from, node.to));
          replaceIn(node.from, node.to, new Checkbox(checked, node.from, state.facet(EditorView.editable)));
          return;
        }
        if (name === 'Blockquote') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            const callout = /^\s*>\s*\[!\w+\]/.test(line.text);
            ranges.push(Decoration.line({ class: callout ? 'cm-md-quote cm-md-callout' : 'cm-md-quote' }).range(line.from));
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
        }
        if (name === 'QuoteMark' && !isActive(node.from)) {
          const after = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
          hideIn(node.from, after);
          return;
        }
        if (name === 'HorizontalRule' && !isActive(node.from) && state.doc.lineAt(node.from).number > front) {
          replaceIn(node.from, node.to, new Rule());
          return;
        }
        if (name === 'FencedCode') {
          for (let pos = node.from; pos <= node.to;) {
            const line = state.doc.lineAt(pos);
            ranges.push(Decoration.line({ class: 'cm-md-codeblock' }).range(line.from));
            if (line.to >= node.to) break;
            pos = line.to + 1;
          }
          code.push([node.from, node.to]);
          return false;
        }
      },
    });
    const inCode = (start: number, end: number) => code.some(([a, b]) => start < b && end > a);
    // Obsidian syntax the Markdown grammar does not know: [[wikilinks]], ==highlights== and #tags.
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos), text = line.text, open = active.has(line.number);
      if (line.number <= front) ranges.push(Decoration.line({ class: 'cm-md-front' }).range(line.from));
      else if (/^\s*\[línea oculta \d+\]\s*$/.test(text)) ranges.push(Decoration.line({ class: 'cm-md-hidden' }).range(line.from));
      else if (!/^\s*(```|~~~)/.test(text)) {
        for (const match of text.matchAll(/(!?)\[\[([^\]\n]{1,500})\]\]/g)) {
          const start = line.from + match.index!, end = start + match[0].length, inner = match[2], bar = inner.indexOf('|');
          if (inCode(start, end)) continue;
          ranges.push(marks.wiki.range(start, end));
          if (!open) {
            hideIn(start, start + 2 + match[1].length + (bar >= 0 ? bar + 1 : 0));
            hideIn(end - 2, end);
          }
        }
        for (const match of text.matchAll(/==([^=\n]{1,500})==/g)) {
          const start = line.from + match.index!, end = start + match[0].length;
          if (inCode(start, end)) continue;
          ranges.push(marks.highlight.range(start, end));
          if (!open) { hideIn(start, start + 2); hideIn(end - 2, end); }
        }
        for (const match of text.matchAll(/(^|\s)(#[\p{L}\p{N}_/-]+)/gu)) {
          if (/^\s*#{1,6}\s/.test(text) && match.index === 0) continue;
          const start = line.from + match.index! + match[1].length;
          if (inCode(start, start + match[2].length)) continue;
          ranges.push(marks.tag.range(start, start + match[2].length));
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

export const livePreview = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || syntaxTree(update.startState) !== syntaxTree(update.state)
      || update.startState.facet(EditorView.editable) !== update.state.facet(EditorView.editable))
      this.decorations = build(update.view);
  }
}, { decorations: plugin => plugin.decorations });
