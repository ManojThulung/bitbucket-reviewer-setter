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

// Load groups state, migrating the old flat savedReviewers list on first run
async function getGroupsState() {
    const { groups, activeGroupId, savedReviewers } = await chrome.storage.local.get(['groups', 'activeGroupId', 'savedReviewers']);
    if (Array.isArray(groups) && groups.length) {
        // One-time rename of the old auto-created "Default" group
        const stale = groups.filter(g => g.name === 'Default');
        if (stale.length) {
            stale.forEach(g => { g.name = 'My Team'; });
            await chrome.storage.local.set({ groups });
        }
        const validId = groups.some(g => g.id === activeGroupId) ? activeGroupId : groups[0].id;
        return { groups, activeGroupId: validId };
    }
    const def = { id: 'g' + Date.now().toString(36), name: 'My Team', reviewers: savedReviewers || [] };
    const state = { groups: [def], activeGroupId: def.id };
    await chrome.storage.local.set(state);
    await chrome.storage.local.remove('savedReviewers');
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
    const { repoGroups = {} } = await chrome.storage.local.get('repoGroups');
    if (repoGroups[slug] !== groupId) {
        repoGroups[slug] = groupId;
        await chrome.storage.local.set({ repoGroups });
    }
}

// Auto-select the repo's remembered group, once per visit so manual switches stick
let lastAutoSlug = null;
async function autoSelectRepoGroup() {
    if (!isCreatePrPage()) { lastAutoSlug = null; return; }
    const slug = repoSlug();
    if (!slug || slug === lastAutoSlug) return;
    lastAutoSlug = slug;
    const { repoGroups = {} } = await chrome.storage.local.get('repoGroups');
    const mapped = repoGroups[slug];
    if (!mapped) return;
    const { groups, activeGroupId } = await getGroupsState();
    if (mapped !== activeGroupId && groups.some(g => g.id === mapped)) {
        await chrome.storage.local.set({ activeGroupId: mapped });
    }
}

// Cache group state; invalidated on any storage change
let groupStateCache = null;
async function getGroupsStateCached() {
    if (!groupStateCache) groupStateCache = await getGroupsState();
    return groupStateCache;
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.groups && !changes.activeGroupId)) return;
    groupStateCache = null;
    scheduleInlineRefresh();
});

// Debounced refresh of the inline button (observer fires on every DOM change)
let inlineTimer = null;
function scheduleInlineRefresh() {
    if (inlineTimer) return;
    inlineTimer = setTimeout(async () => {
        inlineTimer = null;
        await autoSelectRepoGroup();
        await ensureInlineApplyButton();
        maybeAutoApply();
    }, 300);
}

// Auto-apply the active group once per Create PR page visit (opt-in, off by default)
let autoApplyDone = false;
async function maybeAutoApply() {
    if (!isCreatePrPage()) { autoApplyDone = false; return; }
    if (autoApplyDone) return;
    const { autoApply = false } = await chrome.storage.local.get('autoApply');
    if (!autoApply) return;
    // Wait until the reviewer field is actually mounted
    if (!findReviewersLabel() || !document.querySelector('input[id^="react-select-"]')) return;
    autoApplyDone = true;

    // Let Bitbucket finish mounting its default reviewers before touching them
    setTimeout(async () => {
        const { groups, activeGroupId } = await getGroupsState();
        const group = groups.find(g => g.id === activeGroupId) || groups[0];
        if (!group.reviewers.length) return;

        const snapshot = [...document.querySelectorAll('.-MultiValueLabel')].map(c => c.textContent.trim());
        const target = new Set(group.reviewers.map(r => r.name.toLowerCase()));
        const current = new Set(snapshot.map(n => n.toLowerCase()));
        if (target.size === current.size && [...target].every(n => current.has(n))) return;

        try {
            await applyReviewers(group.reviewers);
            await rememberRepoGroup(group.id);
            showToast(`Reviewers set to "${group.name}"`, snapshot);
        } catch (err) {
            console.warn('[SR] auto-apply failed:', err);
            showToast(`Auto-apply failed: ${err.message}`, null);
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

// Keep an "Apply" button next to the Reviewers label on the Create PR page
async function ensureInlineApplyButton() {
    let btn = document.querySelector('.sr-apply-btn');
    if (btn && !btn.isConnected) btn = null;
    if (!isCreatePrPage()) { btn?.remove(); return; }

    const label = findReviewersLabel();
    if (!label) { btn?.remove(); return; }

    if (!btn) {
        btn = document.createElement('button');
        btn.className = 'sr-apply-btn';
        btn.type = 'button';
        btn.style.cssText = `
            margin-left: 8px;
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
    if (btn.previousElementSibling !== label) label.insertAdjacentElement('afterend', btn);
    if (btn.dataset.busy) return; // don't clobber Applying/result feedback

    const { groups, activeGroupId } = await getGroupsStateCached();
    const group = groups.find(g => g.id === activeGroupId) || groups[0];
    btn.textContent = `Apply "${group.name}" (${group.reviewers.length})`;
    const empty = group.reviewers.length === 0;
    btn.disabled = empty;
    btn.style.opacity = empty ? '0.5' : '1';
    btn.style.cursor = empty ? 'default' : 'pointer';
}

// Apply the active group straight from the page
async function onInlineApply() {
    const btn = document.querySelector('.sr-apply-btn');
    if (!btn || btn.dataset.busy) return;
    const { groups, activeGroupId } = await getGroupsStateCached();
    const group = groups.find(g => g.id === activeGroupId) || groups[0];
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
    scheduleInlineRefresh();
    if (!isCreatePrPage()) return;
    document.querySelectorAll('[role="listbox"]').forEach(listbox => {
        if (listbox.dataset.srInjected || !isReviewerListbox(listbox)) return;
        listbox.dataset.srInjected = 'true';
        injectAddButtons(listbox);

        const innerObserver = new MutationObserver(() => injectAddButtons(listbox));
        innerObserver.observe(listbox, { childList: true, subtree: true });
    });
});
dropdownObserver.observe(document.body, { childList: true, subtree: true });
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
            const { groups, activeGroupId } = await getGroupsState();
            const group = groups.find(g => g.id === activeGroupId) || groups[0];
            const exists = group.reviewers.some(r =>
                r.id === reviewer.id || r.name.toLowerCase() === reviewer.name.toLowerCase());
            if (!exists) {
                group.reviewers.push(reviewer);
                await chrome.storage.local.set({ groups });
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
