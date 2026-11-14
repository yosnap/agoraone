// Appearance beyond light and dark: a colour palette, the size of the interface and its typeface, all
// chosen from presets and remembered per browser (like the theme). Palettes are derived from the colour
// tokens of src/theme-tokens.css: the green and teal brand colours change hue or lose their colour, while
// reds, ambers and yellows keep theirs, so warnings and errors always look like warnings and errors.

export type Palette = 'natural' | 'grafito' | 'oceano' | 'ciruela' | 'arena' | 'bosque';
export type Size = 'small' | 'normal' | 'large' | 'larger';
export type Typeface = 'original' | 'system' | 'avenir' | 'helvetica' | 'serif' | 'rounded';
export type Appearance = { palette: Palette; size: Size; typeface: Typeface };

export const palettes: Record<Palette, { label: string; hue?: number; saturation?: number; swatch: string[] }> = {
  natural: { label: 'Natural', swatch: ['#173d3c', '#244e42', '#dcebdc', '#fbfaf3'] },
  grafito: { label: 'Grafito', saturation: 0.06, swatch: ['#2f3436', '#454b4e', '#e2e4e5', '#f7f7f6'] },
  oceano: { label: 'Océano', hue: 212, swatch: ['#173352', '#24486e', '#dce6f2', '#f6f8fb'] },
  ciruela: { label: 'Ciruela', hue: 282, swatch: ['#35204a', '#4b2f66', '#e8dcf2', '#faf7fb'] },
  arena: { label: 'Arena', hue: 32, saturation: 0.7, swatch: ['#4a3420', '#6b4b2c', '#f1e6d6', '#fbf8f2'] },
  bosque: { label: 'Bosque', hue: 128, swatch: ['#1c3d22', '#2c5432', '#dcefdc', '#f7faf5'] },
};
export const sizes: Record<Size, { label: string; zoom: number }> = {
  small: { label: 'Pequeño', zoom: 0.9 }, normal: { label: 'Normal', zoom: 1 }, large: { label: 'Grande', zoom: 1.12 }, larger: { label: 'Muy grande', zoom: 1.25 },
};
// Typefaces already on every Mac: nothing is downloaded.
export const typefaces: Record<Typeface, { label: string; stack: string | null }> = {
  original: { label: 'Original (DM Sans y Manrope)', stack: null },
  system: { label: 'Sistema (SF Pro)', stack: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif" },
  avenir: { label: 'Avenir Next', stack: "'Avenir Next', Avenir, sans-serif" },
  helvetica: { label: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  serif: { label: 'New York (con remates)', stack: "ui-serif, 'New York', Georgia, serif" },
  rounded: { label: 'SF Rounded', stack: "ui-rounded, 'SF Pro Rounded', -apple-system, sans-serif" },
};

const key = 'agora-appearance';
const defaults: Appearance = { palette: 'natural', size: 'normal', typeface: 'original' };

export function readAppearance(): Appearance {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '{}');
    return {
      palette: value.palette in palettes ? value.palette : defaults.palette,
      size: value.size in sizes ? value.size : defaults.size,
      typeface: value.typeface in typefaces ? value.typeface : defaults.typeface,
    };
  } catch { return defaults; }
}

function hsl(hex: string): [number, number, number, string] | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!match) return null;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l, match[2] ?? ''];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l, match[2] ?? ''];
}

function hex(h: number, s: number, l: number, alpha: string) {
  const f = (n: number) => { const k = (n + h / 30) % 12; const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return `#${f(0)}${f(8)}${f(4)}${alpha}`;
}

/** A token's colour in a palette: only the brand's greens and teals (hue 70–260) are changed. */
export function shade(value: string, palette: Palette): string {
  const spec = palettes[palette];
  const parsed = hsl(value);
  if (!parsed || palette === 'natural') return value;
  const [h, s, l, alpha] = parsed;
  if (s < 0.04 || h < 70 || h > 260) return value;
  return hex(spec.hue ?? h, s * (spec.saturation ?? 1), l, alpha);
}

function paletteCss(palette: Palette): string {
  if (palette === 'natural') return '';
  const out: string[] = [];
  const walk = (rules: CSSRuleList, wrap: (body: string) => string) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) walk(rule.cssRules, body => wrap(`@media ${rule.conditionText} { ${body} }`));
      else if (rule instanceof CSSStyleRule) {
        // --c-*: the colour tokens; --deep*: the dark surfaces (side rail, code, the ask box).
        const declarations = Array.from(rule.style).filter(name => name.startsWith('--c-') || name.startsWith('--deep'))
          .map(name => `${name}: ${shade(rule.style.getPropertyValue(name), palette)};`);
        if (declarations.length) out.push(wrap(`${rule.selectorText} { ${declarations.join(' ')} }`));
      }
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    if ((sheet.ownerNode as Element | null)?.id === 'agora-appearance') continue;  // never derive from itself
    try { walk(sheet.cssRules, body => body); } catch { /* a sheet from elsewhere cannot be read */ }
  }
  return out.join('\n');
}

export function applyAppearance(appearance: Appearance) {
  const root = document.documentElement;
  root.style.setProperty('--ui-zoom', String(sizes[appearance.size].zoom));
  const stack = typefaces[appearance.typeface].stack;
  let style = document.getElementById('agora-appearance');
  if (!style) { style = document.createElement('style'); style.id = 'agora-appearance'; document.head.appendChild(style); }
  style.textContent = paletteCss(appearance.palette)
    + (stack ? `\n:root, body, button, input, textarea, select, h1, h2, h3, h4, .page h1, .page h2, .rail, .rail-item, .rail-label, .rail-brand { font-family: ${stack} !important; }
code, pre, kbd, .mail-code { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace !important; }` : '');
  try { localStorage.setItem(key, JSON.stringify(appearance)); } catch { /* not remembered this time */ }
  window.dispatchEvent(new Event('agora-appearance'));
}
