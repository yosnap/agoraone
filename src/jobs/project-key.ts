/** The same key as the core's work_projects.key: «Café-Web S.L.» and «cafe_web_sl» match; nothing else is assumed. */
export const projectKey = (name: string | null | undefined) =>
  (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
