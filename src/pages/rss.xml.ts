import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { loadRenderers } from 'astro:container';
import { render } from 'astro:content';
import { getContainerRenderer } from '@astrojs/mdx/container-renderer';
import { site } from '../data/site';
import { getPosts } from '../lib/posts';

/** Full-content feed: each post is rendered to HTML with the container API. */
export async function GET(context: APIContext) {
  const renderers = await loadRenderers([getContainerRenderer()]);
  const container = await AstroContainer.create({ renderers });
  const posts = await getPosts();
  const origin = context.site ?? new URL(site.url);

  const items = await Promise.all(
    posts.map(async (post) => {
      const { Content } = await render(post);
      const html = await container.renderToString(Content);
      const link = `/writing/${post.id}`;
      return {
        title: post.data.title,
        description: post.data.description,
        pubDate: post.data.date,
        link,
        categories: post.data.tags,
        // Make root-relative links absolute for feed readers.
        content: html
          // Drop the "#" heading anchors; they mean nothing in a feed reader.
          .replace(/<a class="heading-anchor"[^>]*>#<\/a>/g, '')
          .replace(/(href|src)="\/(?!\/)/g, `$1="${origin.origin}/`),
      };
    }),
  );

  return rss({
    title: `${site.name.toLowerCase()} · writing`,
    description: site.description,
    site: origin,
    items,
    customData: `<language>en</language>`,
    trailingSlash: false,
  });
}
