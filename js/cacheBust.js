/**
 * Cache-busting utility.
 * Appends ?v=<version> to asset URLs so the browser fetches fresh copies
 * whenever the game version (set by index.html from version.json) changes.
 */
const _v = window.__CACHE_BUST || Date.now();

export function bustUrl(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}v=${_v}`;
}
