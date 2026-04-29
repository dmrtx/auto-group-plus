(function initAutoGroupGrouping(root, factory) {
  root.AutoGroupGrouping = factory(root.AutoGroupConstants, root.AutoGroupRules);
})(globalThis, function createAutoGroupGrouping(constants, rulesApi) {
  const { MESSAGE_ACTIONS } = constants;
  const { findFixedTabPosition, findMatchingRule, formatGroupTitle, normalizeGroupTitle } = rulesApi;
  const pendingMerges = {};

  async function groupTab(tab, options = {}) {
    try {
      if (!tab.url) return;
      const revealTab = options.revealTab !== false;
      const allowDiscarded = options.allowDiscarded === true;

      if (tab.discarded && !allowDiscarded) {
        console.log(`[AutoGroup+] Skipping discarded tab ${tab.id}`);
        return;
      }

      chrome.action.setBadgeText({ text: '' });

      const { rules = [], settings = {} } = await chrome.storage.sync.get(['rules', 'settings']);

      const excludeWebApps = settings.excludeWebApps !== false;
      const enableCountdown = options.enableCountdown !== undefined
        ? options.enableCountdown
        : settings.mergeCountdown !== false;
      const preserveSplitView = settings.preserveSplitView !== false;

      if (excludeWebApps) {
        const win = await chrome.windows.get(tab.windowId);
        if (win.type === 'popup' || win.type === 'app' || win.type === 'panel') {
          console.log(`[AutoGroup+] Skipping Web App/Popup window (ID: ${tab.windowId})`);
          return;
        }
      }

      if (preserveSplitView && isSplitViewTab(tab)) {
        console.log(`[AutoGroup+] Skipping Split View tab ${tab.id}`);
        return;
      }

      const rule = findMatchingRule(rules, tab.url);
      if (!rule) return;

      chrome.action.setBadgeText({ text: 'MATCH' });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);

      const allGroups = await chrome.tabGroups.query({});
      console.log(`[AutoGroup+] Scanning ${allGroups.length} existing groups for match: "${rule.name}"`);

      const existingGroup = allGroups.find(group => {
        return normalizeGroupTitle(group.title) === normalizeGroupTitle(rule.name);
      });
      const targetWindowId = existingGroup && rule.merge && tab.windowId !== existingGroup.windowId
        ? existingGroup.windowId
        : tab.windowId;

      if (!existingGroup) {
        await createGroupForTab(tab, rule, { revealTab });
        await applyFixedPosition(tab.id, rule, tab.url);
        await applyGroupLayout(rules, settings, targetWindowId);
        if (revealTab) {
          await revealGroupedTab(tab.id, targetWindowId);
        }
        return;
      }

      console.log(`[AutoGroup+] Found existing group: "${existingGroup.title}" (ID: ${existingGroup.id})`);

      const desiredTitle = formatGroupTitle(rule);
      if (existingGroup.color !== rule.color || existingGroup.title !== desiredTitle) {
        chrome.tabGroups.update(existingGroup.id, { color: rule.color, title: desiredTitle });
      }

      await placeTabInGroup(tab, existingGroup, rule, enableCountdown, { revealTab });
      await applyGroupLayout(rules, settings, targetWindowId);
      if (revealTab) {
        await revealGroupedTab(tab.id, targetWindowId);
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err || '');
      if (msg.includes('No tab with id')) return;

      console.error('AutoGroup+ Error:', err);
      chrome.action.setBadgeText({ text: 'ERR' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    }
  }

  async function placeTabInGroup(tab, existingGroup, rule, enableCountdown, options = {}) {
    const revealTab = options.revealTab !== false;

    if (rule.merge) {
      if (tab.windowId !== existingGroup.windowId) {
        await mergeAcrossWindows(tab, existingGroup, rule, enableCountdown, { revealTab });
        return;
      }

      await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
      await applyFixedPosition(tab.id, rule, tab.url);
      if (revealTab) {
        await revealGroupedTab(tab.id, tab.windowId);
      }
      return;
    }

    if (tab.windowId === existingGroup.windowId) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
      await applyFixedPosition(tab.id, rule, tab.url);
      if (revealTab) {
        await revealGroupedTab(tab.id, tab.windowId);
      }
      return;
    }

    await createGroupForTab(tab, rule, { revealTab });
    await applyFixedPosition(tab.id, rule, tab.url);
  }

  async function mergeAcrossWindows(tab, existingGroup, rule, enableCountdown, options = {}) {
    const revealTab = options.revealTab !== false;

    if (!enableCountdown) {
      await performMove(
        tab.id,
        existingGroup.id,
        existingGroup.windowId,
        findFixedTabPosition(rule, tab.url),
        1,
        { revealTab }
      );
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
      await performMove(
        tab.id,
        existingGroup.id,
        existingGroup.windowId,
        findFixedTabPosition(rule, tab.url),
        1,
        { revealTab }
      );
      return;
    }

    const timeoutId = setTimeout(async () => {
      console.log(`[AutoGroup+] Timeout reached. Moving tab ${tab.id}.`);
      await performMove(
        tab.id,
        existingGroup.id,
        existingGroup.windowId,
        findFixedTabPosition(rule, tab.url),
        1,
        { revealTab }
      );
      delete pendingMerges[tab.id];
    }, 5000);

    pendingMerges[tab.id] = {
      timeoutId,
      groupId: existingGroup.id,
      windowId: existingGroup.windowId,
      targetIndex: findFixedTabPosition(rule, tab.url)
    };
  }

  async function createGroupForTab(tab, rule, options = {}) {
    const revealTab = options.revealTab !== false;
    const groupId = await chrome.tabs.group({
      tabIds: tab.id,
      createProperties: { windowId: tab.windowId }
    });
    await chrome.tabGroups.update(groupId, { title: formatGroupTitle(rule), color: rule.color });
    if (revealTab) {
      await revealGroupedTab(tab.id, tab.windowId);
    }
  }

  async function applyFixedPosition(tabId, rule, tabUrl) {
    const targetIndex = findFixedTabPosition(rule, tabUrl);
    if (targetIndex === null) return;

    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      const { settings = {} } = await chrome.storage.sync.get('settings');
      if (settings.preserveSplitView !== false && isSplitViewTab(tab)) return;
      await moveTabWithinGroup(tabId, targetIndex);
    } catch (e) {
      console.warn(`[AutoGroup+] Could not move tab ${tabId} to fixed index ${targetIndex}.`, e);
    }
  }

  async function performMove(tabId, groupId, windowId, targetIndex = null, attempt = 1, options = {}) {
    try {
      const revealTab = options.revealTab !== false;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return;
      const { settings = {} } = await chrome.storage.sync.get('settings');
      if (settings.preserveSplitView !== false && isSplitViewTab(tab)) return;

      await chrome.tabs.move(tabId, { windowId, index: -1 });
      await chrome.tabs.group({ tabIds: tabId, groupId });

      if (targetIndex !== null) {
        await moveTabWithinGroup(tabId, targetIndex);
      }

      if (revealTab) {
        await revealGroupedTab(tabId, windowId);
      }
    } catch (e) {
      const msg = e.message || '';
      if (msg.includes('Tabs cannot be edited right now') && attempt <= 3) {
        console.warn(`[AutoGroup+] Tab dragging detected. Retrying move (Attempt ${attempt}/3)...`);
        setTimeout(() => performMove(tabId, groupId, windowId, targetIndex, attempt + 1, options), 500 * attempt);
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

  async function revealGroupedTab(tabId, fallbackWindowId, attempt = 1) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return;

      const targetWindowId = Number.isInteger(tab.windowId) ? tab.windowId : fallbackWindowId;
      await chrome.windows.update(targetWindowId, { focused: true });
      const updatedTab = await chrome.tabs.update(tabId, { active: true });

      if (updatedTab && updatedTab.active) return;

      if (attempt < 3) {
        await wait(80 * attempt);
        await revealGroupedTab(tabId, targetWindowId, attempt + 1);
      }
    } catch (e) {
      if (attempt < 3) {
        await wait(80 * attempt);
        await revealGroupedTab(tabId, fallbackWindowId, attempt + 1);
        return;
      }

      console.warn(`[AutoGroup+] Could not reveal grouped tab ${tabId}.`, e);
    }
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

    if (settings.preserveSplitView !== false && tabs.some(isSplitViewTab)) {
      console.log(`[AutoGroup+] Skipping group layout in window ${windowId} because Split View is active.`);
      return;
    }

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
          orderMeta: getGroupOrder(group, rules)
        };
      })
      .filter(Boolean);

    if (groupEntries.length === 0) return;

    const sortedGroups = groupEntries.slice().sort((a, b) => {
      if (settings.keepGroupOrder === true) {
        if (a.orderMeta.hasExplicitOrder !== b.orderMeta.hasExplicitOrder) {
          return a.orderMeta.hasExplicitOrder ? -1 : 1;
        }

        if (a.orderMeta.order !== b.orderMeta.order) {
          return a.orderMeta.order - b.orderMeta.order;
        }
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
    if (ruleIndex === -1) {
      return {
        hasExplicitOrder: false,
        order: Number.MAX_SAFE_INTEGER
      };
    }

    const explicitOrder = rules[ruleIndex].groupOrder;
    return {
      hasExplicitOrder: Number.isInteger(explicitOrder) && explicitOrder >= 0,
      order: Number.isInteger(explicitOrder) && explicitOrder >= 0
        ? explicitOrder
        : Number.MAX_SAFE_INTEGER
    };
  }

  function normalizeGroupName(name) {
    return normalizeGroupTitle(name);
  }

  function isSplitViewTab(tab) {
    if (!tab || !Number.isInteger(tab.splitViewId)) return false;
    const noSplitId = Number.isInteger(chrome.tabs.SPLIT_VIEW_ID_NONE)
      ? chrome.tabs.SPLIT_VIEW_ID_NONE
      : -1;
    return tab.splitViewId !== noSplitId;
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

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  return {
    applyGroupLayout,
    cancelPendingMerge,
    clearPendingMerge,
    confirmPendingMerge,
    groupTab
  };
});
