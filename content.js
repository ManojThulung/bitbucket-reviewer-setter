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

const CHIP_SELECTOR = [
    '[data-tag-text="true"]',
    '[class*="MultiValueLabel"]',
    '[class*="multiValueLabel"]',
    '[class*="multi-value__label"]'
].join(', ');

const CHIP_REMOVE_SELECTOR = [
    'button[aria-label^="Remove" i]',
    '[aria-label^="Remove" i]',
    '[class*="MultiValueRemove"]',
    '[class*="multiValueRemove"]',
    '[class*="multi-value__remove"]'
].join(', ');


let applying = false;

// Inline "remove everyone" button: danger red, with a darker shade for the failed state
// so it stays distinguishable from the idle colour.
const CLEAR_LABEL = 'Remove all';
const CLEAR_RED = '#de350b';
const CLEAR_RED_DARK = '#bf2600';

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
    document.querySelectorAll('.sr-apply-btn, .sr-clear-btn, .sr-group-select, .sr-add-btn, .sr-toast')
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
        // Each step is independent — a failure in one must not stop auto-apply running
        try { await autoSelectRepoGroup(); } catch (e) { console.warn('[SR] repo group select failed:', e); }
        try { await ensureInlineApplyButton(); } catch (e) { console.warn('[SR] inline button failed:', e); }
        try { watchForReviewerReset(); } catch (e) { console.warn('[SR] reset watch failed:', e); }
        maybeAutoApply();
    }, 300);
}

// Bitbucket's reviewer input specifically — branch selectors are react-select too
// and mount earlier, so a generic input[id^="react-select-"] check fires far too soon.
function findReviewerInputEl() {
    // 1. The known react-select instance id
    const byId = document.querySelector('#react-select-BitbucketPullRequestReviewers-input');
    if (byId) return byId;

    // 2. Any react-select input whose id mentions "review"
    const byPattern = [...document.querySelectorAll('input[id^="react-select-"]')]
        .find(i => /review/i.test(i.id));
    if (byPattern) return byPattern;

    // 3. Structural: the text input nearest the "Reviewers" label. Bitbucket renames
    //    these ids between releases, and without this fallback the auto-apply gate
    //    fails silently forever while manual apply (which has its own finder) works.
    const label = findReviewersLabel();
    if (label) {
        let el = label.parentElement;
        for (let i = 0; i < 6 && el; i++) {
            const cand = el.querySelector(
                'input[role="combobox"], input[id^="react-select-"], input[type="text"], input:not([type])');
            if (cand) return cand;
            el = el.parentElement;
        }
    }
    return null;
}

// Auto-apply the active group once per Create PR page visit (opt-in, off by default).
// State is claimed synchronously so overlapping observer ticks can't double-apply.
const AUTO_APPLY_MAX_ATTEMPTS = 3;
const MAX_REAPPLIES = 4;
let autoApplyState = 'idle'; // idle | running | done
let autoApplyAttempts = 0;
let autoApplyPref = null;    // cached setting; null = not read yet
let appliedNames = null;     // what we last successfully applied
let reapplies = 0;
let lastDestSig = null;
let gateLoggedAt = 0;

// A stable fingerprint of the current reviewer chips
function chipSignature() {
    return chipLabels().map(c => normName(c.textContent)).filter(Boolean).sort();
}

// Target branch, read from the URL Bitbucket keeps in sync with the form
function destSignature() {
    const p = new URLSearchParams(location.search);
    return p.get('dest') || p.get('destination') || p.get('targetBranch') || '';
}

// Wait until the chips stop changing. Bitbucket loads its default reviewers for the
// target branch asynchronously, and applying before that lands means its defaults
// arrive on top of ours — which looks exactly like auto-apply never ran.
// minMs matters: an empty field goes "quiet" instantly, but empty usually means
// Bitbucket simply hasn't fetched its defaults yet — applying then puts our reviewers
// underneath the defaults that arrive a moment later.
async function waitForChipsToSettle(quietMs = 900, maxMs = 9000, minMs = 2500) {
    const start = Date.now();
    let last = null;
    let stableSince = start;
    while (Date.now() - start < maxMs) {
        const sig = chipSignature().join('|');
        if (sig !== last) {
            last = sig;
            stableSince = Date.now();
        } else if (Date.now() - stableSince >= quietMs && Date.now() - start >= minMs) {
            return;
        }
        await delay(150);
    }
    console.info('[SR] reviewer list never settled; applying anyway');
}

