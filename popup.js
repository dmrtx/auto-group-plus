const diagnosticsApi = globalThis.AutoGroupDiagnostics;
const popupLogger = diagnosticsApi ? diagnosticsApi.createLogger('popup') : null;

window.addEventListener('error', (event) => {
    popupLogger?.error('Unhandled window error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
    });
});

window.addEventListener('unhandledrejection', (event) => {
    popupLogger?.error('Unhandled promise rejection', event.reason);
});

document.addEventListener('DOMContentLoaded', () => {
    popupLogger?.info('DOMContentLoaded fired');
    init().catch(e => handlePopupFatalError(e));
});

let existingRules = [];
let currentUrl = null;
let matchedRuleId = null;
let matchedPatternValue = null;
const { MESSAGE_ACTIONS } = AutoGroupConstants;
const {
    GROUP_EMOJIS,
    formatGroupTitle,
    getGroupTitleIcon,
    matchesPattern,
    normalizeGroupIcon,
    normalizeGroupTitle,
    stripGroupIcon
} = AutoGroupRules;
let emojiPickerOptions = Array.isArray(GROUP_EMOJIS) ? GROUP_EMOJIS : [];
let emojiDataLoadPromise = null;

async function init() {
    popupLogger?.info('Popup init started');

    // Elements
    const elements = {
        patternInput: document.getElementById('pattern-input'),
        groupSelect: document.getElementById('group-select'),
        quickRuleForm: document.getElementById('quick-rule-form'),
        openSettingsBtn: document.getElementById('open-settings'),
        newGroupContainer: document.getElementById('new-group-input-container'),
        newGroupNameInput: document.getElementById('new-group-name'),
        newGroupColorInput: document.getElementById('new-group-color'),
        newGroupIconInput: document.getElementById('new-group-icon'),
        newGroupIconSearchInput: document.getElementById('new-group-icon-search'),
        newGroupIconPanel: document.getElementById('new-group-icon-panel'),
        newGroupIconToggleBtn: document.getElementById('toggle-new-group-icon-picker'),
        newGroupIconPreview: document.getElementById('new-group-icon-preview'),
        viewCurrentRulesBtn: document.getElementById('view-current-rules'),
        currentGroupNameSpan: document.getElementById('current-group-name'),
        colorDots: document.querySelectorAll('.color-dot-select'),
        iconOptionsContainer: document.getElementById('emoji-options-mini'),
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
    popupLogger?.info('Initial popup data loaded', {
        activeTabCount: Array.isArray(tabs) ? tabs.length : 0,
        ruleCount: Array.isArray(storageData.rules) ? storageData.rules.length : 0,
        browserGroupCount: Array.isArray(browserGroups) ? browserGroups.length : 0
    });

    // 1. Process Tab
    const tab = tabs[0];
    if (!tab) {
        popupLogger?.warn('Popup init aborted because no active tab was found');
        return;
    }

    if (tab.url) {
        popupLogger?.debug('Processing active tab URL', { url: tab.url });
        try {
            currentUrl = new URL(tab.url);
            setupSuggestions(elements);
        } catch (error) {
            popupLogger?.warn('Could not parse current tab URL', { url: tab.url, error });
        }
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
            matchedRuleId = matchedRule.id;
            matchedPatternValue = matchedPattern;

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

    if (elements.iconOptionsContainer) {
        elements.iconOptionsContainer.onclick = (event) => {
            const option = event.target.closest('.emoji-option');
            if (!option) return;
            setSelectedIcon(elements, option.dataset.icon);
        };
    }

    if (elements.newGroupIconToggleBtn) {
        elements.newGroupIconToggleBtn.onclick = async () => {
            await setEmojiPickerOpen(elements, elements.newGroupIconPanel ? elements.newGroupIconPanel.hidden : true);
        };
    }

    if (elements.newGroupIconSearchInput) {
        elements.newGroupIconSearchInput.oninput = () => renderEmojiOptions(elements, elements.newGroupIconSearchInput.value);
    }

    if (elements.openSettingsBtn) {
        elements.openSettingsBtn.onclick = (event) => {
            event.preventDefault();
            openOptionsPage();
        };
    }

    if (elements.viewCurrentRulesBtn) {
        elements.viewCurrentRulesBtn.onclick = (event) => {
            event.preventDefault();
            showRulesForCurrentGroup(elements);
        };
    }

    if (elements.quickRuleForm) {
        elements.quickRuleForm.onsubmit = (e) => handleFormSubmit(e, elements);
    }

    popupLogger?.info('Popup init completed');
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

    const suggestions = buildPatternSuggestions(currentUrl);

    const addSuggestion = (suggestion) => {
        const a = document.createElement('a');
        a.className = 'suggestion-link';
        a.innerText = suggestion.label;
        if (suggestion.title) a.title = suggestion.title;
        a.onclick = () => { if (els.patternInput) els.patternInput.value = suggestion.value; };
        suggestionsContainer.appendChild(a);
    };

    suggestions.forEach(addSuggestion);

    // Default input value
    if (els.patternInput && !els.patternInput.value) {
        els.patternInput.value = suggestions[0]?.value || currentUrl.hostname;
    }
}

function buildPatternSuggestions(url) {
    const hostname = url.hostname;
    const originPattern = `${url.origin}/*`;
    const candidates = [
        { label: trimPatternLabel(originPattern), value: originPattern, title: 'Match everything on this exact host and protocol' },
        { label: hostname, value: hostname, title: 'Match this host only' }
    ];

    if (url.port) {
        const anyPortPattern = `${url.protocol}//${hostname}:*/*`;
        candidates.push({
            label: trimPatternLabel(anyPortPattern),
            value: anyPortPattern,
            title: 'Match this host on any port'
        });
    }

    if (!isIpAddress(hostname) && hostname.includes('.')) {
        candidates.push({
            label: `*.${hostname}`,
            value: `*.${hostname}`,
            title: 'Match subdomains of this exact host'
        });
    }

    if (url.pathname && url.pathname.length > 1) {
        const segments = url.pathname.split('/').filter(Boolean);
        let currentPath = url.origin;
        let pathSuggestionCount = 0;
        let hasDynamicSegment = false;

        segments.forEach(segment => {
            if (hasDynamicSegment || pathSuggestionCount >= 2) return;
            if (isDynamicPathSegment(segment)) {
                hasDynamicSegment = true;
                return;
            }

            currentPath += '/' + segment;
            const pattern = `${currentPath}/*`;
            candidates.push({
                label: trimPatternLabel(pattern),
                value: pattern,
                title: pattern
            });
            pathSuggestionCount += 1;
        });
    }

    if (shouldShowExactUrlSuggestion(url)) {
        candidates.push({
            label: trimPatternLabel(url.href),
            value: url.href,
            title: 'Exact URL match'
        });
    }

    return uniqueSuggestions(candidates);
}

function uniqueSuggestions(suggestions) {
    const seen = new Set();
    return suggestions.filter(suggestion => {
        if (!suggestion.value || seen.has(suggestion.value)) return false;
        seen.add(suggestion.value);
        return true;
    });
}

function trimPatternLabel(pattern) {
    const cleanPattern = pattern.replace(/^https?:\/\//, '');
    if (cleanPattern.length <= 70) return cleanPattern;
    return `${cleanPattern.substring(0, 34)}...${cleanPattern.substring(cleanPattern.length - 30)}`;
}

function isIpAddress(hostname) {
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':');
}

function shouldShowExactUrlSuggestion(url) {
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return false;
    if (url.href.length > 90) return false;
    return !segments.some(isDynamicPathSegment);
}

function isDynamicPathSegment(segment) {
    const decodedSegment = decodeURIComponent(String(segment || '')).toLowerCase();
    if (!decodedSegment) return true;
    if (['true', 'false', 'null', 'undefined'].includes(decodedSegment)) return true;
    if (/^\d{4,}$/.test(decodedSegment)) return true;
    if (/^[a-f0-9]{12,}$/i.test(decodedSegment)) return true;
    if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(decodedSegment)) return true;
    return decodedSegment.length > 24;
}

function populateGroupSelect(selectEl, browserGroups = []) {
    if (!selectEl) return;
    const newOption = selectEl.options[0];
    selectEl.replaceChildren(newOption);

    // 1. Add existing rules
    existingRules.forEach(rule => {
        const option = document.createElement('option');
        option.value = rule.id;
        option.textContent = formatGroupTitle(rule);
        selectEl.appendChild(option);
    });

    // 2. Add browser groups that don't match existing rules
    // Create lookup sets for fast O(1) checking
    const existingRuleNames = new Set(existingRules.map(r => normalizeGroupName(r.name)));
    const addedBrowserGroups = new Set();
    const uniqueBrowserGroups = [];

    browserGroups.forEach(bg => {
        const titleKey = normalizeGroupName(bg.title);

        // Skip if a saved rule already owns this group title, even when colors differ.
        if (existingRuleNames.has(titleKey)) return;

        // Skip if already added to list (deduplication)
        if (addedBrowserGroups.has(titleKey)) return;

        if (bg.title) {
            uniqueBrowserGroups.push(bg);
            addedBrowserGroups.add(titleKey);
        }
    });

    if (uniqueBrowserGroups.length > 0) {
        const divider = document.createElement('option');
        divider.disabled = true;
        divider.textContent = '--- Browser Groups ---';
        selectEl.appendChild(divider);

        uniqueBrowserGroups.forEach(bg => {
            const option = document.createElement('option');
            option.value = `browser_group:${bg.id}`;
            option.dataset.title = bg.title;
            option.dataset.color = bg.color;
            option.dataset.groupId = String(bg.id);
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

    const matchingRule = existingRules.find(r => normalizeGroupName(r.name) === normalizeGroupName(group.title));
    if (matchingRule && els.groupSelect) {
        els.groupSelect.value = matchingRule.id;
        handleGroupSelect(els);
    } else if (group.title && els.groupSelect) {
        // Try to select the browser group option
        const browserVal = `browser_group:${group.id}`;
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
        if (els.newGroupIconSearchInput) els.newGroupIconSearchInput.value = '';
        setEmojiPickerOpen(els, false);
        if (els.newGroupNameInput) {
            els.newGroupNameInput.value = '';
            els.newGroupNameInput.focus();
        }
        setSelectedColor(els, 'blue');
        setSelectedIcon(els, '');
    } else if (val.startsWith('browser_group:')) {
        // It's a browser group: Treat as "New" but pre-fill
        const selectedOption = els.groupSelect.selectedOptions[0];
        const title = selectedOption ? selectedOption.dataset.title : '';
        const color = selectedOption ? selectedOption.dataset.color : 'blue';
        els.newGroupContainer.style.display = 'block';
        if (els.newGroupIconSearchInput) els.newGroupIconSearchInput.value = '';
        if (els.newGroupNameInput) els.newGroupNameInput.value = stripGroupIcon(title);
        setSelectedColor(els, color);
        setSelectedIcon(els, getGroupTitleIcon(title));
        setEmojiPickerOpen(els, Boolean(getGroupTitleIcon(title)));
    } else {
        const selectedRule = existingRules.find(rule => rule.id === val);
        if (!selectedRule) {
            els.newGroupContainer.style.display = 'none';
            return;
        }

        els.newGroupContainer.style.display = 'block';
        if (els.newGroupIconSearchInput) els.newGroupIconSearchInput.value = '';
        if (els.newGroupNameInput) els.newGroupNameInput.value = selectedRule.name || '';
        setSelectedColor(els, selectedRule.color || 'blue');
        setSelectedIcon(els, selectedRule.icon || '');
        setEmojiPickerOpen(els, Boolean(selectedRule.icon));
    }
}

async function handleFormSubmit(e, els) {
    e.preventDefault();
    if (!els.patternInput) return;

    const pattern = els.patternInput.value.trim();
    if (!pattern) return;

    const selectedValue = els.groupSelect.value;
    let ruleIdToUpdate = selectedValue;
    const isReplacingMatchedPattern = Boolean(
        matchedRuleId &&
        matchedPatternValue &&
        selectedValue === matchedRuleId
    );

    // Logic: If "new" OR "browser_group", we create a new rule
    if (selectedValue === 'new' || selectedValue.startsWith('browser_group:')) {
        const name = els.newGroupNameInput.value.trim();
        if (!name) {
            alert('Please enter a group name');
            return;
        }
        const color = els.newGroupColorInput ? els.newGroupColorInput.value : 'blue';
        const icon = els.newGroupIconInput ? normalizeGroupIcon(els.newGroupIconInput.value) : '';
        const selectedOption = els.groupSelect.selectedOptions[0];
        const browserGroupId = selectedValue.startsWith('browser_group:') && selectedOption
            ? Number.parseInt(selectedOption.dataset.groupId, 10)
            : null;

        // Browser groups are identified by title. Changing the color should update the
        // existing saved rule instead of creating a duplicate with the same name.
        const existingRule = existingRules.find(r => normalizeGroupName(r.name) === normalizeGroupName(name));

        if (existingRule) {
            ruleIdToUpdate = existingRule.id;
            existingRule.name = name;
            existingRule.color = color;
            if (icon) {
                existingRule.icon = icon;
            } else {
                delete existingRule.icon;
            }
            if (isReplacingMatchedPattern && existingRule.id === matchedRuleId) {
                existingRule.patterns = replacePattern(existingRule.patterns, matchedPatternValue, pattern);
                matchedPatternValue = pattern;
            } else if (!existingRule.patterns.includes(pattern)) {
                existingRule.patterns.push(pattern);
            }
            const idx = existingRules.indexOf(existingRule);
            if (idx > -1) existingRules[idx] = existingRule;
        } else {
            // Create truly new rule
            const newRule = {
                id: Date.now().toString(),
                name,
                color,
                patterns: [pattern],
                merge: true,
            };
            if (icon) {
                newRule.icon = icon;
            }
            existingRules.push(newRule);
            ruleIdToUpdate = newRule.id;
        }

        if (Number.isInteger(browserGroupId)) {
            const updatedRule = existingRules.find(rule => rule.id === ruleIdToUpdate);
            chrome.tabGroups.update(browserGroupId, { color, title: formatGroupTitle(updatedRule) }).catch(() => { });
        }

    } else {
        // Standard update existing rule
        const ruleIndex = existingRules.findIndex(r => r.id === ruleIdToUpdate);
        if (ruleIndex > -1) {
            const rule = existingRules[ruleIndex];
            const name = els.newGroupNameInput ? els.newGroupNameInput.value.trim() : rule.name;
            const color = els.newGroupColorInput ? els.newGroupColorInput.value : rule.color;
            const icon = els.newGroupIconInput ? normalizeGroupIcon(els.newGroupIconInput.value) : '';
            if (!name) {
                alert('Please enter a group name');
                return;
            }

            rule.name = name;
            rule.color = color;
            if (icon) {
                rule.icon = icon;
            } else {
                delete rule.icon;
            }
            if (isReplacingMatchedPattern) {
                rule.patterns = replacePattern(rule.patterns, matchedPatternValue, pattern);
                matchedPatternValue = pattern;
            } else if (!rule.patterns.includes(pattern)) {
                rule.patterns.push(pattern);
            }
            existingRules[ruleIndex] = rule;
            await updateOpenGroupsAppearance(rule);
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

function openOptionsPage() {
    popupLogger?.info('Opening options page');
    const url = chrome.runtime.getURL('options.html');
    chrome.tabs.create({ url }).catch(() => {
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open(url);
        }
    });
}

function showRulesForCurrentGroup(els) {
    const groupName = els.currentGroupNameSpan ? els.currentGroupNameSpan.textContent : '';
    const matchingRules = existingRules.filter(rule => normalizeGroupName(rule.name) === normalizeGroupName(groupName));

    if (matchingRules.length === 0) {
        alert(`No saved rules found for "${groupName || 'this group'}".`);
        return;
    }

    const summary = matchingRules.map(rule => {
        const patterns = Array.isArray(rule.patterns) && rule.patterns.length > 0
            ? rule.patterns.map(pattern => `  - ${pattern}`).join('\n')
            : '  - No patterns';
        const fixedTabs = Array.isArray(rule.fixedTabs) && rule.fixedTabs.length > 0
            ? '\nFixed positions:\n' + rule.fixedTabs.map(entry => `  - #${entry.index}: ${entry.url}`).join('\n')
            : '';

        return `${formatGroupTitle(rule)} [${rule.color || 'blue'}]\nMerge: ${rule.merge !== false ? 'yes' : 'no'}\nPatterns:\n${patterns}${fixedTabs}`;
    }).join('\n\n');

    alert(summary);
}

function normalizeGroupName(name) {
    return normalizeGroupTitle(name);
}

function replacePattern(patterns, previousPattern, nextPattern) {
    const source = Array.isArray(patterns) ? patterns : [];
    const normalizedNext = String(nextPattern || '').trim();
    const normalizedPrevious = String(previousPattern || '').trim();
    const replaced = source.map(pattern => pattern === normalizedPrevious ? normalizedNext : pattern);
    const unique = [];

    replaced.forEach(pattern => {
        const value = String(pattern || '').trim();
        if (!value || unique.includes(value)) return;
        unique.push(value);
    });

    if (!unique.includes(normalizedNext) && normalizedNext) {
        unique.push(normalizedNext);
    }

    return unique;
}

function setSelectedColor(els, color) {
    if (els.newGroupColorInput) els.newGroupColorInput.value = color;
    if (!els.colorDots) return;

    els.colorDots.forEach(dot => {
        dot.classList.toggle('selected', dot.dataset.color === color);
    });
}

function setSelectedIcon(els, icon) {
    const safeIcon = normalizeGroupIcon(icon);
    if (els.newGroupIconInput) els.newGroupIconInput.value = safeIcon;
    if (els.newGroupIconPreview) {
        els.newGroupIconPreview.textContent = safeIcon ? `${safeIcon} Emoji selected` : 'No emoji';
    }
    if (els.newGroupIconToggleBtn) {
        els.newGroupIconToggleBtn.textContent = safeIcon ? 'Change emoji' : 'Add emoji';
    }
    if (els.newGroupIconPanel && !els.newGroupIconPanel.hidden) {
        renderEmojiOptions(els, els.newGroupIconSearchInput ? els.newGroupIconSearchInput.value : '');
    }
}

async function setEmojiPickerOpen(els, isOpen) {
    if (!els.newGroupIconPanel) return;
    els.newGroupIconPanel.hidden = !isOpen;
    if (isOpen) {
        await ensureEmojiPickerDataLoaded();
        renderEmojiOptions(els, els.newGroupIconSearchInput ? els.newGroupIconSearchInput.value : '');
    }
}

function renderEmojiOptions(els, query) {
    if (!els.iconOptionsContainer) return;

    const selectedIcon = els.newGroupIconInput ? els.newGroupIconInput.value : '';
    const matches = filterEmojiOptions(query, 60);
    const buttons = [
        createEmojiOption('', 'No icon', selectedIcon === ''),
        ...matches.map(entry => createEmojiOption(
            entry.emoji,
            `${entry.label}${entry.tags && entry.tags.length ? `: ${entry.tags.join(', ')}` : ''}`,
            selectedIcon === entry.emoji
        ))
    ];

    els.iconOptionsContainer.replaceChildren(...buttons);
}

function createEmojiOption(icon, title, selected) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'emoji-option';
    button.dataset.icon = icon;
    button.title = title;
    button.textContent = icon || 'None';
    button.classList.toggle('selected', selected);
    return button;
}

function filterEmojiOptions(query, limit) {
    const normalizedQuery = String(query || '').trim().toLowerCase();
    const source = Array.isArray(emojiPickerOptions) ? emojiPickerOptions : [];
    if (!normalizedQuery) return source.slice(0, limit);

    const terms = normalizedQuery.split(/\s+/).filter(Boolean);
    return source
        .filter(entry => {
            const haystack = [
                entry.emoji,
                entry.label,
                ...(Array.isArray(entry.tags) ? entry.tags : [])
            ].join(' ').toLowerCase();
            return terms.every(term => haystack.includes(term));
        })
        .slice(0, limit);
}

async function ensureEmojiPickerDataLoaded() {
    if (Array.isArray(globalThis.AutoGroupEmojiData) && globalThis.AutoGroupEmojiData.length > 0) {
        emojiPickerOptions = globalThis.AutoGroupEmojiData;
        return emojiPickerOptions;
    }

    if (!emojiDataLoadPromise) {
        emojiDataLoadPromise = new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = 'emoji-data.js';
            script.onload = () => {
                emojiPickerOptions = Array.isArray(globalThis.AutoGroupEmojiData) ? globalThis.AutoGroupEmojiData : emojiPickerOptions;
                resolve(emojiPickerOptions);
            };
            script.onerror = () => resolve(emojiPickerOptions);
            document.head.appendChild(script);
        });
    }

    return emojiDataLoadPromise;
}

async function updateOpenGroupsAppearance(rule) {
    if (!rule || !rule.name || !rule.color) return;

    const groups = await chrome.tabGroups.query({}).catch(() => []);
    await Promise.all(groups
        .filter(group => normalizeGroupName(group.title) === normalizeGroupName(rule.name))
        .map(group => chrome.tabGroups.update(group.id, { color: rule.color, title: formatGroupTitle(rule) }).catch(() => {})));
}

function handlePopupFatalError(error) {
    popupLogger?.error('Popup init failed', error);
    console.error('Init failed:', error);

    const body = document.body;
    if (!body) return;

    body.innerHTML = `
        <div style="padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#181c22;color:#f4f1ea;min-width:320px">
            <div style="font-size:14px;font-weight:600;margin-bottom:8px">AutoGroup+ popup failed</div>
            <div style="font-size:12px;line-height:1.5;color:#d6d3cd;margin-bottom:12px">
                ${escapeHtml(error && error.message ? error.message : String(error || 'Unknown error'))}
            </div>
            <div style="font-size:11px;color:#8f8a82">
                Check the popup console and the persisted diagnostics in chrome.storage.local.debugLogs.
            </div>
        </div>
    `;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getHexForColor(colorName) {
    const colors = {
        grey: '#5f6368', blue: '#1a73e8', red: '#d93025', yellow: '#f1c21b',
        green: '#1e8e3e', pink: '#d01884', purple: '#9334e6', cyan: '#007b83', orange: '#fa903e'
    };
    return colors[colorName] || '#fff';
}
