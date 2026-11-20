import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './modern-select.css';

export type ModernSelectOption = { value: string; label: string; render?: ReactNode };

// The select of the whole application (user's decision, 20/10/2026: no native selects): options are
// buttons that may carry colours, indents and dots, and the control stays keyboard driven
// (arrows, Enter to pick, Escape to close). Outside clicks close it. A pick cancels the click's default
// action: inside a <label> the browser would otherwise forward it to the trigger and reopen the list.
// The list is drawn over the whole window (a portal in <body>, or in the open <dialog> that holds the select so it
// stays in the top layer, fixed where the button is): a panel with its own
// scroll or a short card never clips it. Scrolling or resizing anything but the list itself closes it.
export function ModernSelect({ id, value, onChange, options, disabled = false }: {
  id?: string; value: string; onChange: (value: string) => void; options: ModernSelectOption[]; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // Below the button, or above it when the list would not fit below (a select at the foot of the screen).
  const [place, setPlace] = useState<CSSProperties>({});
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(root.current?.contains(target) || list.current?.contains(target));
    const close = (event: Event) => { if (!inside(event.target)) setOpen(false); };
    const shut = () => setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', shut);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('scroll', close, true); window.removeEventListener('resize', shut); };
  }, [open]);
  const openFrom = () => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const wanted = Math.min(320, options.length * 38 + 8);
    const upward = below < wanted && above > below;
    const room = Math.max(120, Math.min(320, upward ? above : below));
    setPlace({ left: box.left, width: box.width, maxHeight: room, ...(upward ? { bottom: window.innerHeight - box.top + 4 } : { top: box.bottom + 4 }) });
    setOpen(true); setActive(Math.max(0, options.findIndex(option => option.value === value))); };
  const pick = (index: number) => { const option = options[index]; if (!option) return; onChange(option.value); setOpen(false); };
  const onKey = (event: KeyboardEvent) => {
    if (disabled) return;
    if (!open) { if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') { event.preventDefault(); openFrom(); } return; }
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(options.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); pick(active); }
  };
  return <div className="modern-select" ref={root}>
    <button type="button" id={id} className="modern-select-button" aria-haspopup="listbox" aria-expanded={open} disabled={disabled}
      onClick={() => (open ? setOpen(false) : openFrom())} onKeyDown={onKey}>
      <span className="modern-select-current">{current?.label ?? '—'}</span><span aria-hidden="true">▾</span>
    </button>
    {open && createPortal(<div ref={list} className="modern-select-list" style={place} role="listbox" aria-label={id}>
      {options.map((option, index) => <button type="button" key={option.value} role="option"
        aria-selected={option.value === value} className={index === active ? 'modern-select-active' : ''}
        onMouseEnter={() => setActive(index)} onClick={event => { event.preventDefault(); pick(index); }}>{option.render ?? option.label}</button>)}
    </div>, root.current?.closest('dialog') ?? document.body)}
  </div>;
}
