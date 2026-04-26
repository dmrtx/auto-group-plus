(function initAutoGroupRules(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.AutoGroupRules = api;
})(globalThis, function createAutoGroupRules() {
  function matchesPattern(urlStr, pattern) {
    try {
      if (!urlStr || !pattern) return false;

      const url = new URL(urlStr);
      const normalizedUrl = urlStr.toLowerCase();
      const hostname = url.hostname.toLowerCase();
      const cleanPattern = String(pattern).toLowerCase().trim();

      if (!cleanPattern) return false;

      // Exact URL match.
      if (normalizedUrl === cleanPattern) return true;

      // Domain and subdomains: *.example.com.
      if (cleanPattern.startsWith('*.')) {
        const domain = cleanPattern.slice(2);
        return hostname === domain || hostname.endsWith('.' + domain);
      }

      // Domain only: example.com also matches www.example.com.
      if (hostname === cleanPattern) return true;
      if (hostname === 'www.' + cleanPattern) return true;

      // Simple glob-style matching for URL or hostname patterns.
      const regexPattern = cleanPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      const regex = new RegExp(`^${regexPattern}$`, 'i');

      return regex.test(normalizedUrl) || regex.test(hostname);
    } catch (e) {
      return false;
    }
  }

  function isValidRule(rule) {
    return Boolean(
      rule &&
      String(rule.name || '').trim() &&
      Array.isArray(rule.patterns) &&
      rule.patterns.length > 0
    );
  }

  function findMatchingRule(rules, url) {
    if (!Array.isArray(rules)) return null;

    return rules.find(rule => {
      if (!isValidRule(rule)) return false;
      return rule.patterns.some(pattern => matchesPattern(url, pattern));
    }) || null;
  }

  function normalizeExactUrl(urlStr) {
    try {
      return new URL(String(urlStr || '').trim()).href;
    } catch (e) {
      return '';
    }
  }

  function parseFixedTabLines(value) {
    const parsed = [];

    String(value || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .forEach(line => {
        const match = line.match(/^(\d+)\s*(?:,|\||\s)\s*(.+)$/);
        const index = match ? Number.parseInt(match[1], 10) : parsed.length;
        const url = normalizeExactUrl(match ? match[2] : line);

        if (!Number.isInteger(index) || index < 0 || !url) return;

        parsed.push({ index, url });
      });

    return parsed;
  }

  function formatFixedTabLines(fixedTabs) {
    if (!Array.isArray(fixedTabs)) return '';

    return fixedTabs
      .filter(entry => Number.isInteger(entry.index) && entry.index >= 0 && normalizeExactUrl(entry.url))
      .map(entry => `${entry.index}, ${normalizeExactUrl(entry.url)}`)
      .join('\n');
  }

  function findFixedTabPosition(rule, url) {
    const normalizedUrl = normalizeExactUrl(url);
    if (!normalizedUrl || !Array.isArray(rule && rule.fixedTabs)) return null;

    const match = rule.fixedTabs.find(entry => {
      const fixedUrl = normalizeExactUrl(entry.url);
      const isWildcard = String(entry.url || '').includes('*');

      return Number.isInteger(entry.index) &&
        entry.index >= 0 &&
        fixedUrl &&
        (isWildcard ? matchesPattern(normalizedUrl, fixedUrl) : fixedUrl === normalizedUrl);
    });

    return match ? match.index : null;
  }

  return {
    findFixedTabPosition,
    findMatchingRule,
    formatFixedTabLines,
    isValidRule,
    matchesPattern,
    normalizeExactUrl,
    parseFixedTabLines
  };
});
