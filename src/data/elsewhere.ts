import { site } from './site';

export interface Link {
  label: string;
  href: string;
  /** Shown after the label, muted. */
  detail?: string;
}

export const elsewhere: Link[] = [
  { label: 'email', href: `mailto:${site.email}`, detail: site.email },
  {
    label: 'github',
    href: 'https://github.com/volo-maslow',
    detail: 'volo-maslow',
  },
  { label: 'arctype', href: 'https://arctype.ai', detail: 'arctype.ai' },
  { label: 'rss', href: '/rss.xml', detail: '/rss.xml' },
];
