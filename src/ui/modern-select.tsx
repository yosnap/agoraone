import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './modern-select.css';

export type ModernSelectOption = { value: string; label: string; render?: ReactNode };

// The select of the whole application (user's decision, 20/10/2026: no native selects): options are
// buttons that may carry colours, indents and dots, and the control stays keyboard driven
// (arrows, Enter to pick, Escape to close). Outside clicks close it.
export function ModernSelect({ id, value, onChange, options, disabled = false }: {
  id?: string; value: string; onChange: (value: string) => void; options: ModernSelectOption[]; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (event.target instanceof Node && root.current && !root.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const openFrom = () => { setOpen(true); setActive(Math.max(0, options.findIndex(option => option.value === value))); };
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
    {open && <div className="modern-select-list" role="listbox" aria-label={id}>
      {options.map((option, index) => <button type="button" key={option.value} role="option"
        aria-selected={option.value === value} className={index === active ? 'modern-select-active' : ''}
        onMouseEnter={() => setActive(index)} onClick={() => pick(index)}>{option.render ?? option.label}</button>)}
    </div>}
  </div>;
}
