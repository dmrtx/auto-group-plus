document.addEventListener('DOMContentLoaded', () => {
    init().catch(e => console.error("Init failed:", e));
});

let existingRules = [];
let currentUrl = null;
const { MESSAGE_ACTIONS } = AutoGroupConstants;
const { matchesPattern } = AutoGroupRules;

async function init() {
    // Elements
    const elements = {
        patternInput: document.getElementById('pattern-input'),
        groupSelect: document.getElementById('group-select'),
        quickRuleForm: document.getElementById('quick-rule-form'),
        openSettingsBtn: document.getElementById('open-settings'),
        newGroupContainer: document.getElementById('new-group-input-container'),
        newGroupNameInput: document.getElementById('new-group-name'),
        newGroupColorInput: document.getElementById('new-group-color'),
        viewCurrentRulesBtn: document.getElementById('view-current-rules'),
        currentGroupNameSpan: document.getElementById('current-group-name'),
        colorDots: document.querySelectorAll('.color-dot-select'),
        suggestions: {
            domain: document.getElementById('suggest-domain'),
            wildcard: document.getElementById('suggest-wildcard'),
            url: document.getElementById('suggest-url')
        }
    };

    // Parallel fetch for critical data
    const [tabs, storageData, browserGroups] = await Promise.all([
        chrome.tabs.query({ active: true, currentWindow: true }),
        chrome.storage.sync.get('rules'),
        chrome.tabGroups.query({})
    ]);

    // 1. Process Tab
    const tab = tabs[0];
    if (!tab) return;

    if (tab.url) {
        currentUrl = new URL(tab.url);
        // Only run suggestion logic if we have the URL
        setupSuggestions(elements);
    }

    // 2. Process Rules
    existingRules = storageData.rules || [];

    // 3. Populate UI (Synchronous, optimized)
    populateGroupSelect(elements.groupSelect, browserGroups);

    // 4. Update UI State based on current tab
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        // Fast lookup via ID since we likely have it in browserGroups
        const knownGroup = browserGroups.find(g => g.id === tab.groupId);
        if (knownGroup) {
            showCurrentGroupStatus(knownGroup, elements);
        } else {
            // Fallback fetch if somehow missing (rare)
            chrome.tabGroups.get(tab.groupId).then(g => showCurrentGroupStatus(g, elements)).catch(() => { });
        }
    }

    // 5. Check for existing pattern match
    const contentEl = document.querySelector('.suggestions');
    if (currentUrl) {
        const matchedRule = existingRules.find(r => r.patterns && r.patterns.some(p => matchesPattern(currentUrl.href, p)));

        if (matchedRule) {
            const matchedPattern = matchedRule.patterns.find(p => matchesPattern(currentUrl.href, p));

            if (elements.groupSelect) elements.groupSelect.value = matchedRule.id;
            if (elements.patternInput) elements.patternInput.value = matchedPattern;

            if (contentEl) {
                const statusDiv = createMatchStatus();
                contentEl.parentNode.insertBefore(statusDiv, contentEl);
            }

            const btn = elements.quickRuleForm.querySelector('button[type="submit"]');
            if (btn) btn.innerText = 'Update Pattern';

            // Show Delete Button
            const deleteBtn = document.getElementById('btn-delete-pattern');
            if (deleteBtn) {
                deleteBtn.style.display = 'block';
                deleteBtn.onclick = async () => {
                    if (!confirm('Remove this pattern from the group rules?')) return;

                    // Remove pattern
                    const newPatterns = matchedRule.patterns.filter(p => p !== matchedPattern);

                    if (newPatterns.length === 0) {
                        // Delete rule entirely if no patterns left
                        existingRules = existingRules.filter(r => r.id !== matchedRule.id);
                    } else {
                        // Update rule
                        matchedRule.patterns = newPatterns;
                        const idx = existingRules.indexOf(matchedRule);
                        if (idx > -1) existingRules[idx] = matchedRule;
                    }

                    await chrome.storage.sync.set({ rules: existingRules });

                    // Trigger Regroup (which essentially re-evaluates)
                    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                        if (tabs[0]) {
                            chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REGROUP_TAB, tabId: tabs[0].id });
                        }
                    });

                    // Update UI confirm
                    deleteBtn.innerText = 'Removed';
                    setTimeout(() => window.close(), 500);
                };
            }
        }
    }

    // Handle initial state
    handleGroupSelect(elements);

    // Event Listeners
    if (elements.groupSelect) {
        elements.groupSelect.onchange = () => handleGroupSelect(elements);
    }
    // ... rest of listeners ...
    if (elements.colorDots) {
        elements.colorDots.forEach(dot => {
            dot.onclick = () => {
                elements.colorDots.forEach(d => d.classList.remove('selected'));
                dot.classList.add('selected');
                if (elements.newGroupColorInput) elements.newGroupColorInput.value = dot.dataset.color;
            };
        });
    }

    if (elements.openSettingsBtn) {
        elements.openSettingsBtn.onclick = () => {
            if (chrome.runtime.openOptionsPage) {
                chrome.runtime.openOptionsPage();
            } else {
                window.open(chrome.runtime.getURL('options.html'));
            }
        };
    }

    if (elements.quickRuleForm) {
        elements.quickRuleForm.onsubmit = (e) => handleFormSubmit(e, elements);
    }
}

