import { useState } from 'react';
import { applyAppearance, palettes, readAppearance, sizes, typefaces, type Appearance, type Palette, type Size, type Typeface } from '../shell/appearance';
import { applyTheme, readTheme, type ThemeChoice } from '../shell/theme';
import { ModernSelect } from '../ui/modern-select';
import { hereLabel } from '../ui/platform';

const themes: { value: ThemeChoice; label: string }[] = [{ value: 'system', label: 'Del sistema' }, { value: 'light', label: 'Claro' }, { value: 'dark', label: 'Oscuro' }];

/** Appearance: theme, a preset colour palette, the size of the interface and its typeface. Per browser. */
export function AppearanceCard() {
  const [theme, setTheme] = useState(readTheme);
  const [appearance, setAppearance] = useState<Appearance>(readAppearance);
  const change = (next: Partial<Appearance>) => { const value = { ...appearance, ...next }; applyAppearance(value); setAppearance(value); };
  return <article className="card appearance" aria-labelledby="appearance-title">
    <h2 id="appearance-title">Apariencia</h2>
    <div className="appearance-row"><span className="field-label">Tema</span>
      <div className="segmented" role="group" aria-label="Tema">{themes.map(item =>
        <button key={item.value} aria-pressed={theme === item.value} onClick={() => { applyTheme(item.value); setTheme(item.value); change({}); }}>{item.label}</button>)}</div></div>
    <div className="appearance-row"><span className="field-label">Colores</span>
      <div className="palette-list" role="radiogroup" aria-label="Paleta de colores">{(Object.keys(palettes) as Palette[]).map(id =>
        <button key={id} role="radio" aria-checked={appearance.palette === id} className="palette-option" onClick={() => change({ palette: id })}>
          <span className="palette-swatch" aria-hidden="true">{palettes[id].swatch.map(color => <i key={color} style={{ background: color }}/>)}</span>
          {palettes[id].label}
        </button>)}</div></div>
    <div className="appearance-row"><span className="field-label">Tamaño</span>
      <div className="segmented" role="group" aria-label="Tamaño de la interfaz">{(Object.keys(sizes) as Size[]).map(id =>
        <button key={id} aria-pressed={appearance.size === id} onClick={() => change({ size: id })}>{sizes[id].label}</button>)}</div></div>
    <label className="field appearance-font">Tipo de letra<ModernSelect value={appearance.typeface} onChange={value => change({ typeface: value as Typeface })}
      options={(Object.keys(typefaces) as Typeface[]).map(id => ({ value: id, label: typefaces[id].label,
        render: <span style={{ fontFamily: typefaces[id].stack ?? "'DM Sans', sans-serif" }}>{typefaces[id].label}</span> }))}/></label>
    <p className="muted">Se guarda en {hereLabel}. Los avisos, errores y estados conservan sus colores en todas las paletas.</p>
  </article>;
}
