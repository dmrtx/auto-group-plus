(function initAutoGroupRules(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.AutoGroupRules = api;
})(globalThis, function createAutoGroupRules() {
  const FALLBACK_GROUP_ICONS = Object.freeze([
    { emoji: '📌', label: 'pushpin', tags: ['pin', 'important'] },
    { emoji: '⭐', label: 'star', tags: ['favorite'] },
    { emoji: '💼', label: 'briefcase', tags: ['work', 'business'] },
    { emoji: '📚', label: 'books', tags: ['reading', 'library'] },
    { emoji: '🎬', label: 'clapper board', tags: ['video', 'movie'] },
    { emoji: '🎵', label: 'musical note', tags: ['music', 'audio'] },
    { emoji: '🎮', label: 'video game', tags: ['gaming'] },
    { emoji: '🏠', label: 'house', tags: ['home'] },
    { emoji: '🛠️', label: 'hammer and wrench', tags: ['tools', 'server'] },
    { emoji: '🧪', label: 'test tube', tags: ['lab', 'testing'] },
    { emoji: '🔒', label: 'locked', tags: ['security', 'private'] },
    { emoji: '💬', label: 'speech balloon', tags: ['chat', 'message'] },
    { emoji: '📰', label: 'newspaper', tags: ['news'] },
    { emoji: '🧾', label: 'receipt', tags: ['invoice', 'billing'] },
    { emoji: '📊', label: 'bar chart', tags: ['analytics', 'metrics'] },
    { emoji: '🚀', label: 'rocket', tags: ['launch'] },
    { emoji: '☁️', label: 'cloud', tags: ['cloud', 'server'] },
    { emoji: '🧠', label: 'brain', tags: ['ideas', 'learning'] },
    { emoji: '🔥', label: 'fire', tags: ['hot', 'active'] }
  ]);
  const GROUP_EMOJIS = Object.freeze(Array.isArray(globalThis.AutoGroupEmojiData)
    ? globalThis.AutoGroupEmojiData
    : FALLBACK_GROUP_ICONS);
  const GROUP_ICONS = Object.freeze(['', ...GROUP_EMOJIS.map(entry => entry.emoji)]);

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

  function normalizeGroupIcon(icon) {
    const value = String(icon || '').trim();
    return GROUP_ICONS.includes(value) ? value : '';
  }

  function formatGroupTitle(rule) {
    const name = String(rule && rule.name || '').trim();
    const icon = normalizeGroupIcon(rule && rule.icon);
    return icon ? `${icon} ${name}` : name;
  }

  function stripGroupIcon(title) {
    let value = String(title || '').trim();
    for (const icon of GROUP_ICONS) {
      if (icon && value.startsWith(`${icon} `)) {
        return value.slice(icon.length).trim();
      }
    }

    return value.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}]\uFE0F?\s+/u, '').trim();
  }

  function normalizeGroupTitle(title) {
    return stripGroupIcon(title).toLowerCase();
  }

  function getGroupTitleIcon(title) {
    const value = String(title || '').trim();
    return GROUP_ICONS.find(icon => icon && value.startsWith(`${icon} `)) || '';
  }

  return {
    GROUP_EMOJIS,
    GROUP_ICONS,
    findFixedTabPosition,
    findMatchingRule,
    formatGroupTitle,
    formatFixedTabLines,
    getGroupTitleIcon,
    isValidRule,
    matchesPattern,
    normalizeExactUrl,
    normalizeGroupIcon,
    normalizeGroupTitle,
    parseFixedTabLines,
    stripGroupIcon
  };
});
