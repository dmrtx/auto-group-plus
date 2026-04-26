const rulesContainer = document.getElementById('rules-container');
const addRuleBtn = document.getElementById('add-rule-btn');
const viewOverviewBtn = document.getElementById('view-overview-btn');
const rebuildGroupsBtn = document.getElementById('rebuild-groups-btn');
const ruleModal = document.getElementById('rule-modal');
const ruleForm = document.getElementById('rule-form');
const cancelBtn = document.getElementById('cancel-btn');
const colorOptions = document.querySelectorAll('.color-option');
const selectedColorInput = document.getElementById('selected-color');
const { MESSAGE_ACTIONS } = AutoGroupConstants;
const { formatFixedTabLines, parseFixedTabLines } = AutoGroupRules;
const VALID_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);

let rules = [];
let draggedRuleId = null;
let draggedRuleCard = null;
let hasRuleOrderChanged = false;

const excludeWebAppsCheck = document.getElementById('setting-exclude-webapps');
const mergeCountdownCheck = document.getElementById('setting-merge-countdown');
const keepGroupOrderCheck = document.getElementById('setting-keep-group-order');
const groupsBeforeTabsCheck = document.getElementById('setting-groups-before-tabs');
const preserveSplitViewCheck = document.getElementById('setting-preserve-split-view');

// Load rules & settings on startup
async function loadData() {
    const data = await chrome.storage.sync.get(['rules', 'settings']);
    rules = data.rules || [];

    // Default settings
    const settings = data.settings || { excludeWebApps: true, mergeCountdown: true };

    // Apply to UI
    excludeWebAppsCheck.checked = settings.excludeWebApps !== false; // Default true
    mergeCountdownCheck.checked = settings.mergeCountdown !== false; // Default true
    keepGroupOrderCheck.checked = settings.keepGroupOrder === true;
    groupsBeforeTabsCheck.checked = settings.groupsBeforeTabs === true;
    preserveSplitViewCheck.checked = settings.preserveSplitView !== false; // Default true

    renderRules();
    if (settings.keepGroupOrder === true || settings.groupsBeforeTabs === true) {
        await applyGroupLayoutToOpenTabs();
    }
}

async function saveSettings() {
    const settings = {
        excludeWebApps: excludeWebAppsCheck.checked,
        mergeCountdown: mergeCountdownCheck.checked,
        keepGroupOrder: keepGroupOrderCheck.checked,
        groupsBeforeTabs: groupsBeforeTabsCheck.checked,
        preserveSplitView: preserveSplitViewCheck.checked
    };
    await chrome.storage.sync.set({ settings });
    await applyGroupLayoutToOpenTabs();
}

// Settings Listeners
excludeWebAppsCheck.onchange = saveSettings;
mergeCountdownCheck.onchange = saveSettings;
keepGroupOrderCheck.onchange = saveSettings;
groupsBeforeTabsCheck.onchange = saveSettings;
preserveSplitViewCheck.onchange = saveSettings;

function renderRules() {
    draggedRuleId = null;
    draggedRuleCard = null;
    hasRuleOrderChanged = false;
    rulesContainer.classList.remove('is-ordering');
    rulesContainer.replaceChildren();
    if (rules.length === 0) {
        rulesContainer.appendChild(createEmptyState());
        return;
    }

    getOrderedRules().forEach((rule, index) => {
        rulesContainer.appendChild(createRuleCard(rule, index));
    });

    // Attach listeners
    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.onclick = () => editRule(btn.dataset.id);
    });
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.onclick = () => deleteRule(btn.dataset.id);
    });
    document.querySelectorAll('.rule-order-control').forEach(control => {
        control.addEventListener('pointerdown', handleRulePointerDown);
    });
}

function createEmptyState() {
    const emptyState = document.createElement('div');
    emptyState.style.cssText = 'text-align: center; padding: 3rem; color: var(--text-dim);';

    const message = document.createElement('p');
    message.textContent = 'No rules defined yet. Click "Add Group Rule" to get started!';

    emptyState.appendChild(message);
    return emptyState;
}

