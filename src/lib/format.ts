const long = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** "July 5, 2024" */
export const formatDate = (d: Date): string => long.format(d);

/** "2024-07-05", for `<time datetime>` and the list column. */
export const isoDate = iso;

/** "2023 — present" */
export const formatRange = (start: string, end?: string): string => {
  if (!start && !end) return 'earlier';
  if (!start) return `until ${end}`;
  return `${start} — ${end || 'present'}`;
};
