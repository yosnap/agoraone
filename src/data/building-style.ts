export type BuildingStyle = 'library' | 'observatory' | 'workshop' | 'pavilion' | 'garden' | 'tower' | 'archive' | 'vault' | 'service';
export const styleLabels: Record<BuildingStyle, string> = {
  library: 'Biblioteca', observatory: 'Observatorio', workshop: 'Taller', pavilion: 'Pabellón',
  garden: 'Invernadero', tower: 'Torre', archive: 'Archivo',
  vault: 'Archivo Obsidian', service: 'Terminal de servicio',
};
const variants: BuildingStyle[] = ['observatory', 'workshop', 'pavilion', 'garden', 'tower', 'archive'];

// Local visual heuristic only: never changes identity, permissions or capabilities.
export function profileStyle(name: string, description: string, used: Set<BuildingStyle>): BuildingStyle {
  const text = `${name} ${description}`.toLowerCase();
  const preferred: BuildingStyle = name === 'default' ? 'observatory'
    : /code|desarrollo|program|software/.test(text) ? 'workshop'
    : /event|hackathon|comunidad/.test(text) ? 'pavilion'
    : /life|vida|salud|bienestar|cocina|receta/.test(text) ? 'garden'
    : /\bpro\b|negocio|empresa|business|trabajo/.test(text) ? 'tower'
    : /archivo|document|memory|memoria/.test(text) ? 'archive'
    : variants[Array.from(name).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0) % variants.length];
  const style = !used.has(preferred) ? preferred : variants.find(item => !used.has(item)) || preferred;
  used.add(style);
  return style;
}
