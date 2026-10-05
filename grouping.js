(function initAutoGroupGrouping(root, factory) {
  const constants = root.AutoGroupConstants || (typeof module === 'object' && module.exports ? require('./constants.js') : null);
  const rules = root.AutoGroupRules || (typeof module === 'object' && module.exports ? require('./rules.js') : null);
  const api = factory(constants, rules);

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  root.AutoGroupGrouping = api;
})(globalThis, function createAutoGroupGrouping(constants, rulesApi) {
  const { MESSAGE_ACTIONS } = constants;
  const { findFixedTabPosition, findMatchingRule, formatGroupTitle, normalizeGroupTitle } = rulesApi;
  const pendingMerges = {};
  const extensionTabActions = new Map();
  const EXTENSION_ACTION_TTL_MS = 4000;
  let groupingQueue = Promise.resolve();

  function enqueueGroupingOperation(callback) {
    const operation = groupingQueue.then(callback);
    groupingQueue = operation.catch(() => {});
    return operation;
  }

  function groupTab(tab, options = {}) {
    // Cancel immediately, even while an earlier move is waiting to retry.
    if (tab && Number.isInteger(tab.id)) clearPendingMerge(tab.id);
    return enqueueGroupingOperation(() => reconcileTab(tab, options));
  }

  async function reconcileTab(tab, options = {}) {
    try {
      if (!tab || !Number.isInteger(tab.id)) return;
      // A previous queued reconciliation may have started a countdown meanwhile.
      clearPendingMerge(tab.id);
      tab = await chrome.tabs.get(tab.id).catch(() => tab);
      if (!tab.url) return;
      const revealTab = options.revealTab !== false && tab.discarded !== true;
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
      if (!rule) {
        clearPendingMerge(tab.id);
        await reconcileUnmatchedTab(tab, rules, options);
        return;
      }

      chrome.action.setBadgeText({ text: 'MATCH' });
      chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2000);

      const allGroups = await chrome.tabGroups.query({});
      console.log(`[AutoGroup+] Scanning ${allGroups.length} existing groups for match: "${rule.name}"`);

      const matchingGroups = allGroups.filter(group => {
        return normalizeGroupTitle(group.title) === normalizeGroupTitle(rule.name);
      });
      const existingGroup = matchingGroups.find(group => group.windowId === tab.windowId) || matchingGroups[0];
      const targetWindowId = existingGroup && rule.merge && tab.windowId !== existingGroup.windowId
        ? existingGroup.windowId
        : tab.windowId;

      if (!existingGroup) {
        await createGroupForTab(tab, rule, { revealTab });
        await applyFixedPosition(tab.id, rule, tab.url);
        await applySleepProtectionToTab(tab.id, rule);
        await applyGroupLayout(rules, settings, targetWindowId);
        if (revealTab) {
          await revealGroupedTab(tab.id, targetWindowId);
        }
        return;
      }

      console.log(`[AutoGroup+] Found existing group: "${existingGroup.title}" (ID: ${existingGroup.id})`);

      const desiredTitle = formatGroupTitle(rule);
      if (existingGroup.color !== rule.color || existingGroup.title !== desiredTitle) {
        await chrome.tabGroups.update(existingGroup.id, { color: rule.color, title: desiredTitle });
      }

      await placeTabInGroup(tab, existingGroup, rule, enableCountdown, { revealTab });
      await applySleepProtectionToTab(tab.id, rule);
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

  async function reconcileUnmatchedTab(tab, rules, options) {
    if (options.ungroupIfUnmatched !== true) return;
    if (!Number.isInteger(tab.groupId) || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
      return;
    }

    const group = await chrome.tabGroups.get(tab.groupId).catch(() => null);
    if (!group) return;

    const managedNames = new Set([
      ...rules.map(rule => normalizeGroupTitle(rule && rule.name)),
      ...(Array.isArray(options.managedGroupNames) ? options.managedGroupNames.map(normalizeGroupTitle) : [])
    ].filter(Boolean));

    if (!managedNames.has(normalizeGroupTitle(group.title))) return;

    markExtensionTabAction(tab.id, 'ungroup-unmatched');
    await chrome.tabs.ungroup(tab.id);
    await applySleepProtectionToTab(tab.id, { protectFromSleep: false });
  }

  async function placeTabInGroup(tab, existingGroup, rule, enableCountdown, options = {}) {
    const revealTab = options.revealTab !== false;

    if (rule.merge) {
      if (tab.windowId !== existingGroup.windowId) {
        await mergeAcrossWindows(tab, existingGroup, rule, enableCountdown, { revealTab });
        return;
      }

      markExtensionTabAction(tab.id, 'group-existing');
      await chrome.tabs.group({ tabIds: tab.id, groupId: existingGroup.id });
      await applyFixedPosition(tab.id, rule, tab.url);
      if (revealTab) {
        await revealGroupedTab(tab.id, tab.windowId);
      }
      return;
    }

    if (tab.windowId === existingGroup.windowId) {
      markExtensionTabAction(tab.id, 'group-existing');
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
    clearPendingMerge(tab.id);

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

    const pending = {
      groupId: existingGroup.id,
      windowId: existingGroup.windowId,
      sourceWindowId: tab.windowId,
      sourceGroupId: tab.groupId,
      url: tab.url,
      ruleName: rule.name,
      revealTab
    };
    pending.timeoutId = setTimeout(() => {
      console.log(`[AutoGroup+] Timeout reached. Moving tab ${tab.id}.`);
      enqueueGroupingOperation(() => performPendingMerge(tab.id, pending));
    }, 5000);

    pendingMerges[tab.id] = pending;
  }

  async function performPendingMerge(tabId, pending) {
    if (pendingMerges[tabId] !== pending) return;
    clearTimeout(pending.timeoutId);
    try {
      await performMove(tabId, pending.groupId, pending.windowId, null, 1, {
        revealTab: pending.revealTab,
        pendingMerge: pending
      });
    } finally {
      if (pendingMerges[tabId] === pending) clearPendingMerge(tabId);
    }
  }

  async function createGroupForTab(tab, rule, options = {}) {
    const revealTab = options.revealTab !== false;
    markExtensionTabAction(tab.id, 'group-create');
    const groupId = await chrome.tabs.group({
      tabIds: tab.id,
      createProperties: { windowId: tab.windowId }
    });
    await chrome.tabGroups.update(groupId, { title: formatGroupTitle(rule), color: rule.color });
    if (revealTab) {
      await revealGroupedTab(tab.id, tab.windowId);
    }
  }

  async function applySleepProtectionToTab(tabId, rule) {
    if (!Number.isInteger(tabId) || !rule) return;

    const shouldProtect = rule.protectFromSleep === true;

    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return;
      if (tab.autoDiscardable === !shouldProtect) return;

      markExtensionTabAction(tabId, shouldProtect ? 'protect-from-sleep' : 'allow-sleep');
      await chrome.tabs.update(tabId, { autoDiscardable: !shouldProtect });
    } catch (e) {
      console.warn(`[AutoGroup+] Could not update sleep protection for tab ${tabId}.`, e);
    }
  }

  async function enforceSleepProtectionForTab(tabId, groupId = null) {
    if (!Number.isInteger(tabId)) return;

    try {
      const [tab, { rules = [] }] = await Promise.all([
        chrome.tabs.get(tabId).catch(() => null),
        chrome.storage.sync.get(['rules'])
      ]);

      if (!tab) return;

      const effectiveGroupId = Number.isInteger(groupId) ? groupId : tab.groupId;
      if (!Number.isInteger(effectiveGroupId) || effectiveGroupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
        if (tab.autoDiscardable === false) {
          markExtensionTabAction(tabId, 'allow-sleep');
          await chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
        }
        return;
      }

      const group = await chrome.tabGroups.get(effectiveGroupId).catch(() => null);
      if (!group) return;

      const matchingRule = Array.isArray(rules)
        ? rules.find(rule => normalizeGroupTitle(group.title) === normalizeGroupTitle(rule.name))
        : null;

      await applySleepProtectionToTab(tabId, matchingRule || { protectFromSleep: false });
    } catch (e) {
      console.warn(`[AutoGroup+] Could not enforce sleep protection for tab ${tabId}.`, e);
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
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) return;
      const revealTab = options.revealTab !== false && tab.discarded !== true;
      const { settings = {} } = await chrome.storage.sync.get('settings');
      if (settings.preserveSplitView !== false && isSplitViewTab(tab)) return;

      if (options.pendingMerge) {
        const pending = options.pendingMerge;
        const [group, { rules = [] }] = await Promise.all([
          chrome.tabGroups.get(groupId).catch(() => null),
          chrome.storage.sync.get('rules')
        ]);
        const rule = findMatchingRule(rules, tab.url);
        if (pendingMerges[tabId] !== pending || !group || !rule ||
            tab.discarded === true || tab.url !== pending.url || rule.merge !== true ||
            normalizeGroupTitle(rule.name) !== normalizeGroupTitle(pending.ruleName) ||
            normalizeGroupTitle(group.title) !== normalizeGroupTitle(rule.name) ||
            group.windowId !== pending.windowId) return;

        if (attempt === 1 && (tab.windowId !== pending.sourceWindowId || tab.groupId !== pending.sourceGroupId)) return;
        targetIndex = findFixedTabPosition(rule, tab.url);
      }

      markExtensionTabAction(tabId, 'move-cross-window');
      await chrome.tabs.move(tabId, { windowId, index: -1 });
      markExtensionTabAction(tabId, 'group-cross-window');
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
        await wait(500 * attempt);
        return performMove(tabId, groupId, windowId, targetIndex, attempt + 1, options);
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
    markExtensionTabAction(tabId, 'move-within-group');
    await chrome.tabs.move(tabId, { index: groupStartIndex + clampedIndex });
  }

  async function revealGroupedTab(tabId, fallbackWindowId, attempt = 1) {
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.discarded === true) return;

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
          tabIds: groupTabs.map(tab => tab.id).filter(Number.isInteger),
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
    markExtensionTabAction(entry.tabIds, 'move-group-layout');
    await chrome.tabGroups.move(entry.group.id, { index }).catch((e) => {
      console.warn(`[AutoGroup+] Could not move group "${entry.group.title}" to index ${index}.`, e);
    });
  }

  function markExtensionTabAction(tabIds, reason = 'extension-action') {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
    const expiresAt = Date.now() + EXTENSION_ACTION_TTL_MS;

    for (const tabId of ids) {
      if (!Number.isInteger(tabId)) continue;
      extensionTabActions.set(tabId, { reason, expiresAt });
    }
  }

  function hasRecentExtensionTabAction(tabId) {
    cleanupExpiredExtensionTabActions();
    const action = extensionTabActions.get(tabId);
    return Boolean(action && action.expiresAt > Date.now());
  }

  function clearExtensionTabAction(tabId) {
    extensionTabActions.delete(tabId);
  }

  function cleanupExpiredExtensionTabActions() {
    const now = Date.now();
    for (const [tabId, action] of extensionTabActions.entries()) {
      if (!action || action.expiresAt <= now) {
        extensionTabActions.delete(tabId);
      }
    }
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
    enqueueGroupingOperation(() => performPendingMerge(tabId, pending));
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
    enforceSleepProtectionForTab,
    cancelPendingMerge,
    clearExtensionTabAction,
    clearPendingMerge,
    confirmPendingMerge,
    groupTab,
    hasRecentExtensionTabAction
  };
});
