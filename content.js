// Ask main-world.js via CustomEvent; timeoutMs must outlast its internal timeout
function askMainWorld(eventName, payload, timeoutMs = 5000) {
    return new Promise((resolve) => {
        const eventId = `sr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const onResponse = e => {
            clearTimeout(timer);
            resolve(e.detail);
        };
        const timer = setTimeout(() => {
            window.removeEventListener(eventId, onResponse);
            resolve(null);
        }, timeoutMs);
        window.addEventListener(eventId, onResponse, { once: true });
        window.dispatchEvent(new CustomEvent(eventName, { detail: { ...payload, eventId } }));
    });
}

// Reloading the extension orphans this script: chrome.* still exists but every call
// throws "Extension context invalidated". Detect that and shut down instead of spamming errors.
const observers = [];
let dead = false;

function extensionAlive() {
    try {
        return !dead && !!chrome.runtime?.id;
    } catch {
        return false;
    }
}

// Stop all work and strip injected UI; the page needs a reload to get a fresh script
function teardown() {
    if (dead) return;
    dead = true;
    observers.forEach(o => o.disconnect());
    clearTimeout(inlineTimer);
    document.querySelectorAll('.sr-apply-btn, .sr-group-select, .sr-add-btn, .sr-toast')
        .forEach(el => el.remove());
    console.info('[SR] extension was reloaded — refresh this page to re-enable');
}

// Storage wrappers that return null/false once the context is gone
const storage = {
    async get(keys) {
        if (!extensionAlive()) { teardown(); return null; }
        try {
            return await chrome.storage.local.get(keys);
        } catch {
            teardown();
            return null;
        }
    },
    async set(obj) {
        if (!extensionAlive()) { teardown(); return false; }
        try {
            await chrome.storage.local.set(obj);
            return true;
        } catch {
            teardown();
            return false;
        }
    },
    async remove(keys) {
        if (!extensionAlive()) { teardown(); return false; }
        try {
            await chrome.storage.local.remove(keys);
            return true;
        } catch {
            teardown();
            return false;
        }
    }
};

// Load groups state, migrating the old flat savedReviewers list on first run.
// Returns null if the extension context is gone.
async function getGroupsState() {
    const data = await storage.get(['groups', 'activeGroupId', 'savedReviewers']);
    if (!data) return null;
    const { groups, activeGroupId, savedReviewers } = data;
    if (Array.isArray(groups) && groups.length) {
        // One-time rename of the old auto-created "Default" group
        const stale = groups.filter(g => g.name === 'Default');
        if (stale.length) {
            stale.forEach(g => { g.name = 'My Team'; });
            await storage.set({ groups });
        }
        const validId = groups.some(g => g.id === activeGroupId) ? activeGroupId : groups[0].id;
        return { groups, activeGroupId: validId };
    }
    const def = { id: 'g' + Date.now().toString(36), name: 'My Team', reviewers: savedReviewers || [] };
    const state = { groups: [def], activeGroupId: def.id };
    await storage.set(state);
    await storage.remove('savedReviewers');
    return state;
}

// True on the Create PR page (checked per-event; Bitbucket is a SPA)
function isCreatePrPage() {
    return location.pathname.includes('/pull-requests/new');
}

// True only for the Reviewers listbox, not branch/other dropdowns
function isReviewerListbox(listbox) {
    if (/review/i.test(listbox.id || '')) return true;
    const active = document.activeElement;
    if (!active || !/review/i.test(active.id || '')) return false;
    const controls = active.getAttribute('aria-controls') || active.getAttribute('aria-owns');
    return !controls || controls === listbox.id;
}

// "workspace/repo" from the URL, or null
function repoSlug() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)\//);
    return m ? `${m[1]}/${m[2]}` : null;
}

// Remember which group was last applied in this repo
async function rememberRepoGroup(groupId) {
    const slug = repoSlug();
    if (!slug || !groupId) return;
    const data = await storage.get('repoGroups');
    if (!data) return;
    const repoGroups = data.repoGroups || {};
    if (repoGroups[slug] !== groupId) {
        repoGroups[slug] = groupId;
        await storage.set({ repoGroups });
    }
}

// Auto-select the repo's remembered group, once per visit so manual switches stick
let lastAutoSlug = null;
async function autoSelectRepoGroup() {
    if (!isCreatePrPage()) { lastAutoSlug = null; return; }
    const slug = repoSlug();
    if (!slug || slug === lastAutoSlug) return;
    lastAutoSlug = slug;
    const data = await storage.get('repoGroups');
    if (!data) return;
    const mapped = (data.repoGroups || {})[slug];
    if (!mapped) return;
    const state = await getGroupsState();
    if (!state) return;
    if (mapped !== state.activeGroupId && state.groups.some(g => g.id === mapped)) {
        await storage.set({ activeGroupId: mapped });
    }
}

// Cache group state; invalidated on any storage change
let groupStateCache = null;
async function getGroupsStateCached() {
    if (!groupStateCache) groupStateCache = await getGroupsState();
    return groupStateCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.autoApply) {
        autoApplyPref = !!changes.autoApply.newValue;
        // Re-arm so switching the toggle on takes effect without a reload
        if (autoApplyPref && autoApplyState === 'done') autoApplyState = 'idle';
    }
    if (!changes.groups && !changes.activeGroupId && !changes.autoApply) return;
    groupStateCache = null;
    scheduleInlineRefresh();
});

// Debounced refresh of the inline button (observer fires on every DOM change)
let inlineTimer = null;
function scheduleInlineRefresh() {
    if (inlineTimer || !extensionAlive()) return;
    inlineTimer = setTimeout(async () => {
        inlineTimer = null;
        if (!extensionAlive()) { teardown(); return; }
        await autoSelectRepoGroup();
        await ensureInlineApplyButton();
        maybeAutoApply();
    }, 300);
}

// Bitbucket's reviewer input specifically — branch selectors are react-select too
// and mount earlier, so a generic input[id^="react-select-"] check fires far too soon.
function findReviewerInputEl() {
    return document.querySelector('#react-select-BitbucketPullRequestReviewers-input')
        || [...document.querySelectorAll('input[id^="react-select-"]')].find(i => /review/i.test(i.id))
        || null;
}

// Auto-apply the active group once per Create PR page visit (opt-in, off by default).
// State is claimed synchronously so overlapping observer ticks can't double-apply.
const AUTO_APPLY_MAX_ATTEMPTS = 3;
let autoApplyState = 'idle'; // idle | running | done
let autoApplyAttempts = 0;
let autoApplyPref = null;    // cached setting; null = not read yet

async function maybeAutoApply() {
    if (!isCreatePrPage()) {
        autoApplyState = 'idle';
        autoApplyAttempts = 0;
        return;
    }
    if (autoApplyState !== 'idle') return;
    // Both checks must be synchronous — claiming the lock after an await races
    if (!findReviewersLabel() || !findReviewerInputEl()) return;
    autoApplyState = 'running';

    if (autoApplyPref === null) {
        const data = await storage.get('autoApply');
        if (!data) { autoApplyState = 'idle'; return; }
        autoApplyPref = !!data.autoApply;
    }
    // 'done' rather than 'idle' so we stop re-checking every tick; the storage
    // listener re-arms this the moment the toggle is switched on.
    if (!autoApplyPref) { autoApplyState = 'done'; return; }

    autoApplyAttempts++;
    console.info(`[SR] auto-apply: reviewer field ready, attempt ${autoApplyAttempts}`);

    // Let Bitbucket finish mounting its default reviewers before touching them
    setTimeout(async () => {
        const state = await getGroupsState();
        if (!state) { autoApplyState = 'done'; return; }
        const group = state.groups.find(g => g.id === state.activeGroupId) || state.groups[0];
        if (!group.reviewers.length) {
            console.info(`[SR] auto-apply: group "${group.name}" is empty, nothing to do`);
            autoApplyState = 'done';
            return;
        }

        const snapshot = [...document.querySelectorAll('.-MultiValueLabel')].map(c => c.textContent.trim());
        const target = new Set(group.reviewers.map(r => r.name.toLowerCase()));
        const current = new Set(snapshot.map(n => n.toLowerCase()));
        if (target.size === current.size && [...target].every(n => current.has(n))) {
            console.info('[SR] auto-apply: reviewers already match, nothing to do');
            autoApplyState = 'done';
            return;
        }

        try {
            await applyReviewers(group.reviewers);
            await rememberRepoGroup(group.id);
            autoApplyState = 'done';
            showToast(`Reviewers set to "${group.name}"`, snapshot);
        } catch (err) {
            // The field may still have been settling; allow a bounded retry
            if (autoApplyAttempts < AUTO_APPLY_MAX_ATTEMPTS) {
                console.warn(`[SR] auto-apply attempt ${autoApplyAttempts} failed, will retry:`, err.message);
                autoApplyState = 'idle';
                scheduleInlineRefresh();
            } else {
                console.warn('[SR] auto-apply failed:', err);
                autoApplyState = 'done';
                showToast(`Auto-apply failed: ${err.message}`, null);
            }
        }
    }, 1200);
}

// Bitbucket-styled toast; Undo restores the pre-apply reviewer snapshot
function showToast(message, undoSnapshot) {
    document.querySelector('.sr-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'sr-toast';
    toast.style.cssText = `
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        background: #172b4d;
        color: white;
        border-radius: 4px;
        font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-shadow: 0 8px 16px rgba(9, 30, 66, 0.25);
    `;
    const text = document.createElement('span');
    text.textContent = message;
    toast.appendChild(text);

    const dismiss = setTimeout(() => toast.remove(), 10000);

    if (undoSnapshot) {
        const undo = document.createElement('button');
        undo.textContent = 'Undo';
        undo.style.cssText = 'background:none; border:none; color:#4c9aff; font-weight:600; font-size:13px; cursor:pointer; padding:0;';
        undo.addEventListener('click', async () => {
            clearTimeout(dismiss);
            undo.remove();
            text.textContent = 'Restoring previous reviewers…';
            try {
                await applyReviewers(undoSnapshot.map(name => ({ name })));
                text.textContent = 'Previous reviewers restored.';
            } catch (err) {
                text.textContent = 'Restore failed: ' + err.message;
            }
            setTimeout(() => toast.remove(), 3000);
        });
        toast.appendChild(undo);
    }

    const close = document.createElement('button');
    close.textContent = '×';
    close.style.cssText = 'background:none; border:none; color:#97a0af; font-size:16px; cursor:pointer; padding:0; line-height:1;';
    close.addEventListener('click', () => { clearTimeout(dismiss); toast.remove(); });
    toast.appendChild(close);

    document.body.appendChild(toast);
}

// Leaf element whose text is exactly "Reviewers"
function findReviewersLabel() {
    return [...document.querySelectorAll('label, h2, h3, h4, span, div')]
        .find(el => el.childElementCount === 0
            && /^reviewers?$/i.test(el.textContent.trim())
            && !el.closest('[role="listbox"]'));
}

// Keep a group selector + "Apply" button next to the Reviewers label on the Create PR page
async function ensureInlineApplyButton() {
    let btn = document.querySelector('.sr-apply-btn');
    let sel = document.querySelector('.sr-group-select');
    if (btn && !btn.isConnected) btn = null;
    if (sel && !sel.isConnected) sel = null;
    if (!isCreatePrPage()) { btn?.remove(); sel?.remove(); return; }

    const label = findReviewersLabel();
    if (!label) { btn?.remove(); sel?.remove(); return; }

    if (!sel) {
        sel = document.createElement('select');
        sel.className = 'sr-group-select';
        sel.title = 'Active reviewer group';
        sel.style.cssText = `
            margin-left: 8px;
            padding: 3px 4px;
            max-width: 150px;
            font-size: 12px;
            color: #172b4d;
            background: #fafbfc;
            border: 2px solid #dfe1e6;
            border-radius: 3px;
            cursor: pointer;
            vertical-align: middle;
            outline: none;
        `;
        sel.addEventListener('mousedown', e => e.stopPropagation());
        sel.addEventListener('change', () => storage.set({ activeGroupId: sel.value }));
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.className = 'sr-apply-btn';
        btn.type = 'button';
        btn.style.cssText = `
            margin-left: 6px;
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 500;
            background: #0052cc;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            vertical-align: middle;
        `;
        btn.addEventListener('click', onInlineApply);
    }
    if (sel.previousElementSibling !== label) label.insertAdjacentElement('afterend', sel);
    if (btn.previousElementSibling !== sel) sel.insertAdjacentElement('afterend', btn);

    const state = await getGroupsStateCached();
    if (!state) return;
    const { groups, activeGroupId } = state;
    const group = groups.find(g => g.id === activeGroupId) || groups[0];

    // Rebuild options only when data changed and the select isn't being used
    if (document.activeElement !== sel) {
        const sig = groups.map(g => `${g.id}:${g.name}:${g.reviewers.length}`).join('|') + '@' + group.id;
        if (sel.dataset.sig !== sig) {
            sel.dataset.sig = sig;
            sel.innerHTML = '';
            groups.forEach(g => {
                const opt = document.createElement('option');
                opt.value = g.id;
                opt.textContent = `${g.name} (${g.reviewers.length})`;
                sel.appendChild(opt);
            });
            sel.value = group.id;
        }
    }

    if (btn.dataset.busy) return; // don't clobber Applying/result feedback
    btn.textContent = 'Apply';
    const empty = group.reviewers.length === 0;
    btn.disabled = empty;
    btn.style.opacity = empty ? '0.5' : '1';
    btn.style.cursor = empty ? 'default' : 'pointer';
}

// Apply the active group straight from the page
async function onInlineApply() {
    const btn = document.querySelector('.sr-apply-btn');
    if (!btn || btn.dataset.busy) return;
    const state = await getGroupsStateCached();
    if (!state) return;
    const group = state.groups.find(g => g.id === state.activeGroupId) || state.groups[0];
    if (!group.reviewers.length) return;

    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = 'Applying…';
    try {
        await applyReviewers(group.reviewers);
        await rememberRepoGroup(group.id);
        btn.textContent = '✓ Applied';
        btn.style.background = '#36b37e';
    } catch (err) {
        console.warn('[SR] inline apply failed:', err);
        btn.textContent = '✗ Failed';
        btn.title = err.message;
        btn.style.background = '#de350b';
    }
    setTimeout(() => {
        delete btn.dataset.busy;
        btn.disabled = false;
        btn.title = '';
        btn.style.background = '#0052cc';
        ensureInlineApplyButton();
    }, 2500);
}

// Inject "+ Add" buttons when the reviewer dropdown opens
const dropdownObserver = new MutationObserver(() => {
    if (!extensionAlive()) { teardown(); return; }
    scheduleInlineRefresh();
    if (!isCreatePrPage()) return;
    document.querySelectorAll('[role="listbox"]').forEach(listbox => {
        if (listbox.dataset.srInjected || !isReviewerListbox(listbox)) return;
        listbox.dataset.srInjected = 'true';
        injectAddButtons(listbox);

        const innerObserver = new MutationObserver(() => injectAddButtons(listbox));
        innerObserver.observe(listbox, { childList: true, subtree: true });
        observers.push(innerObserver);
    });
});
dropdownObserver.observe(document.body, { childList: true, subtree: true });
observers.push(dropdownObserver);
scheduleInlineRefresh();

function extractFromDOM(optionEl) {
    const img = optionEl.querySelector('img');
    const avatarUrl = img?.src || '';

    const clone = optionEl.cloneNode(true);
    clone.querySelector('.sr-add-btn')?.remove();
    const name = clone.textContent.trim();

    // "initials" is a shared avatar-service path, not an account id
    const match = avatarUrl.match(/atl-paas\.net\/([^/]+)\//);
    const seg = match ? decodeURIComponent(match[1]) : null;
    const id = seg && seg !== 'initials' ? seg : name;

    return { id, name, avatarUrl };
}

function injectAddButtons(listbox) {
    listbox.querySelectorAll('[role="option"]').forEach((option, idx) => {
        // Refresh idx every pass; the option list changes as the user types
        option.setAttribute('data-sr-idx', idx);
        if (option.querySelector('.sr-add-btn')) return;

        const btn = document.createElement('button');
        btn.className = 'sr-add-btn';
        btn.textContent = '+ Add';
        btn.style.cssText = `
            order: 9999;
            margin-left: auto;
            padding: 2px 10px;
            font-size: 11px;
            font-weight: 600;
            background: #0052cc;
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            flex-shrink: 0;
            z-index: 9999;
        `;

        btn.addEventListener('mousedown', e => {
            e.stopPropagation();
            e.preventDefault();
        });

        btn.addEventListener('click', async e => {
            e.stopPropagation();
            e.preventDefault();

            // Read idx at click time; the closure value goes stale when the list re-renders
            const liveIdx = Number(option.getAttribute('data-sr-idx'));
            const rawData = await askMainWorld('sr-get-option-data', { idx: liveIdx });
            const domData = extractFromDOM(option);

            // Trust API data only when it describes the user we actually clicked
            const raw = rawData?.name && domData.name
                && rawData.name.toLowerCase() === domData.name.toLowerCase() ? rawData : null;
            const reviewer = {
                id: raw?.id || domData.id,
                name: domData.name || raw?.name,
                avatarUrl: raw?.avatarUrl || domData.avatarUrl
            };

            if (!reviewer.name) {
                console.warn('[SR] Could not read reviewer name from option');
                return;
            }

            // Save into the active group; dedupe by id or name
            const state = await getGroupsState();
            if (!state) {
                btn.textContent = 'Reload page';
                btn.style.background = '#de350b';
                return;
            }
            const group = state.groups.find(g => g.id === state.activeGroupId) || state.groups[0];
            const exists = group.reviewers.some(r =>
                r.id === reviewer.id || r.name.toLowerCase() === reviewer.name.toLowerCase());
            if (!exists) {
                group.reviewers.push(reviewer);
                await storage.set({ groups: state.groups });
            }

            btn.textContent = exists ? `Already in ${group.name}` : `✓ → ${group.name}`;
            btn.style.background = exists ? '#6b778c' : '#36b37e';
            setTimeout(() => {
                btn.textContent = '+ Add';
                btn.style.background = '#0052cc';
            }, 2000);
        });

        option.style.display = 'flex';
        option.style.alignItems = 'center';
        option.appendChild(btn);
    });
}

// Handle popup messages; Apply only allowed on the Create PR page
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'status') {
        const chips = [...document.querySelectorAll('.-MultiValueLabel')]
            .map(c => c.textContent.trim().toLowerCase());
        sendResponse({ ok: true, isCreatePrPage: isCreatePrPage(), currentReviewers: chips });
        return;
    }
    if (msg.action !== 'apply') return;
    if (!isCreatePrPage()) {
        sendResponse({ ok: false, error: 'Open a Create Pull Request page first (URL contains /pull-requests/new).' });
        return;
    }
    applyReviewers(msg.reviewers)
        .then(async () => {
            await rememberRepoGroup(msg.groupId);
            sendResponse({ ok: true });
        })
        .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
});

async function applyReviewers(reviewers) {
    // Add first so the input stays mounted
    const results = [];
    for (const reviewer of reviewers) {
        const ok = await addReviewer(reviewer);
        results.push({ name: reviewer.name, ok });
    }

    const failed = results.filter(r => !r.ok).map(r => r.name);

    // Only remove defaults if every saved reviewer was added
    if (failed.length === 0) {
        await removeUnwantedReviewers(reviewers);
    } else {
        throw new Error(`Could not add: ${failed.join(', ')}. Existing reviewers were left untouched.`);
    }
}

async function removeUnwantedReviewers(savedReviewers) {
    const savedNames = new Set(savedReviewers.map(r => r.name.toLowerCase()));
    const removeBtns = [...document.querySelectorAll('.-MultiValueRemove')];
    for (const btn of removeBtns) {
        const label = (btn.getAttribute('aria-label') || '').replace(/, remove$/i, '').toLowerCase();
        if (!savedNames.has(label)) {
            btn.click();
            await delay(100);
        }
    }
}

async function addReviewer(reviewer) {
    // Outlast main-world's 6s dropdown timeout
    const result = await askMainWorld('sr-add-reviewer', { reviewer }, 8000);
    if (!result?.ok) {
        console.warn('[SR] addReviewer failed:', reviewer.name, result);
    }
    await delay(400); // let React render the new chip
    return !!result?.ok;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
