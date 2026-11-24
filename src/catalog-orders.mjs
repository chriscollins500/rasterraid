const indexOrder = (label, field, direction) => ({ label, index: [field + ':' + direction, 'id:' + direction] });
const newFirst = indexOrder('Newest first', 'createdAt', 'desc');
const oldFirst = indexOrder('Oldest first', 'createdAt', 'asc');

export const catalogOrders = {
  articles: {
    newest: newFirst, oldest: oldFirst,
    updated: { label: 'Recently updated', site: 'Recently Updated' },
    reactions: { label: 'Most reactions', site: 'Most Reactions' },
    comments: indexOrder('Most comments', 'stats.commentCount', 'desc'),
    views: indexOrder('Most viewed', 'stats.viewCount', 'desc'),
    bookmarks: indexOrder('Most bookmarked', 'stats.favoriteCount', 'desc'),
    collected: indexOrder('Most collected', 'stats.collectedCount', 'desc'),
    buzz: indexOrder('Most Buzz tips', 'stats.tippedAmountCount', 'desc'),
  },
  comics: {
    updated: indexOrder('Recently updated', 'updatedAt', 'desc'),
    newest: newFirst, oldest: oldFirst,
    followers: indexOrder('Most followed', 'stats.followerCount', 'desc'),
    chapters: indexOrder('Most chapters', 'stats.chapterCount', 'desc'),
  },
  collections: {
    newest: newFirst, oldest: oldFirst,
    followers: indexOrder('Most followed', 'metrics.followerCount', 'desc'),
    items: indexOrder('Most items', 'metrics.itemCount', 'desc'),
  },
  users: {
    newest: indexOrder('Newest accounts', 'createdAt', 'desc'),
    oldest: indexOrder('Oldest accounts', 'createdAt', 'asc'),
    followers: indexOrder('Most followed', 'metrics.followerCount', 'desc'),
    uploads: indexOrder('Most uploads', 'metrics.uploadCount', 'desc'),
  },
  tools: {
    name: indexOrder('Supported first, then A–Z', 'name', 'asc'),
    recent: indexOrder('Supported first, then newest', 'createdAt', 'desc'),
  },
  apps: {
    popular: { label: 'Most popular', site: 'popular' },
    'top-rated': { label: 'Top rated', site: 'top-rated' },
    newest: { label: 'Newest first', site: 'newest' },
    name: { label: 'Name, A–Z', site: 'name' },
  },
  aiServices: {
    name: { label: 'Name, A–Z' },
    cost: { label: 'Lowest median Buzz' },
    speed: { label: 'Shortest median time' },
  },
};

export function catalogOrder(scope, order) {
  const choices = catalogOrders[scope];
  return choices && Object.hasOwn(choices, order) ? choices[order] : undefined;
}
