const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setImmediate } = require('node:timers/promises');
const vm = require('node:vm');

function createExtension({ tab = {}, rules = [], groups = [] } = {}) {
  const state = {
    tab: { id: 1, url: 'https://alpha.test', autoDiscardable: true, discarded: false, groupId: -1, windowId: 1, index: 0, ...tab },
    rules: structuredClone(rules), groups: structuredClone(groups),
    moves: [], updates: [], saved: [], alerts: [], messages: []
  };
  const timers = new Map();
  const elements = new Map();
  let timerId = 0;
  const event = () => ({ addListener() {} });
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      value: '', checked: false, hidden: true, style: {}, dataset: {},
      classList: { add() {}, remove() {}, toggle() {} },
      append() {}, appendChild() {}, replaceChildren() {}, reset() {},
      querySelector() { return { style: {} }; }
    });
    return elements.get(id);
  }
  const context = vm.createContext({
    URL, Date, Map, Set, Promise, console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    alert(message) { state.alerts.push(message); },
    window: { addEventListener() {}, close() {} },
    document: {
      addEventListener() {}, getElementById: element,
      querySelectorAll: () => [], createElement: () => element(Symbol())
    },
    chrome: {
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: { sync: {
        get: async () => structuredClone({ rules: state.rules, settings: {} }),
        set: async value => { state.saved.push(structuredClone(value)); state.rules = structuredClone(value.rules || state.rules); }
      }, onChanged: event() },
      runtime: {
        onMessage: event(), onStartup: event(), onInstalled: event(),
        sendMessage: async message => { state.messages.push(structuredClone(message)); return { ok: true }; }
      },
      windows: { get: async () => ({ type: 'normal' }), update: async (id, update) => { state.updates.push({ windowId: id, ...update }); return {}; } },
      tabs: {
        get: async () => ({ ...state.tab }),
        query: async (query, callback) => { const tabs = [{ ...state.tab }]; if (callback) callback(tabs); return tabs; },
        update: async (id, update) => { state.updates.push({ id, ...update }); Object.assign(state.tab, update); return { ...state.tab }; },
        move: async (id, move) => { state.moves.push({ id, ...move }); if (move.windowId !== undefined) state.tab.windowId = move.windowId; return { ...state.tab }; },
        group: async ({ groupId, createProperties }) => {
          if (groupId === undefined) { groupId = 100 + state.groups.length; state.groups.push({ id: groupId, windowId: createProperties.windowId, title: '', color: 'grey' }); }
          state.tab.groupId = groupId; return groupId;
        },
        ungroup: async () => { state.tab.groupId = -1; }, sendMessage: async () => {},
        onCreated: event(), onUpdated: event(), onRemoved: event(), onMoved: event(), onAttached: event(), onDetached: event()
      },
      tabGroups: {
        TAB_GROUP_ID_NONE: -1,
        query: async () => structuredClone(state.groups),
        get: async id => structuredClone(state.groups.find(group => group.id === id)),
        update: async (id, update) => { state.updates.push({ groupId: id, ...update }); Object.assign(state.groups.find(group => group.id === id), update); return {}; },
        move: async () => {}
      }
    }
  });
  function load(name) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context, { filename: name });
  }
  context.importScripts = (...names) => names.forEach(load);
  load('constants.js'); load('rules.js'); load('grouping.js');
  async function fireTimer(ms) {
    const timer = [...timers.entries()].find(([, timer]) => timer.ms === ms);
    if (!timer) return;
    timers.delete(timer[0]);
    timer[1].fn();
    await setImmediate();
  }
  return { state, context, load, element, fireTimer, fireCountdown: () => fireTimer(5000) };
}

function createMerge() {
  return createExtension({
    rules: [{ id: 'a', name: 'Alpha', patterns: ['alpha.test'], color: 'blue', merge: true }],
    groups: [{ id: 10, title: 'Alpha', color: 'blue', windowId: 2 }]
  });
}

async function startCountdown(extension) {
  await extension.context.AutoGroupGrouping.groupTab({ ...extension.state.tab }, { revealTab: false });
}

test('navigation to a different managed group cancels the earlier cross-window merge', async () => {
  const extension = createMerge();
  extension.state.rules.push({ id: 'b', name: 'Beta', patterns: ['beta.test'], color: 'red', merge: false });
  extension.state.groups.push({ id: 20, title: 'Beta', color: 'red', windowId: 1 });
  await startCountdown(extension);
  extension.state.tab.url = 'https://beta.test';
  await startCountdown(extension);
  await extension.fireCountdown();
  assert.equal(extension.state.tab.groupId, 20);
  assert.equal(extension.state.tab.windowId, 1);
  assert.deepEqual(extension.state.moves, []);
});

