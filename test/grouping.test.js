const assert = require('node:assert/strict');
const test = require('node:test');

const { groupTab } = require('../grouping.js');

function installChromeMock({ tab, rules = [], groups = [], settings = {} }) {
  const calls = {
    groupedWith: [],
    tabUpdates: [],
    windowUpdates: [],
    ungrouped: []
  };
  const currentTab = { autoDiscardable: true, groupId: -1, index: 0, windowId: 1, ...tab };
  const currentGroups = groups.map(group => ({ ...group }));
  let nextGroupId = 100;

  global.chrome = {
    action: {
      setBadgeText: async () => {},
      setBadgeBackgroundColor: async () => {}
    },
    storage: {
      sync: {
        get: async () => ({ rules, settings })
      }
    },
    windows: {
      get: async () => ({ id: currentTab.windowId, type: 'normal' }),
      update: async (windowId, update) => {
        calls.windowUpdates.push({ windowId, update });
        return { id: windowId };
      }
    },
    tabs: {
      SPLIT_VIEW_ID_NONE: -1,
      get: async id => id === currentTab.id ? { ...currentTab } : Promise.reject(new Error('No tab')),
      query: async query => {
        if (Number.isInteger(query.groupId) && currentTab.groupId !== query.groupId) return [];
        if (Number.isInteger(query.windowId) && currentTab.windowId !== query.windowId) return [];
        return [{ ...currentTab }];
      },
      group: async ({ groupId, createProperties }) => {
        const resolvedGroupId = Number.isInteger(groupId) ? groupId : nextGroupId++;
        currentTab.groupId = resolvedGroupId;
        if (createProperties) currentTab.windowId = createProperties.windowId;
        calls.groupedWith.push(resolvedGroupId);
        if (!currentGroups.some(group => group.id === resolvedGroupId)) {
          currentGroups.push({ id: resolvedGroupId, title: '', color: 'grey', windowId: currentTab.windowId });
        }
        return resolvedGroupId;
      },
      ungroup: async id => {
        calls.ungrouped.push(id);
        currentTab.groupId = -1;
      },
      move: async (id, move) => {
        if (Number.isInteger(move.windowId)) currentTab.windowId = move.windowId;
        if (Number.isInteger(move.index) && move.index >= 0) currentTab.index = move.index;
        return { ...currentTab };
      },
      update: async (id, update) => {
        calls.tabUpdates.push({ id, update });
        Object.assign(currentTab, update);
        return { ...currentTab };
      },
      sendMessage: async () => {
        throw new Error('No content script');
      }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async query => currentGroups.filter(group => !Number.isInteger(query.windowId) || group.windowId === query.windowId),
      get: async id => {
        const group = currentGroups.find(candidate => candidate.id === id);
        if (!group) throw new Error('No group');
        return { ...group };
      },
      update: async (id, update) => {
        const group = currentGroups.find(candidate => candidate.id === id);
        Object.assign(group, update);
        return { ...group };
      },
      move: async () => {}
    }
  };

  return { calls, currentTab, currentGroups };
}

test('ordinary grouping leaves discarded tabs untouched', async () => {
  const state = installChromeMock({
    tab: { id: 1, url: 'https://example.com', discarded: true },
    rules: [{ name: 'Work', patterns: ['example.com'], color: 'blue' }]
  });

  await groupTab({ ...state.currentTab });

  assert.deepEqual(state.calls.groupedWith, []);
  assert.deepEqual(state.calls.tabUpdates, []);
  assert.deepEqual(state.calls.windowUpdates, []);
  assert.equal(state.currentTab.discarded, true);
});

test('rebuild can organize a discarded tab without activating or focusing it', async () => {
  const state = installChromeMock({
    tab: { id: 2, url: 'https://example.com', discarded: true },
    rules: [{ name: 'Work', patterns: ['example.com'], color: 'blue' }]
  });

  await groupTab({ ...state.currentTab }, { allowDiscarded: true, revealTab: false });

  assert.equal(state.calls.groupedWith.length, 1);
  assert.equal(state.calls.tabUpdates.some(call => call.update.active === true), false);
  assert.equal(state.calls.windowUpdates.some(call => call.update.focused === true), false);
  assert.equal(state.currentTab.discarded, true);
});

test('reconciliation removes an unmatched tab only from a managed group', async () => {
  const state = installChromeMock({
    tab: { id: 3, url: 'https://other.test', groupId: 7, autoDiscardable: false, discarded: true },
    groups: [{ id: 7, title: 'Work', color: 'blue', windowId: 1 }]
  });

  await groupTab({ ...state.currentTab }, {
    allowDiscarded: true,
    revealTab: false,
    ungroupIfUnmatched: true,
    managedGroupNames: ['Work']
  });

  assert.deepEqual(state.calls.ungrouped, [3]);
  assert.equal(state.currentTab.autoDiscardable, true);
  assert.equal(state.currentTab.discarded, true);
  assert.equal(state.calls.tabUpdates.some(call => call.update.active === true), false);
});

test('reconciliation does not change an unmatched loose tab sleep preference', async () => {
  const state = installChromeMock({
    tab: { id: 5, url: 'https://other.test', groupId: -1, autoDiscardable: false, discarded: true }
  });

  await groupTab({ ...state.currentTab }, {
    allowDiscarded: true,
    revealTab: false,
    ungroupIfUnmatched: true,
    managedGroupNames: ['Work']
  });

  assert.deepEqual(state.calls.tabUpdates, []);
  assert.equal(state.currentTab.autoDiscardable, false);
  assert.equal(state.currentTab.discarded, true);
});

test('a non-merge rule prefers the matching group in the current window', async () => {
  const state = installChromeMock({
    tab: { id: 4, url: 'https://example.com', windowId: 2 },
    rules: [{ name: 'Work', patterns: ['example.com'], color: 'blue', merge: false }],
    groups: [
      { id: 10, title: 'Work', color: 'blue', windowId: 1 },
      { id: 11, title: 'Work', color: 'blue', windowId: 2 }
    ]
  });

  await groupTab({ ...state.currentTab }, { revealTab: false });

  assert.deepEqual(state.calls.groupedWith, [11]);
});

test('concurrent events reuse the group created by the first operation', async () => {
  const state = installChromeMock({
    tab: { id: 6, url: 'https://example.com' },
    rules: [{ name: 'Work', patterns: ['example.com'], color: 'blue', merge: true }]
  });

  await Promise.all([
    groupTab({ ...state.currentTab }, { revealTab: false }),
    groupTab({ ...state.currentTab }, { revealTab: false })
  ]);

  assert.equal(state.currentGroups.filter(group => group.title === 'Work').length, 1);
  assert.deepEqual(state.calls.groupedWith, [100, 100]);
});
