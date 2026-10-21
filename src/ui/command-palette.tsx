import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { fold } from './fold';
import './command-palette.css';

export type Command = { id: string; label: string; group: string; keywords?: string; run: () => void };

export const paletteShortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

/** ⌘K / Ctrl+K: every place and action of the app, filtered as you type and run with Enter. */
export function CommandPalette({ commands, open, onOpen }: { commands: Command[]; open: boolean; onOpen: Dispatch<SetStateAction<boolean>> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // Closes made here; their «close» events arrive later and must not be mistaken for an Esc.
  const ownCloses = useRef(0);
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'k') return;
      // Toggled from the latest state, even if the last change has not re-rendered yet.
      event.preventDefault(); onOpen(previous => !previous);
    };
    window.addEventListener('keydown', toggle);
    return () => window.removeEventListener('keydown', toggle);
  }, [onOpen]);
  // A native modal dialog traps the focus and makes the rest inert. Opened as soon as the DOM updates,
  // so the first keys typed after ⌘K already reach the field.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) { setQuery(''); setActive(0); element.showModal(); }
    else if (!open && element.open) { ownCloses.current += 1; element.close(); }
  }, [open]);
  const words = fold(query).split(/\s+/).filter(Boolean);
  const matches = commands.filter(command => { const text = fold(`${command.label} ${command.group} ${command.keywords ?? ''}`); return words.every(word => text.includes(word)); }).slice(0, 60);
  const current = Math.min(active, Math.max(matches.length - 1, 0));
  const run = (command?: Command) => { if (!command) return; onOpen(false); command.run(); };
  return <dialog ref={dialog} className="command-palette" aria-label="Paleta de comandos"
    // Esc closes through the state, at once; only a close the browser forces on its own reaches onClose uncounted.
    onCancel={event => { event.preventDefault(); onOpen(false); }}
    onClose={() => { if (ownCloses.current > 0) ownCloses.current -= 1; else onOpen(false); }}
    onClick={event => { if (event.target === event.currentTarget) onOpen(false); }}>
    {open && <>
      <input autoFocus type="search" value={query} placeholder="Ir a un perfil, conversar, entrar, cambiar la luz…" aria-label="Buscar un comando"
        role="combobox" aria-expanded="true" aria-controls="command-list" aria-activedescendant={matches.length ? `command-${current}` : undefined}
        onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const step = event.key === 'ArrowDown' ? 1 : -1; setActive((current + step + matches.length) % Math.max(matches.length, 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); run(matches[current]); }
          // Handled here rather than left to the dialog: Chrome may skip «cancel» right after a quick reopen.
          else if (event.key === 'Escape') { event.preventDefault(); onOpen(false); }
        }}/>
      <ul id="command-list" role="listbox" aria-label="Comandos">
        {matches.map((command, index) => <li key={command.id} id={`command-${index}`} role="option" aria-selected={index === current}
          onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => run(command)}>
          <span>{command.label}</span><small>{command.group}</small>
        </li>)}
      </ul>
      {!matches.length && <p className="command-empty">Nada coincide con «{query.trim()}».</p>}
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> elegir</span><span><kbd>Enter</kbd> ejecutar</span><span><kbd>Esc</kbd> cerrar</span></footer>
    </>}
  </dialog>;
}
