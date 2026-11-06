import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'writing'>;

/** Published posts, newest first. Drafts are shown in dev only. */
export async function getPosts(): Promise<Post[]> {
  const posts = await getCollection(
    'writing',
    ({ data }) => import.meta.env.DEV || !data.draft,
  );
  return posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
