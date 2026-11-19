/** Recording a meeting by voice (user's request, 18/11/2026): «graba la reunión», «empieza a grabar», «para la
 * grabación», «hemos terminado». Only these whole sentences, said to Watson; it records the way the rail's
 * button does (the last choices of the form) and the recording shows in the rail as always. */
const START = /^(?:(?:empieza|comienza|inicia|arranca|ponte|vamos)\s+a\s+grabar|graba|grabame|empieza la grabacion|inicia la grabacion)(?:\s+(?:la|esta|una|nuestra)\s+reunion)?(?:\s+(?:ya|ahora))?$/;
const STOP = /^(?:(?:para|deten|termina|acaba|finaliza|corta)\s+(?:la\s+)?(?:grabacion|grabacion de la reunion|reunion)|(?:para|deja)\s+de\s+grabar(?:\s+la\s+reunion)?|(?:ya\s+)?hemos\s+(?:terminado|acabado)(?:\s+la\s+reunion)?|fin de la reunion)$/;

/** «start» or «stop» when the request (already plain: lower case, no accents or punctuation, no call to
 * Watson) asks to record a meeting or to stop recording it; null for anything else. */
export function meetingOrder(said: string): 'start' | 'stop' | null {
  return START.test(said) ? 'start' : STOP.test(said) ? 'stop' : null;
}
