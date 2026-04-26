importScripts('constants.js', 'rules.js', 'grouping.js');

const { MESSAGE_ACTIONS } = AutoGroupConstants;
const {
  cancelPendingMerge,
  clearPendingMerge,
  confirmPendingMerge,
  groupTab
} = AutoGroupGrouping;

// Generate dynamic action icons so they look good on any theme
function createPlusIcon(size) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Transparent background
  ctx.clearRect(0, 0, size, size);

  // Blue rounded square background
  const radius = Math.round(size * 0.22);
  const margin = Math.round(size * 0.08);
  const x = margin;
  const y = margin;
  const w = size - margin * 2;
  const h = size - margin * 2;

  ctx.fillStyle = '#1D8CF8';
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  ctx.fill();

  // White plus
  const barThickness = Math.round(size * 0.18);
  const center = size / 2;
  ctx.fillStyle = '#FFFFFF';

  // Vertical bar
  ctx.fillRect(center - barThickness / 2, y + radius * 0.7, barThickness, h - radius * 1.4);

  // Horizontal bar
  ctx.fillRect(x + radius * 0.7, center - barThickness / 2, w - radius * 1.4, barThickness);

  return ctx.getImageData(0, 0, size, size);
}

function setDynamicIcons() {
  const sizes = [16, 32, 48, 64, 128];
  const imageData = {};
  for (const size of sizes) {
    const data = createPlusIcon(size);
    if (data) {
      imageData[size] = data;
    }
  }
  if (Object.keys(imageData).length > 0) {
    chrome.action.setIcon({ imageData }).catch?.(() => {});
  }
}

// Consolidated Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

  // 4. OPTIONS PAGE / REBUILD ALL GROUPS
  if (request.action === MESSAGE_ACTIONS.REBUILD_GROUPS) {
    (async () => {
      try {
        const allTabs = await chrome.tabs.query({});
        for (const tab of allTabs) {
          await groupTab(tab);
        }
        sendResponse({ ok: true, processed: allTabs.length });
      } catch (e) {
        console.error('[AutoGroup+] Failed to rebuild groups', e);
        sendResponse({ ok: false, error: e && e.message });
      }
    })();
    return true;
  }
});

// Initialize dynamic icons on startup / install
chrome.runtime.onStartup.addListener(() => {
  setDynamicIcons();
});

chrome.runtime.onInstalled.addListener(() => {
  setDynamicIcons();
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
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
