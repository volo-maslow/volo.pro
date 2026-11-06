export interface Site {
  /** Display name, lowercase in the UI. */
  name: string;
  /** Legal / full name, used in metadata. */
  fullName: string;
  tagline: string;
  /** Default meta description. */
  description: string;
  /** Home bio, 2–3 sentences, lowercase voice. */
  bio: string[];
  email: string;
  url: string;
  locale: string;
  repo: string;
}

export const site: Site = {
  name: 'Volo Maslow',
  fullName: 'Volodymyr Maslov',
  tagline: 'engineer · hamburg, germany',
  description:
    'volo maslow, engineer in hamburg. building products end to end, writing about how they work.',
  bio: [
    'i build products end to end, from the first sketch to the thing people use every day.',
    'currently engineering at uptain in hamburg and building arctype, a calm voice and text journal.',
    'i also help founders and ctos ship: hands-on, close to the code.',
  ],
  email: 'hello@volo.pro',
  url: 'https://volo.pro',
  locale: 'en',
  repo: 'https://github.com/volo-maslow/volo.pro',
};
