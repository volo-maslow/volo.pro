# volo.pro

Personal site of Volo Maslow: writing, work, projects and a /now page. Astro
(static), MDX, IBM Plex Mono and Newsreader, and an animated dotted waterfall
in the background. Design and build spec: [docs/DESIGN.md](docs/DESIGN.md).

## develop

```sh
npm install
npm run dev        # http://localhost:4321
npm run check      # typecheck + build
npm run fmt        # prettier
```

## add a post

Create `src/content/writing/<slug>.mdx` (the file name is the URL):

```mdx
---
title: A post title
description: one line for lists, meta tags and RSS.
date: 2026-11-05
draft: false # drafts show in dev only
tags: [optional, tags]
---

Body in Markdown/MDX.
```

## content

- `src/data/site.ts`, `work.ts`, `projects.ts`, `elsewhere.ts`: structured data
  for the home, work and projects pages.
- `src/pages/now.astro`: the /now page.
- `src/components/waterfall/`: the background scene, a dotted waterfall falling
  from rocks into a partly visible pool. The pointer parts the fall and wakes
  the pool, taps drop pebbles, scrolling sloshes the water. Mark text with
  `data-scene-avoid` (or `data-scene-avoid="soft"` to only dim) to keep dots
  off it; the tints are `--scene-ink` (rock) and `--scene-water-ink` (water)
  in `src/styles/tokens.css`. In dev,
  `window.__waterfall` exposes stats and controls (`getStats`, `pause`,
  `stepTo`, `poke`, …).
- `src/components/tree/`: the earlier wind-tree scene, ported from Arctype. Not
  mounted any more, but the waterfall reuses its `rng.ts`, `wind.ts` and
  `events.ts`, and the draft post `a-tree-that-bends-in-the-wind` describes it.
  It reads the same `--scene-ink` / `data-scene-avoid` names, so swapping the
  `Backdrop` import in `src/layouts/Base.astro` back is enough to bring it back.

## deploy

Every push to `main` deploys through the GitHub Pages workflow in
`.github/workflows/deploy.yml` (delete it if the site moves to Vercel). CI runs
typecheck and build on every push and pull request.
