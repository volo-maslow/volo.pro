# volo.pro — design and build spec

Personal site of Volo Maslow (Volodymyr Maslov), engineer in Hamburg, Germany.
Builder of Arctype (arctype.ai). Audience: engineers, and founders / CEOs / CTOs
who want to build products and want a hands-on engineer-partner.

## References

- nexxel.dev — structure and design reference: single column, monospace only,
  lowercase UI copy, bracketed keyboard hints `[h] home`, orange `*` section
  markers, hairline dividers, typographic icons (`*`, `↗`, `←`, `·`), no images,
  no footer clutter, hover turns text to the accent colour.
- blainsmith.com — content reference: full-content RSS, sitemap, `/now` page,
  long-lived archive on own domain, no platform dependence, direct voice.
- arctype.ai (apps/public-web in arc-type/monorepo) — Volo's own brand
  direction: warm off-white surface, near-black ink, IBM Plex Mono labels,
  generous whitespace, and the dotted wind-tree canvas background (ported here
  into `src/components/tree/`, untouched logic).

## Visual system

Light theme by default (arctype palette), dark theme via `prefers-color-scheme`
(no toggle in v1). All tokens in `src/styles/tokens.css`.

| token                          | light      | dark          |
| ------------------------------ | ---------- | ------------- |
| surface                        | `#f5f4f0`  | `#141312`     |
| surface-2 (code bg, hover)     | `#eeede9`  | `#1c1b19`     |
| ink (headings)                 | `#1a1917`  | `#eceae5`     |
| text (body)                    | `#3d3b37`  | `#c9c6bf`     |
| muted (dates, hints)           | `#787774`  | `#86837d`     |
| border                         | `#d5d3ce`  | `#2b2a27`     |
| accent                         | `#d9480f`  | `#ff8a3d`     |
| tree ink (`--tree-ink`, r,g,b) | `26,25,23` | `236,234,229` |

- Font: IBM Plex Mono only (400, 500, 600), self-hosted via @fontsource.
  Body 15px / 1.7. h1 (name) 32px/600 tracking -0.02em. Section h2 14px/500
  uppercase-free, lowercase with a leading accent `*`. Dates `tabular-nums`.
- Lowercase UI copy everywhere (nav, headings, list titles). Post titles keep
  their own case inside the article.
- Single centred column, `max-width: 680px`, `padding-inline: 20px`
  (40px ≥ 640px), `padding-block: 48px`. Sections separated by 1px hairline +
  40px spacing.
- Accent used only for: `*` markers, link hover, focus ring, "all posts ↗",
  blockquote border, 404.
- Links: underline 1px, offset 3px, colour inherit; hover → accent, 150ms.
- No images in v1. No analytics. No cookies.
- `prefers-reduced-motion`: the tree stays static (it already handles this),
  transitions off.

## Tree background

`DotTree.astro` renders fixed full-viewport behind content (z-index 0,
pointer-events none). Page content wrapper is `position: relative; z-index: 1`.
Mark text blocks with `data-tree-avoid` (hard) or `data-tree-avoid="soft"` so
dots stay off the text. Read `src/components/tree/layout.ts` for how the tree is
positioned; for volo.pro the tree should sit to the **right** of the column on
wide screens (column is left-of-centre or centred with the crown reading
through the right margin), and behind content on mobile. Retint through
`--tree-ink` on `:root` per colour scheme. Use it on every page (it is the
signature), home page gets the full version.

## Routes

| route             | content                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | nav; h1 "volo maslow"; subtitle "engineer · hamburg, germany"; 2–3 sentence bio; sections: `* writing` (latest 4 + "all writing ↗"), `* work` (latest 3), `* projects` (2–3), `* elsewhere` (email, github, linkedin, arctype, rss) |
| `/writing`        | flat list: date + lowercase title, newest first; drafts excluded in production                                                                                                                                                      |
| `/writing/[slug]` | `← back`, `*` + title, "Month D, YYYY · N min read", prose; h2/h3 anchored; Shiki code blocks (light: `github-light`, dark: `vesper`) with copy button                                                                              |
| `/work`           | intro line, roles: company, title, date range, one-liner, link ↗                                                                                                                                                                    |
| `/projects`       | intro line, projects: name, role, date, one-liner, tech pills, link ↗                                                                                                                                                               |
| `/now`            | "what I'm doing now", dated                                                                                                                                                                                                         |
| `/rss.xml`        | full-content feed                                                                                                                                                                                                                   |
| sitemap           | `@astrojs/sitemap`                                                                                                                                                                                                                  |
| `404`             | ASCII "404" in accent, one line, link home                                                                                                                                                                                          |

Nav (every page, top): `[h] home  [w] writing  [p] projects  [n] now` — letters
are real global shortcuts (ignored while typing in inputs / with modifiers).
Hints hidden under 640px. Work is reachable from home (`all work ↗`).

Footer (every page, tiny, muted): `email · github · linkedin · rss` and
`© YEAR volo maslow`.

## Content

- `src/content/writing/*.mdx` — frontmatter: `title`, `description`, `date`
  (YYYY-MM-DD), `draft` (bool, default false), `tags` (string[], optional).
- Structured data in `src/data/` as TS: `work.ts`, `projects.ts`, `elsewhere.ts`,
  `site.ts` (name, tagline, bio, email, urls).
- Reading time: words / 200.

## Stack

Astro (static output), MDX, @astrojs/rss, @astrojs/sitemap, animejs (tree),
@fontsource/ibm-plex-mono. No UI framework, no Tailwind: plain scoped CSS +
tokens. Hosted on Vercel, deploy on push to `main`. `site` in astro.config is
`https://volo.pro`.
