// Helper to match URL against patterns
function matchesPattern(urlStr, pattern) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    const cleanPattern = pattern.toLowerCase().trim();

    // Exact match
    if (urlStr === cleanPattern) return true;

    // Domain & Subdomains (*.example.com)
    if (cleanPattern.startsWith('*.')) {
      const domain = cleanPattern.slice(2);
      return hostname === domain || hostname.endsWith('.' + domain);
    }

    // Domain only (example.com) -> should match example.com AND www.example.com
    if (hostname === cleanPattern) return true;
    if (hostname === 'www.' + cleanPattern) return true;

    // Fallback simple glob-ish matching
    const regexPattern = cleanPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(urlStr) || regex.test(hostname);
  } catch (e) {
    console.error('Pattern matching error', e);
    return false;
  }
}

// Main logic to group a tab
// Store pending merges: { tabId: { timeoutId, groupId, windowId } }
const pendingMerges = {};

// Main logic to group a tab
async function groupTab(tab) {
  try {
    if (!tab.url) return;

    // Clear badge initially
    chrome.action.setBadgeText({ text: "" });

    const { rules = [], settings = {} } = await chrome.storage.sync.get(['rules', 'settings']);

    // Default settings
    const excludeWebApps = settings.excludeWebApps !== false;
    const enableCountdown = settings.mergeCountdown !== false;

    // 1. Check Web App Exclusion
    if (excludeWebApps) {
      const win = await chrome.windows.get(tab.windowId);
      if (win.type === 'popup' || win.type === 'app' || win.type === 'panel') {
        console.log(`[AutoGroup+] Skipping Web App/Popup window (ID: ${tab.windowId})`);
        return;
      }
    }

    for (const rule of rules) {
      if (rule.patterns.some(p => matchesPattern(tab.url, p))) {

        // Show badge match
        chrome.action.setBadgeText({ text: "MATCH" });
        chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
        setTimeout(() => chrome.action.setBadgeText({ text: "" }), 2000);

        // Find existing group GLOBALLY
        const allGroups = await chrome.tabGroups.query({});

        console.log(`[AutoGroup+] Scanning ${allGroups.length} existing groups for match: "${rule.name}"`);

        // Match primarily on TITLE (case-insensitive, trimmed)
        const existingGroup = allGroups.find(g => {
          const groupTitle = (g.title || "").toLowerCase().trim();
          const ruleName = rule.name.toLowerCase().trim();
          return groupTitle === ruleName;
        });

        if (existingGroup) {
          console.log(`[AutoGroup+] Found existing group: "${existingGroup.title}" (ID: ${existingGroup.id})`);

          // Optionally update color if it doesn't match
          if (existingGroup.color !== rule.color) {
            chrome.tabGroups.update(existingGroup.id, { color: rule.color });
          }

          // Merge logic
          if (rule.merge) {
            // Check if tab is in a DIFFERENT window
            if (tab.windowId !== existingGroup.windowId) {

              if (enableCountdown) {
                // Start Countdown Merge
                console.log(`[AutoGroup+] Starting merge countdown for Tab ${tab.id} -> Group ${existingGroup.id}`);

                let messageSent = false;
                // Notify Content Script
                try {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'SHOW_COUNTDOWN',
                    groupName: rule.name,
                    seconds: 5
                  });
                  messageSent = true;
                } catch (e) {
                  // Fallback if content script not ready (e.g. before reload OR restricted chrome:// url)
                  // Move immediately to avoid "silent ghost move" after 5s
                  console.warn(`[AutoGroup+] Could not send message to tab ${tab.id} (restricted or unloaded). Moving immediately.`, e);
                  messageSent = false;
                }

                if (messageSent) {
                  // Set Timeout only if user actually sees the popup
                  const timeoutId = setTimeout(async () => {
                    console.log(`[AutoGroup+] Timeout reached. Moving tab ${tab.id}.`);
                    await performMove(tab.id, existingGroup.id, existingGroup.windowId);
                    delete pendingMerges[tab.id];
                  }, 5000);

                  pendingMerges[tab.id] = {
                    timeoutId,
                    groupId: existingGroup.id,
                    windowId: existingGroup.windowId
                  };
                } else {
                  // Move immediately
                  await performMove(tab.id, existingGroup.id, existingGroup.windowId);
                }

              } else {
                // Move immediately
                await performMove(tab.id, existingGroup.id, existingGroup.windowId);
              }

            } else {
              // Same window, just group
              await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
            }
          } else {
            // Non-merge: Only join if in SAME window
            if (tab.windowId === existingGroup.windowId) {
              await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
            } else {
              // Create new in current window because we can't merge to other
              const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
              await chrome.tabGroups.update(groupId, { title: rule.name, color: rule.color });
            }
          }
        } else {
          // Create new group
          const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
          await chrome.tabGroups.update(groupId, { title: rule.name, color: rule.color });
        }
        return; // Stop at first matching rule
      }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err || "");
    // Ignore noisy "No tab with id" errors that happen when a tab is closed mid-process
    if (msg.includes("No tab with id")) {
      return;
    }
    console.error("AutoGroup+ Error:", err);
    chrome.action.setBadgeText({ text: "ERR" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  }
}

