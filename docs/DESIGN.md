# volo.pro — design and build spec

Personal site of Volo Maslow (Volodymyr Maslov), engineer in Hamburg, Germany.
Builder of Arctype (arctype.ai). Audience: engineers, and founders / CEOs / CTOs
who want to build products and want a hands-on engineer-partner.

## References

- **Aesop** — warm parchment paper and brown-black ink, editorial restraint,
  generous whitespace, product "spec sheet" detail blocks (label / value pairs),
  thin rules, small numbered details. Nothing shouts.
- **Terminal character** — monospace is the dominant face, lowercase UI copy,
  bracketed keyboard hints `[h] home` that are real shortcuts, typographic icons
  (`↗`, `←`, `→`, `·`), no images.
- **Dots** — the animated dotted background is the signature; dot leaders,
  dotted rules and the scene share one 6px pitch.
- blainsmith.com — content reference: full-content RSS, sitemap, `/now` page,
  long-lived archive on own domain, direct voice.

The direction is called **apothecary** (chosen from three lab directions in
Nov 2026).

## Visual system

Light by default, dark via `prefers-color-scheme` (no toggle). Dark is designed,
not inverted: an amber bottle in low light. All tokens in `src/styles/tokens.css`.

| token                          | role                                   | light        | dark          |
| ------------------------------ | -------------------------------------- | ------------ | ------------- |
| `--paper`                      | page                                   | `#f6f5e8`    | `#17110b`     |
| `--paper-2`                    | code background                        | `#efecdb`    | `#21180f`     |
| `--ink`                        | names, values, headings                | `#27231a`    | `#f0e6d0`     |
| `--text`                       | body copy                              | `#3d382c`    | `#d4c8ae`     |
| `--muted`                      | labels, dates, notes, nav              | `#6b6753`    | `#a1957b`     |
| `--rule`                       | hairlines                              | `#d9d4bd`    | `#3a2f22`     |
| `--dot`                        | dot leaders, `[ ]` brackets, slashes   | `#b9b298`    | `#5a4a35`     |
| `--accent`                     | section numbers, hover, focus          | `#8a5523`    | `#d6a15e`     |
| `--select`                     | text selection                         | `#e6d7b8`    | `#4a361d`     |
| `--scene-ink` (r,g,b)          | background scene: rock                 | `104,76,44`  | `178,132,78`  |
| `--scene-water-ink` (r,g,b)    | background scene: water                | `70,56,40`   | `238,228,208` |

Contrast (WCAG): muted on paper 5.2:1 light / 6.3:1 dark; accent 5.6:1 / 8.1:1;
body text 10.6:1 / 11.3:1. `--dot` and `--rule` are decorative only, never text.

### Type

- **IBM Plex Mono** 400, 400 italic, 500 — all UI and body. Body 14.5px / 1.75,
  small 12.5px (masthead, compact specs, meta), tiny 11.5px (footer).
  500 for names and headings, italic for notes and ledes. Dates and numbers
  `tabular-nums`. No 600.
- **Newsreader** (variable, opsz) at weight 300 — only two places: the home
  statement (`site.bio[0]` in sentence case, `clamp(30px, 4.2vw, 44px)`) and
  article titles (`clamp(44px, 7vw, 72px)`, tracking -0.02em).
- Self-hosted latin subsets declared in `Base.astro`: preloaded, `font-display:
  block`, and a `fonts-loading` class on `<html>` hides `.page` until all four
  faces load (800ms cap) so text never paints in a fallback face.

### Layout

- One column, `--column: 680px`, gutter 22px (44px ≥ 640px). Page padding 40px
  (56px top ≥ 1024px).
- ≥ 1024px the column and a 440px scene lane (`--scene-lane`) are centred as
  one group, so the column sits left of centre and the waterfall falls through
  the right margin. `PAGE_LANE` / `PAGE_BOX` / `PAGE_GUTTER` in
  `components/waterfall/config.ts` mirror this rule; change them together.
- `--label` (15ch, 20ch ≥ 640px, 13ch < 480px) is the shared label column: spec
  sheet `dt`s, entry dates and section numbers all align on it.

### Patterns

