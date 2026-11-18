import type { JevShadowCounts } from '../api/core';

const whole = new Intl.NumberFormat('es-ES');

/** «En sombra: N decisiones, coincidencia con lo actual X %», adding mail and WhatsApp; the share counts only the
 * decisions that can still be compared with what is shown now. */
export function shadowLine(shadow: Partial<Record<string, JevShadowCounts>> | undefined): string {
  const all = Object.values(shadow ?? {}).reduce<JevShadowCounts>((sum, found) => found
    ? { decisions: sum.decisions + found.decisions, compared: sum.compared + found.compared, agree: sum.agree + found.agree,
      advertisingAsOther: sum.advertisingAsOther + found.advertisingAsOther, withdrawn: sum.withdrawn + found.withdrawn } : sum,
  { decisions: 0, compared: 0, agree: 0, advertisingAsOther: 0, withdrawn: 0 });
  const noun = all.decisions === 1 ? 'decisión' : 'decisiones';
  const share = all.compared ? `coincidencia con lo actual ${Math.round((all.agree / all.compared) * 100)} %` : 'aún sin nada que comparar';
  return `En sombra: ${whole.format(all.decisions)} ${noun}, ${share}`;
}
