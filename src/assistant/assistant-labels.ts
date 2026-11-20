export const engineLabels: Record<string, string> = {
  'claude-code': 'Claude Code (tu sesión)', quick: 'una orden rápida, sin modelo', 'anthropic-api': 'API de Anthropic', compatible: 'Proveedor compatible',
};
export const modelLabels: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
export const stageLabels = { recuerda: 'Recordando en tu cerebro…', web: 'Leyendo la página…', piensa: 'Pensando…', responde: 'Respondiendo…' } as const;

export const engineName = (engine?: string | null) => (engine && engineLabels[engine]) || engine || 'motor desconocido';
export const modelName = (model?: string | null) => (model && modelLabels[model]) || model || '';

/** The step a Bandeja lookup leaves in the chat: how many mails and, with WhatsApp on, how many conversations. */
export const inboxStep = (mails: number, chats?: number) =>
  `Consultó la Bandeja · ${mails} ${mails === 1 ? 'correo' : 'correos'}${chats === undefined ? '' : ` y ${chats} WhatsApp`}`;

/** What the core read from the addresses in the message: the sites only, never the full address. */
export const webLabel = (pages: { host: string; ok: boolean }[]) => {
  const read = pages.filter(page => page.ok).map(page => page.host);
  if (!read.length) return pages.length === 1 ? 'No se pudo leer la página' : 'No se pudo leer ninguna página';
  const failed = pages.length - read.length;
  return `Leído: ${read.join(', ')}${failed ? ` · ${failed} sin leer` : ''}`;
};