- **Masthead** (`Nav.astro`): a file path left — `volo.pro / writing / colophon`
  (slashes in `--dot`, current crumb muted) — and keyed nav right:
  `[h] home [w] writing [p] projects [n] now`. Brackets in `--dot`, the key turns
  amber on hover and for the current page. Hints hidden under 640px.
- **Numbered section** (`Section.astro`): `01` in accent on the label column,
  lowercase title in ink 500, then a dot leader (`.dots`, 6px pitch) to an
  optional muted `all writing →` link. 104px between sections (80px mobile).
- **Spec sheet** (`.spec` in global.css): `<dl>` grid, label / value, muted
  `dt`, ink `dd`, 1px rules above every row and below the last. `.sub` adds a
  quieter muted line. `.spec--compact` (small type, tighter rows) for article
  details and page facts.
- **Entries** (`.entries`, used by PostList / WorkList / ProjectList): aside
  (date or years) on the label column, then name (ink 500, `↗` for external),
  `· role` muted, an italic muted note; optional right-hand meta (`1 min`,
  `draft`). Same rules as the spec sheet. Under 480px the aside stacks on top.
- **Page head** (`PageHead.astro`): mono page name in ink 500, one muted line,
  optional compact spec of facts (entries, feed, updated, status).
- **Article** (`writing/[...slug].astro`, `prose.css`): `← writing`, serif
  title, italic lede, compact spec (published, reading time, filed under,
  status), body at 64ch; h2s auto-numbered `01 02 …` in accent, `·` bullets in
  accent, links underlined in `--dot` turning amber, `hr` as a dotted rule,
  code on `--paper-2` between hairlines with a `[copy]` button. Ends with a dot
  leader and `← all writing` / `top ↑`.
- **Footer**: hairline, tiny muted: `© YEAR volo maslow` · `set in plex mono &
  newsreader` · `static html · no cookies · no tracking`.
- Links carry no underline in UI chrome (hover → accent, 220ms); running copy
  uses `.text-link` / prose links (dotted-ink underline).
- Focus: 1px accent outline, 4px offset. Skip link first in the tab order.
- `prefers-reduced-motion`: transitions off; the scene handles its own stillness.

## Background scene

A dotted waterfall (`src/components/waterfall/`, anime.js + Canvas 2D), drawn in
the same language as the earlier wind tree: round dots on a fixed 6px lattice
(5px on mobile), quantised to four levels, no lines or gradients. Two inks: the
rock in the amber `--scene-ink`, the water in `--scene-water-ink` (a deeper
brown on parchment; near-white in dark mode, where white water is the brightest
thing in the scene).

- **Scene.** A framing cliff, not a wall: a low left buttress and a taller
  right mass with the fall in the notch between them, sky left above the brink
  and to the right. The rock is engraved: always-lit silhouettes, chiselled
  facets hatched along their planes (diagonal strokes), light from the upper
  left, dark wet rock beside and behind the sheet. The stream enters from the
  upper right and pours over a bright brink lip; the sheet contracts just below
  it, then falls as strands whose gaps widen and whose edges fray with the
  drop, drawn as short vertical dashes in the lower half, breaking into
  droplets and spray over a broken boil and a mist halo. The pool surface sits
  at 78% of the viewport height, so the lake is only partly visible; its far
  shore is irregular, rings read as thin foreshortened ellipses, and the fall
  and cliff reflect in broken rows. Flow surges on a seeded schedule;
  everything is deterministic for a given seed. The scene thins out over the
  last 120px before the viewport's right edge.
- **Intro.** The sim is pre-rolled, so the page opens on a fall that is
  already flowing at 70% (complete within 0.5s of load), fading in over
  600ms; discharge rises to full over ~2s, and the first coherent slug arrives
  as a surge a few seconds later.
- **Placement.** ≥ 1024px the lip sits in the scene lane
  (`laneLeft + clamp(0.42 · laneWidth, 170, 330)`), rocks and the pool's fade-in
  start 24px right of the text column, so no dot ever sits under text at 1024,
  1280, 1440 or 1920. Desktops of 768–1023px put the fall at 80% of the width
  and soft-mask everything behind text. Mobile (< 768px) draws a small
  vignette in the empty top-right of the first screen (lip at 12.5% of the
  height, the fall 15% of the width from the right edge, the cliff running off
  it), so at the top of the page it sits beside the name, not under text.
  Resizing only translates the lattice; the rock raster is rebuilt only when
  its height or lane clip changes.
