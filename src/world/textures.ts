import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from 'three';

// Small procedural textures drawn locally (hedge foliage, lamp light pools).
// Photographic surfaces live in surfaces.tsx.
const cache = new Map<string, CanvasTexture>();

function noisy(ctx: CanvasRenderingContext2D, size: number, base: string, spread: number, seed: number) {
  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
  let value = seed;
  const random = () => { value = (value * 16807) % 2147483647; return value / 2147483647; };
  for (let i = 0; i < size * size * 0.35; i++) {
    const shade = (random() - 0.5) * spread;
    ctx.fillStyle = shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
    ctx.fillRect(random() * size, random() * size, 1 + random() * 2, 1 + random() * 2);
  }
}

function make(key: string, draw: (ctx: CanvasRenderingContext2D, size: number) => void, size = 256) {
  const found = cache.get(key);
  if (found) return found;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  cache.set(key, texture);
  return texture;
}

function blotches(ctx: CanvasRenderingContext2D, size: number, colors: string[], count: number, seed: number) {
  let value = seed;
  const random = () => { value = (value * 16807) % 2147483647; return value / 2147483647; };
  for (let i = 0; i < count; i++) {
    const x = random() * size, y = random() * size, r = size * (0.04 + random() * 0.12);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, colors[i % colors.length]); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient; ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
}

export const textures = {
  grass: () => make('grass', (ctx, size) => {
    noisy(ctx, size, '#6c8b58', 0.16, 7);
    blotches(ctx, size, ['rgba(140,160,90,0.12)', 'rgba(60,90,55,0.12)', 'rgba(120,130,80,0.1)'], 50, 5);
    noisy(ctx, size, 'rgba(0,0,0,0)', 0.1, 9);
  }, 512),
  /** Soft radial pool of light projected under street lamps at night. */
  glow: () => make('glow', (ctx, size) => {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,214,150,1)'); gradient.addColorStop(0.45, 'rgba(255,190,120,0.35)'); gradient.addColorStop(1, 'rgba(255,170,90,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  }, 128),
};

