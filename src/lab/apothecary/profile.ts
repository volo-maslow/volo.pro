/**
 * The profile "spec sheet", derived from src/data. Values are taken from or
 * lightly rephrased out of site.ts / work.ts / elsewhere.ts; nothing new is added.
 */
import { site } from '../../data/site';
import { work } from '../../data/work';

export interface SpecRow {
  label: string;
  /** One or more lines, ink. */
  value: string[];
  /** A quieter last line, muted. */
  sub?: string;
  href?: string;
}

// Roles with no `end` at all are current (an empty string means "unknown", not "present").
const current = work.filter((r) => r.end === undefined);
const basedIn = site.tagline.split('·').pop()?.trim() ?? '';

export const profile: SpecRow[] = [
  {
    label: 'name',
    value: [site.name.toLowerCase()],
    sub: site.fullName.toLowerCase(),
  },
  // Current roles, oldest first: "senior lead software engineer, uptain" then "founder, arctype".
  {
    label: 'role',
    value: [...current].reverse().map((r) => `${r.title}, ${r.company}`),
  },
  { label: 'based in', value: [basedIn] },
  {
    label: 'currently',
    value: [
      'engineering at uptain in hamburg and building arctype, a calm voice and text journal.',
    ],
  },
  {
    label: 'suited to',
    value: ['founders and ctos who want to ship.'],
    sub: 'hands-on, close to the code.',
  },
  { label: 'write to', value: [site.email], href: `mailto:${site.email}` },
];

/** bio[0], set in sentence case for the serif statement. */
export const statement = site.bio[0]
  .replace(/^./, (c) => c.toUpperCase())
  .replace(/\bi\b/g, 'I');
