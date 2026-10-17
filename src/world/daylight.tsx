import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type LightMode = 'auto' | 'day' | 'dusk' | 'night';
export const lightModeLabels: Record<LightMode, string> = { auto: 'Hora real', day: 'Día', dusk: 'Atardecer', night: 'Noche' };

// Observer used for the real-time sun. Madrid matches the user's timezone (Europe/Madrid);
// it only drives lighting, never location services.
const observer = { latitude: 40.42, longitude: -3.7 };
const rad = Math.PI / 180;

// NOAA simplified solar position. Azimuth in degrees clockwise from north.
export function solarPosition(date: Date, latitude = observer.latitude, longitude = observer.longitude) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const g = 2 * Math.PI / 365 * ((date.getTime() - start) / 864e5 - hours / 24 + (hours - 12) / 24);
  const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const hourAngle = ((hours * 60 + eqTime + 4 * longitude) / 4 - 180) * rad;
  const lat = latitude * rad;
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle);
  const elevation = 90 - Math.acos(Math.max(-1, Math.min(1, cosZenith))) / rad;
  const azimuth = (Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) / rad + 180 + 360) % 360;
  return { elevation, azimuth };
}

const fixed: Record<Exclude<LightMode, 'auto'>, { elevation: number; azimuth: number }> = {
  day: { elevation: 48, azimuth: 205 }, dusk: { elevation: 2.5, azimuth: 258 }, night: { elevation: -25, azimuth: 300 },
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export type Daylight = {
  mode: LightMode; elevation: number; azimuth: number;
  /** Unit vector towards the sun. Scene north is -z, east is +x. */
  sun: [number, number, number];
  /** 0 full day … 1 full night. */
  night: number;
  /** Strength of the warm low-sun light around sunrise and sunset. */
  dusk: number;
};

export function daylightAt(date: Date, mode: LightMode): Daylight {
  const { elevation, azimuth } = mode === 'auto' ? solarPosition(date) : fixed[mode];
  const el = elevation * rad, az = azimuth * rad;
  return {
    mode, elevation, azimuth,
    sun: [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)],
    night: clamp((2 - elevation) / 10),
    dusk: clamp(1 - Math.abs(elevation - 3) / 12),
  };
}

const DaylightContext = createContext<Daylight>(daylightAt(new Date(), 'day'));
export const useDaylight = () => useContext(DaylightContext);

/** Daylight for the chosen mode, refreshed every minute while following the real clock. */
export function useDaylightClock(mode: LightMode) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (mode !== 'auto') return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [mode]);
  return useMemo(() => daylightAt(now, mode), [now, mode]);
}

export function DaylightProvider({ value, children }: { value: Daylight; children: ReactNode }) {
  return <DaylightContext.Provider value={value}>{children}</DaylightContext.Provider>;
}
