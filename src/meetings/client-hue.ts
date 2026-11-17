/** A hue per client, so a glance at the list tells who each meeting was with: Central's clients (sorted by
 * name) step round the wheel by the golden angle, so neighbours never look alike; a client no longer in
 * Central takes one from its name. The shade comes from the theme in meetings.css. */
export function clientHue(name: string, known: string[] = []) {
  const at = known.indexOf(name);
  if (at >= 0) return Math.round((at * 137.508 + 140) % 360);
  let hash = 0;
  for (const char of name.trim().toLocaleLowerCase('es')) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return Math.round(((hash * 0.6180339887) % 1) * 360);
}
