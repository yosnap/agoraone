import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client';
import type { ConversationSummary } from '../api/core';
import { ActionButton } from '../ui/action-button';

const dateTime = (stamp: string) => new Date(stamp).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' });
type Menu = { item: ConversationSummary; trigger: HTMLButtonElement; x: number; y: number };

export function ConversationList({ items, current, discreet, answering, onOpen, onDelete, onDeletedFocus }: {
  items: ConversationSummary[]; current: number | null; discreet: boolean; answering: number | null;
  onOpen: (id: number) => void; onDelete: (item: ConversationSummary) => Promise<void>; onDeletedFocus: () => void;
}) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [confirming, setConfirming] = useState<Menu | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const popup = menuRef.current;
    if (!menu || !popup) return;
    popup.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - popup.offsetHeight - 8))}px`;
    popup.querySelector('button')?.focus();
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !menu.trigger.contains(event.target)) setMenu(null);
    };
    const close = () => setMenu(null);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  useLayoutEffect(() => {
    if (!confirming) return;
    dialog.current?.showModal();
    cancel.current?.focus();
  }, [confirming]);

  function showMenu(item: ConversationSummary, trigger: HTMLButtonElement, at?: { x: number; y: number }) {
    const box = trigger.getBoundingClientRect();
    setMenu({ item, trigger, x: at?.x ?? box.left, y: at?.y ?? box.bottom + 4 });
  }

  function closeConfirm(deleted = false) {
    dialog.current?.close();
    setConfirming(null);
    setError('');
    setStale(false);
    if (!deleted && confirming?.trigger.isConnected) confirming.trigger.focus();
    else onDeletedFocus();
  }

  async function remove() {
    if (!confirming || saving || stale || confirming.item.id === answering) return;
    setSaving(true);
    setError('');
    try {
      await onDelete(confirming.item);
      closeConfirm(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'No se pudo eliminar la conversación.');
      setStale(failure instanceof ApiError && (failure.status === 404 || failure.data?.code === 'stale_conversation'));
    } finally { setSaving(false); }
  }

  const occupied = confirming !== null && confirming.item.id === answering;
  return <>
    {!items.length ? <p className="muted">Aún no hay conversaciones.</p> : <ul>{items.map(item => {
      const expanded = menu?.item.id === item.id;
      const label = discreet ? dateTime(item.updated_at) : item.title;
      return <li className="assistant-conversation" key={`${item.id}/${item.created_at}`} onContextMenu={event => {
        event.preventDefault();
        const trigger = event.currentTarget.querySelector<HTMLButtonElement>('.assistant-conversation-more');
        if (trigger) showMenu(item, trigger, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
      }} onKeyDown={event => {
        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
        event.preventDefault();
        const trigger = event.currentTarget.querySelector<HTMLButtonElement>('.assistant-conversation-more');
        if (trigger) showMenu(item, trigger);
      }}>
        <button type="button" className="assistant-conversation-open" aria-current={item.id === current ? 'true' : undefined} onClick={() => onOpen(item.id)}>
          <strong>{item.title}</strong><small>{dateTime(item.updated_at)}</small>
        </button>
        <button type="button" className="assistant-conversation-more" aria-label={`Acciones de la conversación ${label}`}
          aria-haspopup="menu" aria-expanded={expanded} onClick={event => expanded ? setMenu(null) : showMenu(item, event.currentTarget)}>⋯</button>
      </li>;
    })}</ul>}
    {menu && createPortal(<div ref={menuRef} className="assistant-conversation-menu" role="menu" aria-label="Acciones de la conversación"
      onKeyDown={event => {
        if (event.key !== 'Escape' && event.key !== 'Tab') return;
        if (event.key === 'Escape') event.preventDefault();
        menu.trigger.focus();
        setMenu(null);
      }}>
      <ActionButton icon="trash" label="Eliminar conversación" role="menuitem" onClick={() => { setConfirming(menu); setMenu(null); }}/>
    </div>, document.body)}
    {confirming && <dialog ref={dialog} className="assistant-conversation-confirm" aria-labelledby="assistant-conversation-delete-title"
      onCancel={event => { event.preventDefault(); if (!saving) closeConfirm(); }}>
      <h2 id="assistant-conversation-delete-title">¿Eliminar conversación?</h2>
      <p>{discreet ? dateTime(confirming.item.updated_at) : `«${confirming.item.title}»`}</p>
      <p>Se eliminarán la conversación y sus mensajes del historial local.</p>
      {occupied && <p role="status">Espera a que termine la respuesta o detenla desde la conversación.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button ref={cancel} type="button" className="button" disabled={saving} onClick={() => closeConfirm()}>Cancelar</button>
        <ActionButton icon="trash" label="Eliminar de verdad" disabled={saving || stale || occupied} busyLabel={saving && 'Eliminando…'} onClick={() => void remove()}/>
      </div>
    </dialog>}
  </>;
}
