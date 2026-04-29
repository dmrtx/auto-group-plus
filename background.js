importScripts('constants.js', 'rules.js', 'grouping.js', 'diagnostics.js');

const { MESSAGE_ACTIONS } = AutoGroupConstants;
const {
  applyGroupLayout,
  cancelPendingMerge,
  clearPendingMerge,
  confirmPendingMerge,
  groupTab
} = AutoGroupGrouping;
const diagnosticsApi = globalThis.AutoGroupDiagnostics;
const backgroundLogger = diagnosticsApi ? diagnosticsApi.createLogger('background') : null;

let layoutApplyTimer = null;
let isRebuildingOpenTabs = false;

// Consolidated Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  backgroundLogger?.debug('Received runtime message', {
    action: request && request.action,
    hasTabSender: Boolean(sender && sender.tab)
  });

  // 1. CONTENT SCRIPT MESSAGES (Cancel/Confirm Merge)
  if (request.action === MESSAGE_ACTIONS.CANCEL_MERGE || request.action === MESSAGE_ACTIONS.CONFIRM_MERGE) {
    if (!sender.tab) return;
    const tabId = sender.tab.id;

    if (request.action === MESSAGE_ACTIONS.CANCEL_MERGE) {
      cancelPendingMerge(tabId);
    } else if (request.action === MESSAGE_ACTIONS.CONFIRM_MERGE) {
      confirmPendingMerge(tabId);
    }
    return;
  }

  // 2. POPUP MESSAGES (Manual Regroup)
  if (request.action === MESSAGE_ACTIONS.REGROUP_TAB && request.tabId) {
    console.log(`[AutoGroup+] Received manual regroup request for tab ${request.tabId}`);
    chrome.tabs.get(request.tabId).then((tab) => {
      groupTab(tab);
    }).catch(err => console.error("Could not get tab for regroup:", err));
    return;
  }

  // 3. OPTIONS PAGE / OVERVIEW REQUEST
  if (request.action === MESSAGE_ACTIONS.GET_OVERVIEW) {
    (async () => {
      try {
        const [{ rules = [], settings = {} }, groups] = await Promise.all([
          chrome.storage.sync.get(['rules', 'settings']),
          chrome.tabGroups.query({})
        ]);
        sendResponse({ rules, settings, groups });
      } catch (e) {
        console.error('[AutoGroup+] Failed to build overview', e);
        sendResponse({ rules: [], settings: {}, groups: [], error: e && e.message });
      }
    })();
    // Keep the message channel open for async response
    return true;
  }

  // 4. OPTIONS PAGE / APPLY SAVED GROUP ORDER
  if (request.action === MESSAGE_ACTIONS.APPLY_GROUP_LAYOUT) {
    (async () => {
      try {
        await applyGroupLayout();
        sendResponse({ ok: true });
      } catch (e) {
        console.error('[AutoGroup+] Failed to apply group layout', e);
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }

  // 5. OPTIONS PAGE / REBUILD ALL GROUPS
  if (request.action === MESSAGE_ACTIONS.REBUILD_GROUPS) {
    (async () => {
      try {
        const processed = await rebuildOpenTabs('manual rebuild');
        sendResponse({ ok: true, processed });
      } catch (e) {
        console.error('[AutoGroup+] Failed to rebuild groups', e);
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }
});

function scheduleSavedLayout(reason) {
  clearTimeout(layoutApplyTimer);
  layoutApplyTimer = setTimeout(() => {
    layoutApplyTimer = null;
    applySavedLayout(reason);
  }, 150);
}

async function applySavedLayout(reason) {
  try {
    await applyGroupLayout();
  } catch (e) {
    console.warn(`[AutoGroup+] Could not apply saved layout on ${reason}.`, e);
  }
}

async function rebuildOpenTabs(reason) {
  if (isRebuildingOpenTabs) return 0;

  isRebuildingOpenTabs = true;
  try {
    const [{ rules = [], settings = {} }, allTabs] = await Promise.all([
      chrome.storage.sync.get(['rules', 'settings']),
      chrome.tabs.query({})
    ]);

    for (const tab of allTabs) {
      await groupTab(tab, {
        allowDiscarded: true,
        enableCountdown: false,
        revealTab: false
      });
    }

    await applyGroupLayout(rules, settings);
    return allTabs.length;
  } finally {
    isRebuildingOpenTabs = false;
  }
}

function initializeExtension(reason) {
  try {
    backgroundLogger?.info('Initializing extension', { reason });
    scheduleSavedLayout(reason);
  } catch (error) {
    backgroundLogger?.error('Initialization failed', { reason, error });
    console.error(`[AutoGroup+] Initialization failed during ${reason}.`, error);
  }
}

// Initialize dynamic icons on startup / install
chrome.runtime.onStartup.addListener(() => {
  initializeExtension('startup');
});

chrome.runtime.onInstalled.addListener((details) => {
  initializeExtension(details?.reason || 'install/update');
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;

  if (changes.rules || changes.settings) {
    scheduleSavedLayout('storage change');
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (Object.prototype.hasOwnProperty.call(changeInfo, 'splitViewId')) {
    if (isSplitViewIdActive(changeInfo.splitViewId)) {
      clearPendingMerge(tabId);
      return;
    }

    groupTab(tab);
    return;
  }

  if (changeInfo.url) {
    groupTab(tab);
  }
});

// Listen for new tabs
chrome.tabs.onCreated.addListener((tab) => {
  groupTab(tab);
});

// Clean up pending merges if tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  clearPendingMerge(tabId);
});

initializeExtension('service worker load');

function isSplitViewIdActive(splitViewId) {
  if (!Number.isInteger(splitViewId)) return false;
  const noSplitId = Number.isInteger(chrome.tabs.SPLIT_VIEW_ID_NONE)
    ? chrome.tabs.SPLIT_VIEW_ID_NONE
    : -1;
  return splitViewId !== noSplitId;
}
