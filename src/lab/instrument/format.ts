/** "2026.11.05": the instrument's date readout, dots as separators. */
export const dotDate = (d: Date): string =>
  d.toISOString().slice(0, 10).replaceAll('-', '.');

/** "2021.12 — now", "until 2021", "earlier". */
export const range = (start: string, end?: string): string => {
  const s = start.replaceAll('-', '.');
  const e = (end ?? '').replaceAll('-', '.');
  if (!s && !e) return 'earlier';
  if (!s) return `until ${e}`;
  return `${s} — ${e || 'now'}`;
};

/** Lab pages link to the lab article for the colophon, the real route otherwise. */
export const postHref = (id: string): string =>
  id === 'colophon' ? '/lab/instrument/post' : `/writing/${id}`;
