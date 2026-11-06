// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';

// https://astro.build/config
export default defineConfig({
  site: 'https://volo.pro',
  output: 'static',
  prefetch: true,
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'vesper' },
    },
    // remark/rehype plugins need the unified processor (Astro 7 defaults to
    // Sätteri). MDX inherits it.
    processor: unified({
      rehypePlugins: [
        rehypeSlug,
        [
          rehypeAutolinkHeadings,
          {
            behavior: 'append',
            test: ['h2', 'h3'],
            properties: {
              className: ['heading-anchor'],
              ariaHidden: 'true',
              tabIndex: -1,
            },
            content: { type: 'text', value: '#' },
          },
        ],
      ],
    }),
  },
});
