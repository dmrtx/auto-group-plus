(function initAutoGroupDiagnostics(root, factory) {
  const api = factory(root);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.AutoGroupDiagnostics = api;
})(globalThis, function createAutoGroupDiagnostics(root) {
  const LOG_KEY = 'debugLogs';
  const MAX_LOGS = 200;

  function createLogger(scope) {
    const safeScope = String(scope || 'app');

    async function write(level, message, details) {
      const entry = {
        scope: safeScope,
        level: String(level || 'info'),
        message: String(message || ''),
        details: serialize(details),
        timestamp: new Date().toISOString()
      };

      writeConsole(entry);
      await writeStorage(entry);
      return entry;
    }

    return {
      debug(message, details) {
        return write('debug', message, details);
      },
      info(message, details) {
        return write('info', message, details);
      },
      warn(message, details) {
        return write('warn', message, details);
      },
      error(message, details) {
        return write('error', message, details);
      }
    };
  }

  async function readLogs() {
    try {
      if (!root.chrome || !chrome.storage || !chrome.storage.local) return [];
      const result = await chrome.storage.local.get(LOG_KEY);
      return Array.isArray(result[LOG_KEY]) ? result[LOG_KEY] : [];
    } catch (error) {
      console.warn('[AutoGroup+][diagnostics] Could not read logs.', error);
      return [];
    }
  }

  async function clearLogs() {
    try {
      if (!root.chrome || !chrome.storage || !chrome.storage.local) return;
      await chrome.storage.local.remove(LOG_KEY);
    } catch (error) {
      console.warn('[AutoGroup+][diagnostics] Could not clear logs.', error);
    }
  }

  function writeConsole(entry) {
    const method = entry.level === 'error'
      ? 'error'
      : entry.level === 'warn'
        ? 'warn'
        : 'log';
    console[method](`[AutoGroup+][${entry.scope}] ${entry.message}`, entry.details);
  }

  async function writeStorage(entry) {
    try {
      if (!root.chrome || !chrome.storage || !chrome.storage.local) return;
      const result = await chrome.storage.local.get(LOG_KEY);
      const existing = Array.isArray(result[LOG_KEY]) ? result[LOG_KEY] : [];
      existing.push(entry);
      const trimmed = existing.slice(-MAX_LOGS);
      await chrome.storage.local.set({ [LOG_KEY]: trimmed });
    } catch (error) {
      console.warn('[AutoGroup+][diagnostics] Could not persist log.', error);
    }
  }

  function serialize(value) {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack || ''
      };
    }

    if (typeof value === 'undefined') {
      return null;
    }

    try {
      return JSON.parse(JSON.stringify(value));
    } catch (error) {
      return { fallback: String(value) };
    }
  }

  return {
    clearLogs,
    createLogger,
    readLogs
  };
});
