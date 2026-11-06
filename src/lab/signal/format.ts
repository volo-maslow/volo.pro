/** "2026.11.05", dot-separated like a device readout. */
export const dotDate = (d: Date): string =>
  d.toISOString().slice(0, 10).replaceAll('-', '.');

/** "2021-12" → "2021.12"; free-form years pass through. */
export const dotMonth = (s: string): string => s.replaceAll('-', '.');

/** Two-digit index: 1 → "01". */
export const pad2 = (n: number): string => String(n).padStart(2, '0');