async function performMove(tabId, groupId, windowId, attempt = 1) {
  try {
    // Verify tab exists first to avoid "No tab with id" noise
    const tabCallback = await chrome.tabs.get(tabId).catch(() => null);
    if (!tabCallback) return; // Tab already closed

    await chrome.tabs.move(tabId, { windowId: windowId, index: -1 });
    await chrome.tabs.group({ tabIds: tabId, groupId: groupId });

    // Focus the window
    chrome.windows.update(windowId, { focused: true }).catch(() => { });
    chrome.tabs.update(tabId, { active: true }).catch(() => { });

  } catch (e) {
    const msg = e.message || "";
    // Retry if user is dragging a tab
    if (msg.includes("Tabs cannot be edited right now") && attempt <= 3) {
      console.warn(`[AutoGroup+] Tab dragging detected. Retrying move (Attempt ${attempt}/3)...`);
      setTimeout(() => performMove(tabId, groupId, windowId, attempt + 1), 500 * attempt);
      return;
    }

    // Ignore "No tab with id" as it means the tab was closed during process
    if (msg.includes("No tab with id")) return;

    console.error("Move failed", e);
  }
}

// Consolidated Message Listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 1. CONTENT SCRIPT MESSAGES (Cancel/Confirm Merge)
  if (request.action === 'CANCEL_MERGE' || request.action === 'CONFIRM_MERGE') {
    if (!sender.tab) return;
    const tabId = sender.tab.id;
    const pending = pendingMerges[tabId];

    if (!pending) return;

    if (request.action === 'CANCEL_MERGE') {
      clearTimeout(pending.timeoutId);
      delete pendingMerges[tabId];
      console.log(`[AutoGroup+] Merge CANCELLED for tab ${tabId}`);
    } else if (request.action === 'CONFIRM_MERGE') {
      clearTimeout(pending.timeoutId);
      performMove(tabId, pending.groupId, pending.windowId);
      delete pendingMerges[tabId];
      console.log(`[AutoGroup+] Merge CONFIRMED for tab ${tabId}`);
    }
    return;
  }

  // 2. POPUP MESSAGES (Manual Regroup)
  if (request.action === 'REGROUP_TAB' && request.tabId) {
    console.log(`[AutoGroup+] Received manual regroup request for tab ${request.tabId}`);
    chrome.tabs.get(request.tabId).then((tab) => {
      groupTab(tab);
    }).catch(err => console.error("Could not get tab for regroup:", err));
    return;
  }
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
  if (pendingMerges[tabId]) {
    clearTimeout(pendingMerges[tabId].timeoutId);
    delete pendingMerges[tabId];
  }
});
