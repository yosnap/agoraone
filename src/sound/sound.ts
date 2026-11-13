import { useSyncExternalStore } from 'react';

// AgoraOne's sounds, synthesised with Web Audio (no files): short cues for the interface, steps while walking
// and a quiet ambience in the city. On by default, one switch for all, remembered per browser. Browsers only
// let audio start after a click or key press, so nothing plays before the user has interacted.

export type Cue = 'send' | 'receive' | 'approval' | 'click' | 'step';
const key = 'agora-sound';
let context: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = read();
const listeners = new Set<() => void>();

function read() {
  try { return localStorage.getItem(key) !== 'off'; } catch { return true; }
}

function audio() {
  if (!enabled || typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!context) {
    context = new AudioContext();
    master = context.createGain();
    master.gain.value = 0.5;
    master.connect(context.destination);
  }
  if (context.state === 'suspended') void context.resume().catch(() => undefined);
  return context.state === 'closed' ? null : context;
}

function tone(ctx: AudioContext, frequency: number, start: number, length: number, volume: number, type: OscillatorType = 'sine', to?: number) {
  const oscillator = ctx.createOscillator(), gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (to) oscillator.frequency.exponentialRampToValueAtTime(to, start + length);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(master!);
  oscillator.start(start); oscillator.stop(start + length + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;
function noise(ctx: AudioContext) {
  if (!noiseBuffer) {
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; data[i] = last * 3.5; } // brown-ish
  }
  return noiseBuffer;
}

/** Plays one short cue (nothing when sound is off or the browser has not allowed audio yet). */
export function play(cue: Cue) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (cue === 'send') { tone(ctx, 520, now, 0.09, 0.08); tone(ctx, 780, now + 0.07, 0.12, 0.07); }
  else if (cue === 'receive') { tone(ctx, 880, now, 0.18, 0.06); tone(ctx, 660, now + 0.12, 0.28, 0.05); }
  else if (cue === 'approval') { for (const at of [0, 0.22]) { tone(ctx, 988, now + at, 0.35, 0.08, 'triangle'); tone(ctx, 1319, now + at + 0.05, 0.3, 0.04); } }
  else if (cue === 'click') tone(ctx, 1200, now, 0.04, 0.03, 'square');
  else if (cue === 'step') {
    const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    source.buffer = noise(ctx);
    filter.type = 'lowpass'; filter.frequency.value = 380 + Math.random() * 160;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);
    source.connect(filter).connect(gain).connect(master!);
    source.start(now, Math.random()); source.stop(now + 0.15);
  }
}

// Ambience: soft wind always, birds by day or crickets by night, while the city is walked.
let ambience: { stop: () => void; mode: 'day' | 'night' } | null = null;

export function setAmbience(mode: 'day' | 'night' | null) {
  if (ambience && ambience.mode === mode) return;
  ambience?.stop(); ambience = null;
  const ctx = mode ? audio() : null;
  if (!ctx || !mode) return;
  const wind = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
  wind.buffer = noise(ctx); wind.loop = true;
  filter.type = 'lowpass'; filter.frequency.value = 520;
  gain.gain.value = 0.0001;
  gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 2);
  wind.connect(filter).connect(gain).connect(master!);
  wind.start();
  const timer = setInterval(() => {
    const now = ctx.currentTime;
    if (mode === 'day') { const base = 2200 + Math.random() * 1400; for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) tone(ctx, base, now + i * 0.11, 0.08, 0.015, 'sine', base * 1.35); }
    else for (let i = 0; i < 6; i++) tone(ctx, 4300, now + i * 0.05, 0.03, 0.006, 'triangle');
  }, mode === 'day' ? 4200 : 1300);
  ambience = { mode, stop: () => { clearInterval(timer); gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6); wind.stop(ctx.currentTime + 0.7); } };
}

export function setSound(on: boolean) {
  enabled = on;
  try { localStorage.setItem(key, on ? 'on' : 'off'); } catch { /* not remembered this time */ }
  if (!on) { setAmbience(null); void context?.suspend().catch(() => undefined); }
  listeners.forEach(listener => listener());
  if (on) play('click');
}

export const useSoundOn = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => enabled, () => true);
