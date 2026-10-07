function emailKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normaliseClientLinks(links) {
  if (!Array.isArray(links)) return [];
  return [...new Set(
    links
      .filter((link) => typeof link === 'string')
      .map((link) => link.trim())
      .filter((link) => /^vless:\/\//i.test(link))
  )].sort();
}

function cachedClientLinks(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return normaliseClientLinks(JSON.parse(value));
  } catch {
    return [];
  }
}

/** Preserve a last-known link cache when the panel link endpoint is unavailable. */
function resolveLinkCache(previous, refreshedLinks) {
  const previousLinks = cachedClientLinks(previous?.vless_links);
  const currentLinks = refreshedLinks === undefined ? previousLinks : normaliseClientLinks(refreshedLinks);
  const linksChanged = refreshedLinks !== undefined && JSON.stringify(previousLinks) !== JSON.stringify(currentLinks);
  const vlessLinks = refreshedLinks === undefined && previous?.vless_links === undefined
    ? null
    : JSON.stringify(currentLinks);

  return { linksChanged, vlessLinks };
}

module.exports = {
  cachedClientLinks,
  emailKey,
  normaliseClientLinks,
  resolveLinkCache
};