test('a timed-out merge already queued before navigation cannot move the tab', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  const finishing = extension.fireCountdown();
  extension.state.tab.url = 'https://other.test';
  await startCountdown(extension);
  await finishing;
  assert.deepEqual(extension.state.moves, []);
});

test('countdown validates the current URL even before its update event is handled', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  extension.state.tab.url = 'https://other.test';
  await extension.fireCountdown();
  assert.deepEqual(extension.state.moves, []);
});

test('disabling cross-window merge during the countdown prevents the move', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  extension.state.rules[0].merge = false;
  await extension.fireCountdown();
  assert.deepEqual(extension.state.moves, []);
});

test('closing the target group during the countdown leaves the tab in its window', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  extension.state.groups.length = 0;
  await extension.fireCountdown();
  assert.deepEqual(extension.state.moves, []);
});

test('an unchanged countdown moves to its target without activating a background tab', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  await extension.fireCountdown();
  assert.equal(extension.state.tab.groupId, 10);
  assert.equal(extension.state.tab.windowId, 2);
  assert.equal(extension.state.moves.length, 1);
  assert.deepEqual(extension.state.updates, []);
});

test('Move Now preserves the request to avoid activation', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  assert.equal(extension.context.AutoGroupGrouping.confirmPendingMerge(1), true);
  await setImmediate();
  assert.equal(extension.state.tab.groupId, 10);
  assert.deepEqual(extension.state.updates, []);
});

test('Cancel prevents a confirmed merge that has not executed yet', async () => {
  const extension = createMerge();
  await startCountdown(extension);
  extension.context.AutoGroupGrouping.confirmPendingMerge(1);
  assert.equal(extension.context.AutoGroupGrouping.cancelPendingMerge(1), true);
  await setImmediate();
  await extension.fireCountdown();
  assert.deepEqual(extension.state.moves, []);
});

test('navigation cancels a pending drag retry before it can move to the old group', async () => {
  const extension = createMerge();
  extension.state.rules.push({ id: 'b', name: 'Beta', patterns: ['beta.test'], color: 'red', merge: false });
  extension.state.groups.push({ id: 20, title: 'Beta', color: 'red', windowId: 1 });
  const move = extension.context.chrome.tabs.move;
  let firstAttempt = true;
  extension.context.chrome.tabs.move = async (...args) => {
    if (firstAttempt) {
      firstAttempt = false;
      throw new Error('Tabs cannot be edited right now');
    }
    return move(...args);
  };
  await startCountdown(extension);
  await extension.fireCountdown();
  extension.state.tab.url = 'https://beta.test';
  const regrouping = startCountdown(extension);
  await extension.fireTimer(500);
  await regrouping;
  assert.deepEqual(extension.state.moves, []);
  assert.equal(extension.state.tab.groupId, 20);
});

for (const api of ['move', 'group']) {
  test(`a pending merge completes after a temporary ${api} edit failure`, async () => {
    const extension = createMerge();
    const original = extension.context.chrome.tabs[api];
    let firstAttempt = true;
    extension.context.chrome.tabs[api] = async (...args) => {
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('Tabs cannot be edited right now');
      }
      return original(...args);
    };
    await startCountdown(extension);
    await extension.fireCountdown();
    await extension.fireTimer(500);
    assert.equal(extension.state.tab.groupId, 10);
    assert.equal(extension.state.tab.windowId, 2);
    assert.equal(extension.context.AutoGroupGrouping.cancelPendingMerge(1), false);
  });
}

test('full rebuild preserves sleep protection on an unmatched loose tab', async () => {
  const extension = createExtension({ tab: { url: 'https://unmanaged.test', autoDiscardable: false } });
  extension.load('background.js');
  await vm.runInContext("rebuildOpenTabs('test')", extension.context);
  assert.equal(extension.state.tab.autoDiscardable, false);
  assert.deepEqual(extension.state.updates, []);
});

test('full rebuild preserves sleep protection on an unmanaged browser group', async () => {
  const extension = createExtension({
    tab: { url: 'https://unmanaged.test', groupId: 10, autoDiscardable: false },
    groups: [{ id: 10, title: 'Manual', color: 'blue', windowId: 1 }]
  });
  extension.load('background.js');
  await vm.runInContext("rebuildOpenTabs('test')", extension.context);
  assert.equal(extension.state.tab.autoDiscardable, false);
  assert.equal(extension.state.tab.groupId, 10);
});

