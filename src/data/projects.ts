export interface Project {
  name: string;
  role: string;
  /** Free-form year or range. */
  date: string;
  summary: string;
  tech: string[];
  url?: string;
}

export const projects: Project[] = [
  {
    name: 'arctype',
    role: 'founder',
    date: '2026',
    summary:
      'a calm voice and text journal. speak or write, it keeps your days.',
    tech: ['astro', 'typescript', 'canvas'], // TODO verify
    url: 'https://arctype.ai',
  },
  {
    name: 'project-ark',
    role: 'author',
    date: '2025', // TODO verify
    summary:
      'a personal anti-adhd planner, with an mcp server so ai assistants can read and plan with it.',
    tech: ['typescript', 'mcp'], // TODO verify
  },
  {
    name: 'ua-alerts-announcer',
    role: 'author',
    date: '2026',
    summary: 'announces ukrainian air-raid alerts.', // TODO verify
    tech: ['rust'],
    url: 'https://github.com/volo-maslow/ua-alerts-announcer',
  },
];
