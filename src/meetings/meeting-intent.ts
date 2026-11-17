/** What another section asks Reuniones to do when it opens: show one recorded meeting, or have the title of a new
 * recording ready (the Agenda's «Grabar esta reunión»). Read once, by the next Reuniones that mounts. Nothing
 * starts recording by itself: the user still presses «Empezar a grabar». */
type Intent = { open?: number; title?: string };
let waiting: Intent | null = null;

export const requestMeeting = (intent: Intent) => { waiting = intent; };
/** Read while rendering (a render that is thrown away, while a part loads, must not lose it)… */
export const peekMeetingIntent = (): Intent | null => waiting;
/** …and forgotten once Reuniones is really on screen (a ref callback, at commit). */
export const forgetMeetingIntent = () => { waiting = null; };