function createRuleCard(rule, orderIndex) {
    const card = document.createElement('div');
    card.className = 'rule-card';
    card.dataset.id = rule.id;

    const orderControl = document.createElement('div');
    orderControl.className = 'rule-order-control';
    orderControl.title = 'Drag to reorder groups';

    const orderNumber = document.createElement('span');
    orderNumber.className = 'rule-order-number';
    orderNumber.textContent = String(orderIndex);

    const dragHint = document.createElement('span');
    dragHint.className = 'rule-drag-hint';
    dragHint.textContent = 'drag';

    orderControl.append(orderNumber, dragHint);

    const info = document.createElement('div');
    info.className = 'rule-info';

    const header = document.createElement('div');
    header.className = 'rule-header';

    const colorDot = document.createElement('div');
    const safeColor = VALID_COLORS.has(rule.color) ? rule.color : 'blue';
    colorDot.classList.add('color-dot', `bg-${safeColor}`);

    const name = document.createElement('span');
    name.className = 'rule-name';
    name.textContent = rule.name;

    header.append(colorDot, name);

    const patterns = document.createElement('div');
    patterns.className = 'rule-patterns';
    (Array.isArray(rule.patterns) ? rule.patterns : []).forEach(pattern => {
        const tag = document.createElement('span');
        tag.className = 'pattern-tag';
        tag.textContent = pattern;
        patterns.appendChild(tag);
    });

    const fixedTabs = Array.isArray(rule.fixedTabs) ? rule.fixedTabs : [];
    fixedTabs.forEach(entry => {
        const tag = document.createElement('span');
        tag.className = 'pattern-tag';
        tag.textContent = `#${entry.index} ${entry.url}`;
        tag.title = 'Fixed tab position';
        patterns.appendChild(tag);
    });

    const meta = document.createElement('div');
    meta.style.cssText = 'font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;';
    meta.textContent = [
        rule.merge ? '✓ Merge' : '',
        Number.isInteger(rule.groupOrder) ? `✓ Order ${rule.groupOrder}` : '',
        fixedTabs.length ? `✓ ${fixedTabs.length} fixed` : ''
    ]
        .filter(Boolean)
        .join('  ');

    info.append(header, patterns, meta);

    const actions = document.createElement('div');
    actions.className = 'rule-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-secondary edit-btn';
    editBtn.dataset.id = rule.id;
    editBtn.textContent = 'Edit';

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-secondary delete-btn';
    deleteBtn.dataset.id = rule.id;
    deleteBtn.style.color = '#ef4444';
    deleteBtn.textContent = 'Delete';

    actions.append(editBtn, deleteBtn);
    card.append(orderControl, info, actions);

    return card;
}

function getOrderedRules() {
    return rules
        .map((rule, index) => ({ rule, index, order: getEffectiveGroupOrder(rule, index) }))
        .sort((a, b) => {
            if (a.order !== b.order) return a.order - b.order;
            return a.index - b.index;
        })
        .map(entry => entry.rule);
}

function getEffectiveGroupOrder(rule, fallbackIndex) {
    return Number.isInteger(rule.groupOrder) && rule.groupOrder >= 0 ? rule.groupOrder : fallbackIndex;
}

function handleRulePointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;

    const card = event.currentTarget.closest('.rule-card');
    if (!card) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);

    draggedRuleId = card.dataset.id;
    draggedRuleCard = card;
    hasRuleOrderChanged = false;
    card.classList.add('is-dragging');
    rulesContainer.classList.add('is-ordering');

    window.addEventListener('pointermove', handleRulePointerMove);
    window.addEventListener('pointerup', handleRulePointerEnd, { once: true });
    window.addEventListener('pointercancel', handleRulePointerEnd, { once: true });
}

