# volo.pro

Personal site of Volo Maslow: writing, work, projects and a /now page. Astro
(static), MDX, IBM Plex Mono, and the dotted wind-tree background ported from
Arctype. Design and build spec: [docs/DESIGN.md](docs/DESIGN.md).

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
- `src/components/tree/`: the background tree. Treat its logic as vendored from
  Arctype; mark text with `data-tree-avoid` / `data-tree-avoid="soft"` to keep
  dots off it.

## deploy

Every push to `main` deploys through the GitHub Pages workflow in
`.github/workflows/deploy.yml` (delete it if the site moves to Vercel). CI runs
typecheck and build on every push and pull request.
