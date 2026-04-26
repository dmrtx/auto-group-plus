(function initAutoGroupGrouping(root, factory) {
  root.AutoGroupGrouping = factory(root.AutoGroupConstants, root.AutoGroupRules);
})(globalThis, function createAutoGroupGrouping(constants, rulesApi) {
  const { MESSAGE_ACTIONS } = constants;
  const { findFixedTabPosition, findMatchingRule } = rulesApi;
  const pendingMerges = {};

  async function groupTab(tab) {
    try {
      if (!tab.url) return;

      chrome.action.setBadgeText({ text: '' });

      const { rules = [], settings = {} } = await chrome.storage.sync.get(['rules', 'settings']);

      const excludeWebApps = settings.excludeWebApps !== false;
      const enableCountdown = settings.mergeCountdown !== false;

      if (excludeWebApps) {
        const win = await chrome.windows.get(tab.windowId);
        if (win.type === 'popup' || win.type === 'app' || win.type === 'panel') {
          console.log(`[AutoGroup+] Skipping Web App/Popup window (ID: ${tab.windowId})`);
          return;
        }
      }

      const rule = findMatchingRule(rules, tab.url);
      if (!rule) return;

      chrome.action.setBadgeText({ text: 'MATCH' });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);

      const allGroups = await chrome.tabGroups.query({});
      console.log(`[AutoGroup+] Scanning ${allGroups.length} existing groups for match: "${rule.name}"`);

      const existingGroup = allGroups.find(group => {
        const groupTitle = (group.title || '').toLowerCase().trim();
        const ruleName = rule.name.toLowerCase().trim();
        return groupTitle === ruleName;
      });

      if (!existingGroup) {
        await createGroupForTab(tab, rule);
        await applyFixedPosition(tab.id, rule, tab.url);
        await applyGroupLayout(rules, settings, tab.windowId);
        return;
      }

      console.log(`[AutoGroup+] Found existing group: "${existingGroup.title}" (ID: ${existingGroup.id})`);

      if (existingGroup.color !== rule.color) {
        chrome.tabGroups.update(existingGroup.id, { color: rule.color });
      }

      await placeTabInGroup(tab, existingGroup, rule, enableCountdown);
      await applyGroupLayout(rules, settings, tab.windowId);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || '');
      if (msg.includes('No tab with id')) return;

      console.error('AutoGroup+ Error:', err);
      chrome.action.setBadgeText({ text: 'ERR' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }
  }

  async function placeTabInGroup(tab, existingGroup, rule, enableCountdown) {
    if (rule.merge) {
      if (tab.windowId !== existingGroup.windowId) {
        await mergeAcrossWindows(tab, existingGroup, rule, enableCountdown);
        return;
      }

      await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
      await applyFixedPosition(tab.id, rule, tab.url);
      return;
    }

    if (tab.windowId === existingGroup.windowId) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
      await applyFixedPosition(tab.id, rule, tab.url);
      return;
    }

    await createGroupForTab(tab, rule);
    await applyFixedPosition(tab.id, rule, tab.url);
  }

  async function mergeAcrossWindows(tab, existingGroup, rule, enableCountdown) {
    if (!enableCountdown) {
      await performMove(tab.id, existingGroup.id, existingGroup.windowId, findFixedTabPosition(rule, tab.url));
      return;
    }

    console.log(`[AutoGroup+] Starting merge countdown for Tab ${tab.id} -> Group ${existingGroup.id}`);

    let messageSent = false;
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: MESSAGE_ACTIONS.SHOW_COUNTDOWN,
        groupName: rule.name,
        seconds: 5
      });
      messageSent = true;
    } catch (e) {
      console.warn(`[AutoGroup+] Could not send message to tab ${tab.id} (restricted or unloaded). Moving immediately.`, e);
    }

    if (!messageSent) {
      await performMove(tab.id, existingGroup.id, existingGroup.windowId, findFixedTabPosition(rule, tab.url));
      return;
    }

    const timeoutId = setTimeout(async () => {
      console.log(`[AutoGroup+] Timeout reached. Moving tab ${tab.id}.`);
      await performMove(tab.id, existingGroup.id, existingGroup.windowId, findFixedTabPosition(rule, tab.url));
      delete pendingMerges[tab.id];
    }, 5000);

    pendingMerges[tab.id] = {
      timeoutId,
      groupId: existingGroup.id,
      windowId: existingGroup.windowId,
      targetIndex: findFixedTabPosition(rule, tab.url)
    };
  }

  async function createGroupForTab(tab, rule) {
    const groupId = await chrome.tabs.group({
      tabIds: tab.id,
      createProperties: { windowId: tab.windowId }
    });
    await chrome.tabGroups.update(groupId, { title: rule.name, color: rule.color });
  }

  async function applyFixedPosition(tabId, rule, tabUrl) {
    const targetIndex = findFixedTabPosition(rule, tabUrl);
    if (targetIndex === null) return;

    try {
      await moveTabWithinGroup(tabId, targetIndex);
    } catch (e) {
      console.warn(`[AutoGroup+] Could not move tab ${tabId} to fixed index ${targetIndex}.`, e);
    }
  }

  async function performMove(tabId, groupId, windowId, targetIndex = null, attempt = 1) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return;

      await chrome.tabs.move(tabId, { windowId, index: -1 });
      await chrome.tabs.group({ tabIds: tabId, groupId });

      if (targetIndex !== null) {
        await moveTabWithinGroup(tabId, targetIndex);
      }

      chrome.windows.update(windowId, { focused: true }).catch(() => {});
      chrome.tabs.update(tabId, { active: true }).catch(() => {});
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('Tabs cannot be edited right now') && attempt <= 3) {
        console.warn(`[AutoGroup+] Tab dragging detected. Retrying move (Attempt ${attempt}/3)...`);
        setTimeout(() => performMove(tabId, groupId, windowId, targetIndex, attempt + 1), 500 * attempt);
        return;
      }

      if (msg.includes('No tab with id')) return;

      console.error('Move failed', e);
    }
  }

  async function moveTabWithinGroup(tabId, targetIndex) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return;

    const groupTabs = await chrome.tabs.query({
      windowId: tab.windowId,
      groupId: tab.groupId
    });

    if (groupTabs.length === 0) return;

    groupTabs.sort((a, b) => a.index - b.index);

    const groupStartIndex = groupTabs[0].index;
    const clampedIndex = Math.min(targetIndex, groupTabs.length - 1);
    await chrome.tabs.move(tabId, { index: groupStartIndex + clampedIndex });
  }

  async function applyGroupLayout(rulesArg = null, settingsArg = null, windowId = null) {
    const settings = settingsArg || (await chrome.storage.sync.get('settings')).settings || {};
    if (settings.keepGroupOrder !== true && settings.groupsBeforeTabs !== true) return;

    const rules = Array.isArray(rulesArg)
      ? rulesArg
      : (await chrome.storage.sync.get('rules')).rules || [];

    const windows = windowId === null
      ? [...new Set((await chrome.tabs.query({})).map(tab => tab.windowId))]
      : [windowId];

    for (const currentWindowId of windows) {
      await applyGroupLayoutForWindow(currentWindowId, rules, settings);
    }
  }

  async function applyGroupLayoutForWindow(windowId, rules, settings) {
    const [groups, tabs] = await Promise.all([
      chrome.tabGroups.query({ windowId }),
      chrome.tabs.query({ windowId })
    ]);

    const groupEntries = groups
      .map(group => {
        const groupTabs = tabs
          .filter(tab => tab.groupId === group.id)
          .sort((a, b) => a.index - b.index);

        if (groupTabs.length === 0) return null;

        return {
          group,
          startIndex: groupTabs[0].index,
          tabCount: groupTabs.length,
          order: getGroupOrder(group, rules)
        };
      })
      .filter(Boolean);

    if (groupEntries.length === 0) return;

    const sortedGroups = groupEntries.slice().sort((a, b) => {
      if (settings.keepGroupOrder === true && a.order !== b.order) {
        return a.order - b.order;
      }

      return a.startIndex - b.startIndex;
    });

    const pinnedCount = tabs.filter(tab => tab.pinned).length;
    const startIndex = settings.groupsBeforeTabs === true
      ? pinnedCount
      : Math.min(...groupEntries.map(entry => entry.startIndex));

    let cursor = startIndex;
    for (const entry of sortedGroups) {
      await moveGroupTabs(entry, cursor);
      cursor += entry.tabCount;
    }
  }

  async function moveGroupTabs(entry, index) {
    await chrome.tabGroups.move(entry.group.id, { index }).catch((e) => {
      console.warn(`[AutoGroup+] Could not move group "${entry.group.title}" to index ${index}.`, e);
    });
  }

  function getGroupOrder(group, rules) {
    const normalizedTitle = normalizeGroupName(group.title);
    const ruleIndex = rules.findIndex(rule => normalizeGroupName(rule.name) === normalizedTitle);
    if (ruleIndex === -1) return Number.MAX_SAFE_INTEGER;

    const explicitOrder = rules[ruleIndex].groupOrder;
    return Number.isInteger(explicitOrder) && explicitOrder >= 0 ? explicitOrder : ruleIndex;
  }

  function normalizeGroupName(name) {
    return String(name || '').trim().toLowerCase();
  }

  function cancelPendingMerge(tabId) {
    const pending = pendingMerges[tabId];
    if (!pending) return false;

    clearTimeout(pending.timeoutId);
    delete pendingMerges[tabId];
    console.log(`[AutoGroup+] Merge CANCELLED for tab ${tabId}`);
    return true;
  }

  function confirmPendingMerge(tabId) {
    const pending = pendingMerges[tabId];
    if (!pending) return false;

    clearTimeout(pending.timeoutId);
    performMove(tabId, pending.groupId, pending.windowId, pending.targetIndex);
    delete pendingMerges[tabId];
    console.log(`[AutoGroup+] Merge CONFIRMED for tab ${tabId}`);
    return true;
  }

  function clearPendingMerge(tabId) {
    const pending = pendingMerges[tabId];
    if (!pending) return;

    clearTimeout(pending.timeoutId);
    delete pendingMerges[tabId];
  }

  return {
    applyGroupLayout,
    cancelPendingMerge,
    clearPendingMerge,
    confirmPendingMerge,
    groupTab
  };
});
