import type { SVGProps } from 'react';

/** The icons of the standard actions, drawn inline (no icon package): 24×24 strokes in the text colour. */
export type ActionIconName = 'pause' | 'play' | 'edit' | 'trash' | 'eye' | 'file' | 'external' | 'refresh' | 'plus' | 'save' | 'check'
  | 'send' | 'back' | 'close' | 'archive' | 'download' | 'upload' | 'link' | 'copy' | 'search' | 'filter' | 'mail' | 'settings' | 'power';

const PATHS: Record<ActionIconName, string[]> = {
  pause: ['M8 5v14', 'M16 5v14'],
  play: ['M7 4.5v15l12-7.5z'],
  edit: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6.5 7l1 13h9l1-13', 'M10 11v6', 'M14 11v6'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v6H4V6h6'],
  refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
  plus: ['M12 5v14', 'M5 12h14'],
  save: ['M5 4h11l3 3v13H5z', 'M8 4v5h7V4', 'M8 20v-6h8v6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  send: ['M21 3L10 14', 'M21 3l-7 18-4-7-7-4z'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  archive: ['M3 5h18v4H3z', 'M5 9v11h14V9', 'M10 13h4'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  upload: ['M12 20V9', 'M7 14l5-5 5 5', 'M5 4h14'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4'],
  filter: ['M4 5h16l-6 8v6l-4-2v-4z'],
  mail: ['M3 6h18v12H3z', 'M3 7l9 6 9-6'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12l2-1-1-3-2.2.2-1.4-1.4L16.6 5 13.6 4 12.6 6h-1.2l-1-2-3 1 .2 2.2-1.4 1.4L4 8.4l-1 3 2 1v1.2l-2 1 1 3 2.2-.2 1.4 1.4-.2 2.2 3 1 1-2h1.2l1 2 3-1-.2-2.2 1.4-1.4 2.2.2 1-3-2-1z'],
  power: ['M12 3v9', 'M6.3 6.3a8 8 0 1 0 11.4 0'],
};

/** One action icon; decorative (hidden from screen readers), the button around it carries the name. */
export function ActionIcon({ name, size = 15, ...rest }: { name: ActionIconName; size?: number } & SVGProps<SVGSVGElement>) {
  return <svg className="action-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
    {PATHS[name].map(d => <path key={d} d={d} fill={name === 'play' ? 'currentColor' : undefined}/>)}
  </svg>;
}