function createMatchStatus() {
    const statusDiv = document.createElement('div');
    statusDiv.className = 'match-status';
    statusDiv.style.cssText = 'background: rgba(16, 185, 129, 0.2); padding: 0.75rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid rgba(16, 185, 129, 0.3); display: flex; align-items: center; gap: 0.75rem;';

    const icon = document.createElement('div');
    icon.style.cssText = 'background: #10b981; color: white; width: 24px; height: 24px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold;';
    icon.textContent = '✓';

    const copy = document.createElement('div');
    copy.style.flex = '1';

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: 600; font-size: 0.85rem; color: #6ee7b7;';
    title.textContent = 'Pattern Saved';

    const subtitle = document.createElement('div');
    subtitle.style.cssText = 'font-size: 0.75rem; color: #d1fae5; opacity: 0.8;';
    subtitle.textContent = 'Matches this page';

    copy.append(title, subtitle);
    statusDiv.append(icon, copy);

    return statusDiv;
}

function setupSuggestions(els) {
    if (!currentUrl) return;

    const suggestionsContainer = document.querySelector('.suggestions');
    if (!suggestionsContainer) return;

    // Clear existing static suggestions
    suggestionsContainer.replaceChildren();

    const label = document.createElement('span');
    label.style.cssText = 'font-size: 0.75rem; color: var(--text-dim); display: block; margin-bottom: 0.3rem;';
    label.textContent = 'Suggestions:';
    suggestionsContainer.appendChild(label);

    const hostname = currentUrl.hostname;
    // User requested "next paths only of current URL", so avoiding the "root domain" (e.g. ninjarmm.pri)
    // and sticking to the specific hostname we are on.
    const wildcardHostname = `*.${hostname}`;

    // Helper to create link
    const addSuggestion = (text, value, title = null) => {
        const a = document.createElement('a');
        a.className = 'suggestion-link';
        a.innerText = text;
        if (title) a.title = title;
        a.onclick = () => { if (els.patternInput) els.patternInput.value = value; };
        suggestionsContainer.appendChild(a);
    };

    // 1. Wildcard Hostname (e.g. *.teamcity.example.com)
    addSuggestion(wildcardHostname, wildcardHostname);

    // 2. Path segments (Iterative)
    if (currentUrl.pathname && currentUrl.pathname.length > 1) {
        const segments = currentUrl.pathname.split('/').filter(Boolean);
        let currentPath = currentUrl.origin;

        // Generate patterns for each path level
        segments.forEach(segment => {
            currentPath += '/' + segment;
            const pattern = currentPath + '/*';
            // Visual cleanup: remove protocol for display if it's too long
            const displayText = pattern.replace(/^https?:\/\//, '');
            addSuggestion(displayText, pattern, pattern);
        });
    }

    // 4. Exact URL (Truncated)
    const fullUrl = currentUrl.href;
    const displayText = fullUrl.length > 90
        ? fullUrl.substring(0, 45) + '...' + fullUrl.substring(fullUrl.length - 40)
        : fullUrl;
    addSuggestion(displayText, fullUrl, fullUrl);

    // Default input value
    if (els.patternInput && !els.patternInput.value) {
        els.patternInput.value = wildcardHostname;
    }
}

function populateGroupSelect(selectEl, browserGroups = []) {
    if (!selectEl) return;
    const newOption = selectEl.options[0];
    selectEl.replaceChildren(newOption);

    // 1. Add existing rules
    existingRules.forEach(rule => {
        const option = document.createElement('option');
        option.value = rule.id;
        option.textContent = rule.name;
        selectEl.appendChild(option);
    });

    // 2. Add browser groups that don't match existing rules
    // Create lookup sets for fast O(1) checking
    const existingRuleKeys = new Set(existingRules.map(r => `${r.name}|${r.color}`));
    const addedBrowserGroups = new Set();
    const uniqueBrowserGroups = [];

    browserGroups.forEach(bg => {
        // Key for this group
        const key = `${bg.title}|${bg.color}`;

        // Skip if matches existing rule
        if (existingRuleKeys.has(key)) return;

        // Skip if already added to list (deduplication)
        if (addedBrowserGroups.has(key)) return;

        if (bg.title) {
            uniqueBrowserGroups.push(bg);
            addedBrowserGroups.add(key);
        }
    });

    if (uniqueBrowserGroups.length > 0) {
        const divider = document.createElement('option');
        divider.disabled = true;
        divider.textContent = '--- Browser Groups ---';
        selectEl.appendChild(divider);

        uniqueBrowserGroups.forEach(bg => {
            const option = document.createElement('option');
            // Use a special prefix to identify ad-hoc groups
            option.value = `browser_group:${bg.title}:${bg.color}`;
            option.textContent = `${bg.title} (Existing)`;
            selectEl.appendChild(option);
        });
    }
}

function showCurrentGroupStatus(group, els) {
    if (els.viewCurrentRulesBtn) els.viewCurrentRulesBtn.style.display = 'inline-flex';
    if (els.currentGroupNameSpan) {
        els.currentGroupNameSpan.textContent = group.title;
        els.currentGroupNameSpan.style.color = getHexForColor(group.color);
    }

    const matchingRule = existingRules.find(r => r.name === group.title && r.color === group.color);
    if (matchingRule && els.groupSelect) {
        els.groupSelect.value = matchingRule.id;
        handleGroupSelect(els);
    } else if (group.title && els.groupSelect) {
        // Try to select the browser group option
        const browserVal = `browser_group:${group.title}:${group.color}`;
        // Check if option exists (might have been added)
        const optionExists = Array.from(els.groupSelect.options).some(o => o.value === browserVal);
        if (optionExists) {
            els.groupSelect.value = browserVal;
            handleGroupSelect(els);
        }
    }
}

function handleGroupSelect(els) {
    if (!els.groupSelect || !els.newGroupContainer) return;

    const val = els.groupSelect.value;

    if (val === 'new') {
        els.newGroupContainer.style.display = 'block';
        if (els.newGroupNameInput) {
            els.newGroupNameInput.value = '';
            els.newGroupNameInput.focus();
        }
    } else if (val.startsWith('browser_group:')) {
        // It's a browser group: Treat as "New" but pre-fill
        const [, title, color] = val.split(':');
        els.newGroupContainer.style.display = 'block';
        if (els.newGroupNameInput) els.newGroupNameInput.value = title;
        if (els.newGroupColorInput) els.newGroupColorInput.value = color;

        // Select the color dot
        if (els.colorDots) {
            els.colorDots.forEach(d => {
                if (d.dataset.color === color) d.classList.add('selected');
                else d.classList.remove('selected');
            });
        }
    } else {
        els.newGroupContainer.style.display = 'none';
    }
}

async function handleFormSubmit(e, els) {
    e.preventDefault();
    if (!els.patternInput) return;

    const pattern = els.patternInput.value.trim();
    if (!pattern) return;

    const selectedValue = els.groupSelect.value;
    let ruleIdToUpdate = selectedValue;

    // Logic: If "new" OR "browser_group", we create a new rule
    if (selectedValue === 'new' || selectedValue.startsWith('browser_group:')) {
        const name = els.newGroupNameInput.value.trim();
        if (!name) {
            alert('Please enter a group name');
            return;
        }
        const color = els.newGroupColorInput ? els.newGroupColorInput.value : 'blue';

        // Check if a rule effectively already exists (name+color match)
        const existingRule = existingRules.find(r => r.name === name && r.color === color);

        if (existingRule) {
            ruleIdToUpdate = existingRule.id;
            if (!existingRule.patterns.includes(pattern)) {
                existingRule.patterns.push(pattern);
                const idx = existingRules.indexOf(existingRule);
                if (idx > -1) existingRules[idx] = existingRule;
            }
        } else {
            // Create truly new rule
            const newRule = {
                id: Date.now().toString(),
                name,
                color,
                patterns: [pattern],
                merge: true,
            };
            existingRules.push(newRule);
            ruleIdToUpdate = newRule.id;
        }

    } else {
        // Standard update existing rule
        const ruleIndex = existingRules.findIndex(r => r.id === ruleIdToUpdate);
        if (ruleIndex > -1) {
            const rule = existingRules[ruleIndex];
            // Avoid duplicates
            if (!rule.patterns.includes(pattern)) {
                rule.patterns.push(pattern);
            }
            existingRules[ruleIndex] = rule;
        }
    }

    await chrome.storage.sync.set({ rules: existingRules });

    // Trigger immediate regrouping
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
            chrome.runtime.sendMessage({ action: MESSAGE_ACTIONS.REGROUP_TAB, tabId: tabs[0].id });
        }
    });

    const btn = els.quickRuleForm.querySelector('button[type="submit"]');
    if (btn) {
        btn.innerText = 'Saved!';
        btn.style.background = '#10b981';
    }

    setTimeout(() => window.close(), 800);
}

function getHexForColor(colorName) {
    const colors = {
        grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f1c21b',
        green: '#1e8e3e', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#fa903e'
    };
    return colors[colorName] || '#fff';
}