// Re-arm auto-apply when Bitbucket resets the reviewers: switching the target branch
// repopulates its own defaults, and late-loading defaults can land after we applied.
function watchForReviewerReset() {
    if (!isCreatePrPage()) {
        lastDestSig = null;
        reapplies = 0;
        appliedNames = null;
        return;
    }
    if (!autoApplyPref || applying) return;

    const dest = destSignature();
    if (lastDestSig === null) {
        lastDestSig = dest;
    } else if (dest !== lastDestSig) {
        lastDestSig = dest;
        rearmAutoApply('target branch changed');
        return;
    }

    // Someone we did not add showed up — that's Bitbucket repopulating its defaults
    if (autoApplyState === 'done' && appliedNames) {
        const foreign = chipSignature().some(n => !appliedNames.includes(n));
        if (foreign) rearmAutoApply('reviewers were reset');
    }
}

function rearmAutoApply(why) {
    if (reapplies >= MAX_REAPPLIES) return;
    reapplies++;
    console.info(`[SR] ${why} — re-applying reviewers (${reapplies}/${MAX_REAPPLIES})`);
    autoApplyState = 'idle';
    autoApplyAttempts = 0;
    appliedNames = null;
    scheduleInlineRefresh();
}

async function maybeAutoApply() {
    if (!isCreatePrPage()) {
        autoApplyState = 'idle';
        autoApplyAttempts = 0;
        return;
    }
    if (autoApplyState !== 'idle') return;
    // null = preference not read yet (primed at startup); false = switched off
    if (autoApplyPref !== true) return;

    // The field counts as ready if the label is there and we can find either the input
    // or existing chips — main-world has its own input finder, so a miss here must not
    // block us. All checks stay synchronous: claiming the lock after an await races.
    const label = findReviewersLabel();
    const input = findReviewerInputEl();
    const chips = chipLabels().length;
    if (!label || (!input && !chips)) {
        // Never fail silently — a blocked gate used to be invisible
        if (Date.now() - gateLoggedAt > 10000) {
            gateLoggedAt = Date.now();
            console.info(`[SR] auto-apply waiting for the reviewers field — label=${!!label} input=${!!input} chips=${chips}`);
        }
        return;
    }
    autoApplyState = 'running';

    autoApplyAttempts++;
    console.info(`[SR] auto-apply: reviewer field ready, attempt ${autoApplyAttempts}`);

    // Let Bitbucket finish loading its own default reviewers before touching them
    (async () => {
        await waitForChipsToSettle();
        // A manual Clear during the settle window takes precedence over auto-apply
        if (autoApplyState !== 'running') return;

        const state = await getGroupsState();
        if (!state) { autoApplyState = 'done'; return; }
        const group = state.groups.find(g => g.id === state.activeGroupId) || state.groups[0];
        if (!group.reviewers.length) {
            console.info(`[SR] auto-apply: group "${group.name}" is empty, nothing to do`);
            autoApplyState = 'done';
            return;
        }

        const snapshot = chipLabels().map(c => c.textContent.trim());
        const target = group.reviewers.map(r => normName(r.name)).sort();
        const current = chipSignature();
        if (target.length === current.length && target.every((n, i) => n === current[i])) {
            console.info('[SR] auto-apply: reviewers already match, nothing to do');
            appliedNames = target;
            autoApplyState = 'done';
            return;
        }

        try {
            await applyReviewers(group.reviewers);
            await rememberRepoGroup(group.id);
            // Record what we INTENDED, not the field afterwards: Bitbucket can add its
            // defaults while we're applying, and capturing those would make the reset
            // watcher treat them as ours and never notice the clobber.
            appliedNames = target;
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
    })();
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
    let clr = document.querySelector('.sr-clear-btn');
    if (btn && !btn.isConnected) btn = null;
    if (sel && !sel.isConnected) sel = null;
    if (clr && !clr.isConnected) clr = null;
    const removeAll = () => { btn?.remove(); sel?.remove(); clr?.remove(); };
    if (!isCreatePrPage()) { removeAll(); return; }

    const label = findReviewersLabel();
    if (!label) { removeAll(); return; }

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
    if (!clr) {
        clr = document.createElement('button');
        clr.className = 'sr-clear-btn';
        clr.type = 'button';
        clr.title = 'Remove every reviewer from this pull request';
        // Destructive action, so it carries the danger colour rather than sitting
        // quietly next to Apply
        clr.style.cssText = `
            margin-left: 6px;
            padding: 4px 10px;
            font-size: 12px;
            font-weight: 500;
            background: ${CLEAR_RED};
            color: white;
            border: none;
            border-radius: 3px;
            cursor: pointer;
            vertical-align: middle;
        `;
        clr.addEventListener('click', onInlineClear);
    }
    // Order: Reviewers label → group select → Apply → Clear
    if (sel.previousElementSibling !== label) label.insertAdjacentElement('afterend', sel);
    if (btn.previousElementSibling !== sel) sel.insertAdjacentElement('afterend', btn);
    if (clr.previousElementSibling !== btn) btn.insertAdjacentElement('afterend', clr);

    // Only meaningful when there is something to remove
    if (!clr.dataset.busy) {
        const hasChips = chipLabels().length > 0;
        clr.textContent = CLEAR_LABEL;
        clr.disabled = !hasChips;
        clr.style.opacity = hasChips ? '1' : '0.5';
        clr.style.cursor = hasChips ? 'pointer' : 'default';
    }

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

// Remove every reviewer from the field, without applying a group
async function onInlineClear() {
    const clr = document.querySelector('.sr-clear-btn');
    if (!clr || clr.dataset.busy || applying) return;
    if (!chipLabels().length) return;

    clr.dataset.busy = '1';
    clr.disabled = true;
    clr.textContent = 'Removing…';

    // Same suspension the apply path uses: stops "+ Add" injection and the reset
    // watcher from reacting to the chips we are about to remove.
    applying = true;
    document.querySelectorAll('.sr-add-btn').forEach(b => b.remove());
    try {
        await removeAllReviewers();
        // A manual clear has to stick. Marking auto-apply done (and forgetting what we
        // applied) stops it refilling the field a moment later; a target-branch change
        // still re-arms it, which is the one case where refilling is right.
        autoApplyState = 'done';
        appliedNames = null;
        const left = chipLabels().length;
        clr.textContent = left ? '✗ Failed' : '✓ Removed';
        clr.style.background = left ? CLEAR_RED_DARK : '#36b37e';
    } catch (err) {
        console.warn('[SR] remove all failed:', err);
        clr.textContent = '✗ Failed';
        clr.style.background = CLEAR_RED_DARK;
    } finally {
        applying = false;
    }

    setTimeout(() => {
        delete clr.dataset.busy;
        clr.disabled = false;
        clr.style.background = CLEAR_RED;
        ensureInlineApplyButton();
    }, 2000);
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
// React recreates the listbox on every open, so observers must be released when
// their listbox detaches — otherwise they pile up and each one re-scans on every mutation.
const listboxObservers = new Map();

function pruneListboxObservers() {
    for (const [listbox, obs] of listboxObservers) {
        if (!listbox.isConnected) {
            obs.disconnect();
            listboxObservers.delete(listbox);
        }
    }
}

const dropdownObserver = new MutationObserver(() => {
    if (!extensionAlive()) { teardown(); return; }
    scheduleInlineRefresh();
    // Stay out of the way while we're driving the field ourselves
    if (!isCreatePrPage() || applying) return;
    pruneListboxObservers();
    document.querySelectorAll('[role="listbox"]').forEach(listbox => {
        if (listboxObservers.has(listbox) || !isReviewerListbox(listbox)) return;
        injectAddButtons(listbox);

        const innerObserver = new MutationObserver(() => injectAddButtons(listbox));
        innerObserver.observe(listbox, { childList: true, subtree: true });
        listboxObservers.set(listbox, innerObserver);
        observers.push(innerObserver);
    });
});
dropdownObserver.observe(document.body, { childList: true, subtree: true });
observers.push(dropdownObserver);

// Prime the auto-apply preference up front so maybeAutoApply can check it
// synchronously, instead of claiming its lock and then awaiting storage.
storage.get('autoApply').then(data => {
    if (data) autoApplyPref = !!data.autoApply;
    console.info(`[SR] loaded — auto-apply is ${autoApplyPref ? 'ON' : 'off'}`);
    scheduleInlineRefresh();
});

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
    if (applying || !listbox.isConnected) return;
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
        const chips = [...document.querySelectorAll(CHIP_SELECTOR)]
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
    // Suspend our own DOM injection for the duration; see the `applying` comment above
    applying = true;
    document.querySelectorAll('.sr-add-btn').forEach(b => b.remove());
    const t0 = Date.now();
    try {
        // Clear the field FIRST. react-select hides already-selected people from its
        // search results, so anything left behind can never be re-selected — we'd wait
        // out the full timeout for an option that cannot render.
        await removeAllReviewers();

        for (const reviewer of reviewers) {
            await addReviewer(reviewer);
        }

        // Judge success by what is actually in the field, not by each add's return
        // value: an add can time out after it already landed, and a reviewer who was
        // present all along may be skipped without us having detected it.
        const failed = [...new Set(reviewers.filter(r => !isInField(r.name)).map(r => r.name))];
        console.info(`[SR] apply: ${reviewers.length - failed.length}/${reviewers.length} in field after ${Date.now() - t0}ms`);

        if (failed.length) {
            throw new Error(`Could not add: ${failed.join(', ')}. Try again — the rest were applied.`);
        }
    } finally {
        applying = false;
    }
}

const normName = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// Whole-name match: a chip may carry extra text, but a loose substring test would
// treat "John" as present when only "Johnathan" is.
function textHasName(text, name) {
    const t = normName(text);
    const n = normName(name);
    if (!n) return false;
    if (t === n) return true;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|\\s)${esc}(\\s|,|$)`).test(t);
}

// Is this reviewer currently a chip in the Reviewers field?
function isInField(name) {
    return chipLabels().some(c => textHasName(c.textContent, name));
}

// Nearest ancestor of the reviewer input that also holds the chips, so tags belonging
// to other fields on the page can never be mistaken for reviewers.
function reviewersFieldRoot() {
    const input = findReviewerInputEl();
    if (!input) return document;
    let el = input.parentElement;
    for (let i = 0; i < 8 && el; i++) {
        if (el.querySelector(CHIP_SELECTOR)) return el;
        el = el.parentElement;
    }
    return document;
}

// Every chip label currently in the Reviewers field
function chipLabels() {
    return [...reviewersFieldRoot().querySelectorAll(CHIP_SELECTOR)];
}

// The clickable "×" for a chip. Class names change between Bitbucket releases, so
// fall back to structure: any button/role=button, or an element labelled "remove".
function findRemoveControl(label) {
    const container = label.closest('[class*="MultiValue"], [class*="multi-value"]')
        || label.parentElement;
    if (!container) return null;
    const scopes = [container, container.parentElement].filter(Boolean);
    for (const scope of scopes) {
        const direct = scope.querySelector(CHIP_REMOVE_SELECTOR);
        if (direct) return direct;
        const labelled = [...scope.querySelectorAll('[aria-label]')]
            .find(el => /remove|clear|delete/i.test(el.getAttribute('aria-label')));
        if (labelled) return labelled;
        const button = scope.querySelector('button, [role="button"]');
        if (button && !button.contains(label)) return button;
    }
    return null;
}

// Wait for the chip count to actually drop. A fixed delay is not safe here: React can
// take well over 100ms to re-render a long reviewer list on a busy page, and treating
// that as "the click did nothing" aborts the whole clear.
async function waitForChipDrop(from, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await delay(80);
        if (chipLabels().length < from) return true;
    }
    return false;
}

// react-select removes the last selected value on Backspace when the input is empty.
// Class-name independent, so it works even when the markup changes underneath us.
async function clearWithBackspace() {
    const input = findReviewerInputEl();
    if (!input) return;
    let stalls = 0;
    for (let i = 0; i < 60 && chipLabels().length; i++) {
        const before = chipLabels().length;
        input.focus();
        for (const type of ['keydown', 'keyup']) {
            input.dispatchEvent(new KeyboardEvent(type, {
                bubbles: true, cancelable: true,
                key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8
            }));
        }
        if (await waitForChipDrop(before, 1200)) stalls = 0;
        else if (++stalls >= 3) return;   // genuinely not working
    }
}

// Clear the whole Reviewers field before adding: react-select hides already-selected
// people from search, so anything left behind can never be re-selected as an option.
async function removeAllReviewers() {
    const started = chipLabels().length;
    if (!started) {
        // Log rather than return silently: "no chips" and "chip selectors don't match
        // this markup" look identical from here, and the latter is a real bug.
        console.info('[SR] no existing reviewer chips detected — nothing to clear');
        return;
    }

    let stalls = 0;
    // Generous guard: one pass per chip, plus room for retries
    for (let guard = 0; guard < started * 3 + 10; guard++) {
        const labels = chipLabels();
        if (!labels.length) break;

        // On a stall, try a different chip — one uncooperative button shouldn't
        // block the rest of the list.
        const label = labels[Math.min(stalls, labels.length - 1)];
        const btn = findRemoveControl(label);
        if (!btn) break;                          // fall through to the keyboard path

        btn.click();
        if (await waitForChipDrop(labels.length)) {
            stalls = 0;
        } else if (++stalls >= 3) {
            break;                                // clicking isn't landing; try Backspace
        }
    }

    if (chipLabels().length) await clearWithBackspace();

    const left = chipLabels().length;
    if (left) {
        console.warn(`[SR] could not clear ${left} of ${started} reviewers — remove control not responding`);
    } else {
        console.info(`[SR] cleared ${started} existing reviewer(s)`);
    }
}

async function addReviewer(reviewer) {
    // Outlast main-world's 10s dropdown timeout
    const result = await askMainWorld('sr-add-reviewer', { reviewer }, 13000);
    if (!result?.ok) {
        console.warn('[SR] addReviewer failed:', reviewer.name, result);
    }
    await delay(400); // let React render the new chip
    return !!result?.ok;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
