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

  return {
    findMatchingRule,
    isValidRule,
    matchesPattern
  };
});
