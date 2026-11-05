const WORDS_PER_MINUTE = 200;

/** Minutes to read `text` at 200 words per minute, at least 1. */
export function readingTime(text: string = ''): number {
  const words = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\s]+/g, 'w'))
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
