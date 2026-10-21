/** Accent- and case-insensitive text for filters, so «busqueda» finds «Búsqueda». */
export const fold = (text: string) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
