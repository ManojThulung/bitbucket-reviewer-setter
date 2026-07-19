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

// Inject "+ Add" buttons when the reviewer dropdown opens
const dropdownObserver = new MutationObserver(() => {
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

function extractFromDOM(optionEl) {
    const img = optionEl.querySelector('img');
    const avatarUrl = img?.src || '';

    const clone = optionEl.cloneNode(true);
    clone.querySelector('.sr-add-btn')?.remove();
    const name = clone.textContent.trim();

    const match = avatarUrl.match(/atl-paas\.net\/([^/]+)\//);
    const id = match ? decodeURIComponent(match[1]) : name;

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

            // Prefer main-world's full API data; fall back to DOM
            const rawData = await askMainWorld('sr-get-option-data', { idx });
            const domData = extractFromDOM(option);

            const reviewer = {
                id: rawData?.id || domData.id,
                name: rawData?.name || domData.name,
                avatarUrl: rawData?.avatarUrl || domData.avatarUrl
            };

            if (!reviewer.name) {
                console.warn('[SR] Could not read reviewer name from option');
                return;
            }

            const { savedReviewers = [] } = await chrome.storage.local.get(['savedReviewers']);
            if (!savedReviewers.find(r => r.id === reviewer.id)) {
                savedReviewers.push(reviewer);
                await chrome.storage.local.set({ savedReviewers });
            }

            btn.textContent = '✓ Added';
            btn.style.background = '#36b37e';
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

// Handle Apply from the popup; only allowed on the Create PR page
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action !== 'apply') return;
    if (!isCreatePrPage()) {
        sendResponse({ ok: false, error: 'Open a Create Pull Request page first (URL contains /pull-requests/new).' });
        return;
    }
    applyReviewers(msg.reviewers)
        .then(() => sendResponse({ ok: true }))
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