test('full rebuild still applies sleep protection configured by a matching rule', async () => {
  const extension = createExtension({
    rules: [{ id: 'a', name: 'Alpha', patterns: ['alpha.test'], color: 'blue', protectFromSleep: true }]
  });
  extension.load('background.js');
  await vm.runInContext("rebuildOpenTabs('test')", extension.context);
  assert.equal(extension.state.tab.autoDiscardable, false);
  extension.state.rules[0].protectFromSleep = false;
  await vm.runInContext("rebuildOpenTabs('test')", extension.context);
  assert.equal(extension.state.tab.autoDiscardable, true);
});

test('removing a managed rule during rebuild still releases its sleep protection', async () => {
  const extension = createExtension({
    tab: { url: 'https://unmanaged.test', groupId: 10, autoDiscardable: false },
    groups: [{ id: 10, title: 'Alpha', color: 'blue', windowId: 1 }]
  });
  extension.load('background.js');
  await vm.runInContext("rebuildOpenTabs('test', ['Alpha'])", extension.context);
  assert.equal(extension.state.tab.autoDiscardable, true);
  assert.equal(extension.state.tab.groupId, -1);
});

function createPopup() {
  const extension = createExtension({
    rules: [
      { id: 'a', name: 'Alpha', patterns: ['alpha.test'], color: 'blue', merge: true },
      { id: 'b', name: 'Beta', patterns: ['beta.test'], color: 'red', merge: true }
    ],
    groups: [
      { id: 10, title: 'Alpha', color: 'blue', windowId: 1 },
      { id: 11, title: '📚 Alpha', color: 'blue', windowId: 2 },
      { id: 20, title: 'Beta', color: 'red', windowId: 1 }
    ]
  });
  extension.load('popup.js');
  extension.context.auditRules = structuredClone(extension.state.rules);
  vm.runInContext("existingRules = auditRules; matchedRuleId = 'a'; matchedPatternValue = 'alpha.test';", extension.context);
  const form = {
    patternInput: { value: 'alpha.test' }, groupSelect: { value: 'a' },
    newGroupNameInput: { value: '' }, newGroupColorInput: { value: 'blue' }, newGroupIconInput: { value: '' },
    quickRuleForm: { querySelector() { return { style: {} }; } }
  };
  return { ...extension, form };
}

test('popup rejects a rename that duplicates another normalized rule title', async () => {
  const extension = createPopup();
  extension.form.newGroupNameInput.value = '📚 BETA';
  await extension.context.handleFormSubmit({ preventDefault() {} }, extension.form);
  assert.equal(extension.state.alerts.length, 1);
  assert.deepEqual(extension.state.saved, []);
  assert.deepEqual(extension.state.updates, []);
  assert.deepEqual(extension.state.messages, []);
});

test('popup renames every open group with the old title and leaves other groups alone', async () => {
  const extension = createPopup();
  extension.form.newGroupNameInput.value = 'Research';
  extension.form.newGroupIconInput.value = '🧪';
  await extension.context.handleFormSubmit({ preventDefault() {} }, extension.form);
  assert.deepEqual(extension.state.groups.map(group => group.title), ['🧪 Research', '🧪 Research', 'Beta']);
  assert.equal(extension.state.saved[0].rules[0].name, 'Research');
});

test('popup leaves browser groups unchanged if saving the renamed rule fails', async () => {
  const extension = createPopup();
  extension.form.newGroupNameInput.value = 'Research';
  extension.context.chrome.storage.sync.set = async () => { throw new Error('Storage quota exceeded'); };
  await assert.rejects(extension.context.handleFormSubmit({ preventDefault() {} }, extension.form), /Storage quota exceeded/);
  assert.deepEqual(extension.state.groups.map(group => group.title), ['Alpha', '📚 Alpha', 'Beta']);
  assert.deepEqual(extension.state.messages, []);
});

test('Settings renames existing browser groups when saving a renamed rule', async () => {
  const extension = createExtension({
    rules: [{ id: 'a', name: 'Alpha', patterns: ['alpha.test'], color: 'blue', merge: true }],
    groups: [{ id: 10, title: 'Alpha', color: 'blue', windowId: 1 }]
  });
  extension.load('options.js');
  await setImmediate();
  extension.element('rule-id').value = 'a';
  extension.element('rule-name').value = 'Research';
  extension.element('rule-patterns').value = 'alpha.test';
  extension.element('selected-color').value = 'green';
  extension.element('rule-merge').checked = true;
  await extension.element('rule-form').onsubmit({ preventDefault() {} });
  assert.equal(extension.state.groups[0].title, 'Research');
  assert.equal(extension.state.groups[0].color, 'green');
  assert.equal(extension.state.saved[0].rules[0].name, 'Research');
});