function handleRulePointerMove(event) {
    event.preventDefault();
    if (!draggedRuleCard) return;

    const afterElement = getDragAfterElement(rulesContainer, event.clientY);
    const nextElement = draggedRuleCard.nextElementSibling;

    if (afterElement === null) {
        if (nextElement !== null) {
            rulesContainer.appendChild(draggedRuleCard);
            hasRuleOrderChanged = true;
        }
        return;
    }

    if (afterElement !== draggedRuleCard && afterElement !== nextElement) {
        rulesContainer.insertBefore(draggedRuleCard, afterElement);
        hasRuleOrderChanged = true;
    }
}

async function handleRulePointerEnd() {
    window.removeEventListener('pointermove', handleRulePointerMove);
    window.removeEventListener('pointercancel', handleRulePointerEnd);
    draggedRuleCard?.classList.remove('is-dragging');
    rulesContainer.classList.remove('is-ordering');

    if (draggedRuleId && hasRuleOrderChanged) {
        await saveRuleOrderFromDom();
    }

    draggedRuleId = null;
    draggedRuleCard = null;
    hasRuleOrderChanged = false;
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.rule-card:not(.is-dragging)')];

    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        }

        return closest;
    }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}

async function saveRuleOrderFromDom() {
    const orderedIds = [...rulesContainer.querySelectorAll('.rule-card')]
        .map(card => card.dataset.id)
        .filter(Boolean);

    if (orderedIds.length === 0) return;

    const currentRulesById = new Map(rules.map(rule => [rule.id, rule]));
    const reorderedRules = orderedIds
        .map(id => currentRulesById.get(id))
        .filter(Boolean)
        .map((rule, index) => ({ ...rule, groupOrder: index }));

    const missingRules = rules
        .filter(rule => !orderedIds.includes(rule.id))
        .map((rule, index) => ({ ...rule, groupOrder: reorderedRules.length + index }));

    rules = [...reorderedRules, ...missingRules];
    keepGroupOrderCheck.checked = true;

    await chrome.storage.sync.set({
        rules,
        settings: {
            excludeWebApps: excludeWebAppsCheck.checked,
            mergeCountdown: mergeCountdownCheck.checked,
            keepGroupOrder: true,
            groupsBeforeTabs: groupsBeforeTabsCheck.checked,
            preserveSplitView: preserveSplitViewCheck.checked
        }
    });
    await applyGroupLayoutToOpenTabs();
    renderRules();
}

function openModal(title = 'Add Group Rule') {
    document.getElementById('modal-title').innerText = title;
    ruleModal.style.display = 'flex';
}

function closeModal() {
    ruleModal.style.display = 'none';
    ruleForm.reset();
    document.getElementById('rule-id').value = '';
    selectColor('blue');
}

function selectColor(color) {
    selectedColorInput.value = color;
    colorOptions.forEach(opt => {
        opt.classList.toggle('selected', opt.dataset.color === color);
    });
}

function editRule(id) {
    const rule = rules.find(r => r.id === id);
    if (!rule) return;

    document.getElementById('rule-id').value = rule.id;
    document.getElementById('rule-name').value = rule.name;
    document.getElementById('rule-patterns').value = rule.patterns.join(', ');
    document.getElementById('rule-group-order').value = Number.isInteger(rule.groupOrder) ? String(rule.groupOrder) : '';
    document.getElementById('rule-fixed-tabs').value = formatFixedTabLines(rule.fixedTabs);
    document.getElementById('rule-merge').checked = rule.merge;
    selectColor(rule.color);

    openModal('Edit Group Rule');
}

async function deleteRule(id) {
    if (confirm('Are you sure you want to delete this rule?')) {
        rules = rules.filter(r => r.id !== id);
        await chrome.storage.sync.set({ rules });
        renderRules();
    }
}

async function syncBrowserGroupColor(rule) {
    if (!rule || !rule.name || !rule.color) return;

    const groups = await chrome.tabGroups.query({}).catch(() => []);
    await Promise.all(groups
        .filter(group => normalizeGroupName(group.title) === normalizeGroupName(rule.name))
        .map(group => chrome.tabGroups.update(group.id, { color: rule.color }).catch(() => {})));
}

