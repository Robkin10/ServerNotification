function emailKey(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normaliseClientLinks(links) {
  if (!Array.isArray(links)) return [];
  return [...new Set(links
    .map((link) => typeof link === 'string' ? link.trim() : '')
    .filter((link) => /^vless:\/\//i.test(link))
  )].sort();
}

module.exports = {
  emailKey,
  normaliseClientLinks
};
