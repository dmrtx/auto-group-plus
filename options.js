const rulesContainer = document.getElementById('rules-container');
const addRuleBtn = document.getElementById('add-rule-btn');
const ruleModal = document.getElementById('rule-modal');
const ruleForm = document.getElementById('rule-form');
const cancelBtn = document.getElementById('cancel-btn');
const colorOptions = document.querySelectorAll('.color-option');
const selectedColorInput = document.getElementById('selected-color');

let rules = [];

const excludeWebAppsCheck = document.getElementById('setting-exclude-webapps');
const mergeCountdownCheck = document.getElementById('setting-merge-countdown');

let rules = [];

// Load rules & settings on startup
async function loadData() {
    const data = await chrome.storage.sync.get(['rules', 'settings']);
    rules = data.rules || [];

    // Default settings
    const settings = data.settings || { excludeWebApps: true, mergeCountdown: true };

    // Apply to UI
    excludeWebAppsCheck.checked = settings.excludeWebApps !== false; // Default true
    mergeCountdownCheck.checked = settings.mergeCountdown !== false; // Default true

    renderRules();
}

async function saveSettings() {
    const settings = {
        excludeWebApps: excludeWebAppsCheck.checked,
        mergeCountdown: mergeCountdownCheck.checked
    };
    await chrome.storage.sync.set({ settings });
}

// Settings Listeners
excludeWebAppsCheck.onchange = saveSettings;
mergeCountdownCheck.onchange = saveSettings;

function renderRules() {
    rulesContainer.innerHTML = '';
    if (rules.length === 0) {
        rulesContainer.innerHTML = `
      <div style="text-align: center; padding: 3rem; color: var(--text-dim);">
        <p>No rules defined yet. Click "Add Group Rule" to get started!</p>
      </div>
    `;
        return;
    }

    rules.forEach(rule => {
        const card = document.createElement('div');
        card.className = 'rule-card';
        card.innerHTML = `
      <div class="rule-info">
        <div class="rule-header">
          <div class="color-dot bg-${rule.color}"></div>
          <span class="rule-name">${rule.name}</span>
        </div>
        <div class="rule-patterns">
          ${rule.patterns.map(p => `<span class="pattern-tag">${p}</span>`).join('')}
        </div>
        <div style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">
          ${rule.merge ? '✓ Merge' : ''} ${rule.strict ? '✓ Strict' : ''}
        </div>
      </div>
      <div class="rule-actions">
        <button class="btn btn-secondary edit-btn" data-id="${rule.id}">Edit</button>
        <button class="btn btn-secondary delete-btn" data-id="${rule.id}" style="color: #ef4444;">Delete</button>
      </div>
    `;
        rulesContainer.appendChild(card);
    });

    // Attach listeners
    document.querySelectorAll('.edit-btn').forEach(btn => {
        btn.onclick = () => editRule(btn.dataset.id);
    });
    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.onclick = () => deleteRule(btn.dataset.id);
    });
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
    document.getElementById('rule-merge').checked = rule.merge;
    document.getElementById('rule-strict').checked = rule.strict;
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

// Event Listeners
addRuleBtn.onclick = () => openModal();
cancelBtn.onclick = () => closeModal();

colorOptions.forEach(opt => {
    opt.onclick = () => selectColor(opt.dataset.color);
});

ruleForm.onsubmit = async (e) => {
    e.preventDefault();

    const id = document.getElementById('rule-id').value || Date.now().toString();
    const name = document.getElementById('rule-name').value.trim();
    const patterns = document.getElementById('rule-patterns').value
        .split(',')
        .map(p => p.trim())
        .filter(p => p.length > 0);
    const color = selectedColorInput.value;
    const merge = document.getElementById('rule-merge').checked;
    const strict = document.getElementById('rule-strict').checked;

    const newRule = { id, name, patterns, color, merge, strict };

    const existingIndex = rules.findIndex(r => r.id === id);
    if (existingIndex > -1) {
        rules[existingIndex] = newRule;
    } else {
        rules.push(newRule);
    }

    await chrome.storage.sync.set({ rules });
    closeModal();
    renderRules();
};

window.onclick = (e) => {
    if (e.target === ruleModal) closeModal();
};

loadData();
