// Plain answers to an announcement, read in the interface and never by a model.
const YES = /^\s*(s[ií]|vale|ok|de acuerdo|hecho|hecha|hazlo|m[aá]rcala|m[aá]rcalo)[\s.!]*$/i;
const NO = /^\s*(no|desc[aá]rtala|desc[aá]rtalo|descartar|ignora(la|lo)?)[\s.!]*$/i;

/** A plain answer to an announcement: «sí» marks it done, «no» dismisses it, anything else is a question. */
export const replyState = (text: string) => (YES.test(text) ? 'done' : NO.test(text) ? 'dismissed' : null);

