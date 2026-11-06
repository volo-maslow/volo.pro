export interface Role {
  company: string;
  title: string;
  /** Free-form, e.g. "2023" or "2023-04". */
  start: string;
  /** Omit for current roles. */
  end?: string;
  summary: string;
  url?: string;
}

/** Newest first. */
export const work: Role[] = [
  {
    company: 'arctype',
    title: 'founder',
    start: '2026',
    summary:
      'a calm journal for your days, spoken or written. product, design and engineering.',
    url: 'https://arctype.ai',
  },
  {
    company: 'uptain',
    title: 'senior lead software engineer',
    start: '2021-12', // TODO verify exact month
    summary:
      'leading software engineering for cart-abandonment and conversion software for e-commerce, made in hamburg.',
    url: 'https://uptain.de',
  },
  {
    company: 'ascendix technologies',
    title: 'software engineer', // TODO verify title and dates
    start: '',
    end: '2021',
    summary: 'software development for real-estate and crm products.', // TODO verify
    url: 'https://ascendix.com',
  },
  {
    company: 'team international',
    title: 'software engineer', // TODO verify title and dates
    start: '',
    end: '',
    summary: 'software development services.', // TODO verify
    url: 'https://www.teaminternational.com',
  },
];
