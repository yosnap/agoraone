// Small marks to tell accounts and folders apart at a glance (decorative: the name is always written next to them).
import type { FolderKind, MailProvider } from '../api/core';

const box = { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': true, focusable: false } as const;

export function ProviderLogo({ provider }: { provider: MailProvider }) {
  if (provider === 'gmail') return <svg {...box}>
    <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.3z"/>
    <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.5l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z"/>
    <path fill="#FBBC05" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.5H3.1a10 10 0 0 0 0 9z"/>
    <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.5l3.3 2.6C7.2 7.8 9.4 6 12 6z"/>
  </svg>;
  if (provider === 'microsoft') return <svg {...box}>
    <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022"/><rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00"/>
    <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF"/><rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900"/>
  </svg>;
  if (provider === 'icloud') return <svg {...box}>
    <path fill="#3693F3" d="M18.5 19H7a5 5 0 0 1-.6-10A6.5 6.5 0 0 1 18.8 9.2 4.9 4.9 0 0 1 18.5 19z"/>
  </svg>;
  return <svg {...box}><rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6"/>
    <path d="m3.5 6.5 8.5 6.5 8.5-6.5" fill="none" stroke="currentColor" strokeWidth="1.6"/></svg>;
}

export function FolderLogo({ kind }: { kind: FolderKind }) {
  if (kind === 'empresa') return <svg {...box}><path fill="none" stroke="currentColor" strokeWidth="1.6" d="M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2M2 21h20"/></svg>;
  if (kind === 'personal') return <svg {...box}><path fill="none" stroke="currentColor" strokeWidth="1.6" d="M3 11 12 4l9 7M5 10v10h5v-6h4v6h5V10"/></svg>;
  return <svg {...box}><path fill="none" stroke="currentColor" strokeWidth="1.6" d="M3 8h18v12H3zM9 8V5h6v3M3 13h18"/></svg>;
}