// Event Listeners
addRuleBtn.onclick = () => openModal();
if (viewOverviewBtn) {
    viewOverviewBtn.onclick = () => {
        chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.GET_OVERVIEW }, (resp) => {
            if (!resp) {
                alert('Could not load overview (no response from background).');
                return;
            }

            const rulesList = (resp.rules || []).map(r => {
                const patterns = Array.isArray(r.patterns) ? r.patterns.join(', ') : '';
                const order = Number.isInteger(r.groupOrder) ? `  |  order: ${r.groupOrder}` : '';
                const fixed = Array.isArray(r.fixedTabs) && r.fixedTabs.length > 0
                    ? `  |  fixed: ${r.fixedTabs.map(entry => `#${entry.index} ${entry.url}`).join(', ')}`
                    : '';
                return `• ${r.name || '(no title)'} [${r.color}]  |  patterns: ${patterns}${order}${fixed}`;
            }).join('\n') || 'No rules defined.';

            const groupsList = (resp.groups || []).map(g => {
                const count = Array.isArray(g.tabIds) ? g.tabIds.length : (g.tabCount ?? 0);
                return `• ${g.title || '(no title)'} [${g.color}]  |  tabs: ${count}`;
            }).join('\n') || 'No tab groups currently open.';

            alert(
                'Rules:\n' +
                '-------------------------\n' +
                rulesList +
                '\n\nTab Groups (all windows):\n' +
                '-------------------------\n' +
                groupsList
            );
        });
    };
}
if (rebuildGroupsBtn) {
    rebuildGroupsBtn.onclick = () => {
        if (!confirm('Rebuild all tab groups now based on the current rules?')) return;
        chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REBUILD_GROUPS }, (resp) => {
            if (!resp || !resp.ok) {
                alert('Failed to rebuild groups.' + (resp && resp.error ? `\n${resp.error}` : ''));
                return;
            }
            alert(`Rebuilt groups for ${resp.processed} tabs.`);
        });
    };
}
cancelBtn.onclick = () => closeModal();

colorOptions.forEach(opt => {
    opt.onclick = () => selectColor(opt.dataset.color);
});

ruleForm.onsubmit = async (e) => {
    e.preventDefault();

    const id = document.getElementById('rule-id').value || Date.now().toString();
    const name = document.getElementById('rule-name').value.trim();
    // Prevent creating nameless groups (which appear as blank chips in Chrome)
    if (!name) {
        alert('Please enter a group name');
        return;
    }

    const patterns = document.getElementById('rule-patterns').value
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);
    const fixedTabs = parseFixedTabLines(document.getElementById('rule-fixed-tabs').value);
    const groupOrder = parseGroupOrder(document.getElementById('rule-group-order').value);
    const color = selectedColorInput.value;
    const merge = document.getElementById('rule-merge').checked;

    const newRule = { id, name, patterns, color, merge, fixedTabs };
    if (groupOrder !== null) {
        newRule.groupOrder = groupOrder;
    }

    const existingIndex = rules.findIndex(r => r.id === id);
    if (existingIndex > -1) {
        rules[existingIndex] = newRule;
    } else {
        rules.push(newRule);
    }

    await chrome.storage.sync.set({ rules });
    await syncBrowserGroupColor(newRule);
    await applyRulesToOpenTabs();
    closeModal();
    renderRules();
};

window.onclick = (e) => {
    if (e.target === ruleModal) closeModal();
};

loadData();

function normalizeGroupName(name) {
    return String(name || '').trim().toLowerCase();
}

function parseGroupOrder(value) {
    if (String(value || '').trim() === '') return null;

    const order = Number.parseInt(value, 10);
    return Number.isInteger(order) && order >= 0 ? order : null;
}

async function applyRulesToOpenTabs() {
    await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REBUILD_GROUPS }).catch((e) => {
        console.warn('Could not apply rules after saving.', e);
    });
}

async function applyGroupLayoutToOpenTabs() {
    await chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.APPLY_GROUP_LAYOUT }).catch((e) => {
        console.warn('Could not apply group layout after saving.', e);
    });
}
