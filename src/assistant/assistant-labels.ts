export const engineLabels: Record<string, string> = {
  'claude-code': 'Claude Code (tu sesión)', 'anthropic-api': 'API de Anthropic', compatible: 'Proveedor compatible',
};
export const modelLabels: Record<string, string> = { sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
export const stageLabels = { recuerda: 'Recordando en tu cerebro…', piensa: 'Pensando…', responde: 'Respondiendo…' } as const;

export const engineName = (engine?: string | null) => (engine && engineLabels[engine]) || engine || 'motor desconocido';
export const modelName = (model?: string | null) => (model && modelLabels[model]) || model || '';