- **Play.** Pointer input is read on `window`: the cursor (contact radius
  ≈ 0.6 × the sheet's half-width) parts the fall, throws a splash crown off its
  shoulders, and the sheet refills within ~1.5 radii below it with droplets
  falling through the shadow; it trails a wake through the pool and pushes the
  mist; a tap or click drops a pebble (rings); scrolling sloshes the pool. On
  narrow layouts a tap on static text plays too (only links and controls, or a
  text selection, are left alone).
  `dot-scene:gust` and `dot-scene:splash` (and the tree's `dot-tree:gust`) can
  be dispatched to the host.
- **Budget.** ~2,600–2,900 lattice dots + ~2,700 rock dots on a separate canvas
  drawn once; 1–2ms per frame at 1440–1920 (budget 4ms, degrades itself above
  it). Both canvases together stay under 5M backing pixels. Pauses when the
  tab is hidden; 30fps on the quiet variant and on mobile.
- **Reduced motion.** One long-exposure still frame (continuous streaks), no
  loop. It is composed once per build in its own task and cached; scrolling
  only re-masks the cached frame.

Rendered once in `src/layouts/Base.astro` through the `Backdrop` import, the
single place to swap it. Contract for any scene: takes a `class` prop, renders
a fixed full-viewport host at z-index 0 with `pointer-events: none` and
`aria-hidden`, listens for pointer input on `window`, tints from `--scene-ink`,
and keeps dots off elements marked `data-scene-avoid` (hard) or
`data-scene-avoid="soft"` (dimmed). Content sits in `.page`
(`position: relative; z-index: 1`). Home (`<Base fullScene>`) gets `.backdrop`
(opacity .85 in both schemes); inner pages `.backdrop backdrop--quiet
dot-waterfall--quiet`: `.backdrop--quiet` dims any scene to .5, and
`dot-waterfall--quiet` only switches the waterfall's runtime to its quiet mode
(30fps, lighter ink, fewer droplets).

The previous scene, `components/tree/DotTree.astro`, is kept but not mounted.
It reads the same names (`--scene-ink`, `data-scene-avoid`, with its legacy
`--tree-ink` / `data-tree-avoid` as fallbacks), so swapping the import back is
enough; the waterfall also still accepts the legacy names.

## Routes

| route             | content                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/`               | name + tagline, serif statement; `01 profile` spec sheet, `02 writing` (latest 4), `03 work` (3), `04 projects` (3), `05 elsewhere` |
| `/writing`        | page head (entries, feed), one numbered section per year, newest first; drafts excluded in production                           |
| `/writing/[slug]` | article pattern above; Shiki (light `github-light`, dark `vesper`)                                                              |
| `/work`           | page head (write to), `01 roles` — all roles as entries                                                                         |
| `/projects`       | page head, `01 built` — entries plus a `built with` line                                                                        |
| `/now`            | page head (updated), `01 at present` spec sheet, now-page note                                                                  |
| `/rss.xml`        | full-content feed                                                                                                               |
| sitemap           | `@astrojs/sitemap`                                                                                                              |
| `404`             | page head (status 404), `01 try instead` spec of links                                                                          |

Keyboard: `h` home, `w` writing, `p` projects, `n` now — global, ignored with
modifiers or while typing.

## Content

- `src/content/writing/*.mdx` — frontmatter: `title`, `description`, `date`
  (YYYY-MM-DD), `draft` (bool, default false), `tags` (string[], optional).
- Structured data in `src/data/` as TS: `work.ts`, `projects.ts`, `elsewhere.ts`,
  `site.ts` (name, tagline, bio, email, urls).
- Reading time: words / 200.

## Stack

Astro (static output), MDX, @astrojs/rss, @astrojs/sitemap, animejs (background
scene), @fontsource/ibm-plex-mono, @fontsource-variable/newsreader. No UI framework, no Tailwind: plain scoped CSS +
tokens. Hosted on Vercel, deploy on push to `main`. `site` in astro.config is
`https://volo.pro`.
