// Host-supplied links end up as clickable links on public pages, so only web URLs are accepted.
// `new URL()` alone also accepts "javascript:" and "data:" URLs.
function isHttpUrl(value) {
  try {
    const { protocol } = new URL(String(value).trim());
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isHttpUrl };
