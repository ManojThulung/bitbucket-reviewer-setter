const apiDataCache = new Map();

function cacheUsers(users) {
    if (!Array.isArray(users)) return;
    users.forEach(user => {
        if (user && user.id && user.name) {
            apiDataCache.set(user.id, user);
            apiDataCache.set('name:' + user.name.toLowerCase(), user);
        }
    });
}

// Find user arrays anywhere in an API response
function harvestUsers(body) {
    if (!body || typeof body !== 'object') return;
    if (Array.isArray(body)) {
        const looksLikeUsers = body.some(x => (x && x.entityType === 'USER') || (x && x.id && x.name && x.avatarUrl));
        if (looksLikeUsers) cacheUsers(body);
        body.forEach(harvestUsers);
        return;
    }
    if (Array.isArray(body.recommendedUsers)) cacheUsers(body.recommendedUsers);
    if (Array.isArray(body.users)) cacheUsers(body.users);
    Object.values(body).forEach(v => {
        if (v && typeof v === 'object') harvestUsers(v);
    });
}

// Patch fetch to cache users from search responses
const _originalFetch = window.fetch;
window.fetch = async function (...args) {
    const response = await _originalFetch.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

    if (/recommendations|reviewers|user|mention|search/i.test(url)) {
        response.clone().json().then(harvestUsers).catch(() => { });
    }

    return response;
};

function getFiber(el) {
    const key = Object.keys(el).find(k =>
        k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    return key ? el[key] : null;
}

// Find react-select's selectOption via React fibers
function findSelectOption(inputEl) {
    let fiber = getFiber(inputEl);
    while (fiber) {
        const props = fiber.memoizedProps;
        if (props && typeof props.selectOption === 'function') {
            return props.selectOption;
        }
        fiber = fiber.return;
    }
    return null;
}

// Read an option's account id from its React fiber
function getOptionId(optionEl) {
    let fiber = getFiber(optionEl);
    for (let i = 0; i < 40 && fiber; i++) {
        const props = fiber.memoizedProps || fiber.pendingProps;
        const d = props?.data;
        if (d && typeof d === 'object' && (d.id || d.account_id)) {
            return d.id || d.account_id;
        }
        fiber = fiber.return;
    }
    return null;
}

// Option name without the injected "+ Add" button
function getOptionName(optionEl) {
    const clone = optionEl.cloneNode(true);
    clone.querySelector('.sr-add-btn')?.remove();
    return clone.textContent.trim();
}

// Return the cached API object for a clicked option
window.addEventListener('sr-get-option-data', (e) => {
    const { idx, eventId } = e.detail;
    const optionEl = document.querySelector(`[role="option"][data-sr-idx="${idx}"]`);

    let full = null;
    if (optionEl) {
        const id = getOptionId(optionEl);
        if (id && apiDataCache.has(id)) {
            full = apiDataCache.get(id);
        } else {
            const name = getOptionName(optionEl).toLowerCase();
            full = apiDataCache.get('name:' + name) || null;
        }
    }

    window.dispatchEvent(new CustomEvent(eventId, { detail: full }));
});

// Option text without the injected "+ Add" button
function optionText(optionEl) {
    const clone = optionEl.cloneNode(true);
    clone.querySelector('.sr-add-btn')?.remove();
    return clone.textContent.trim().toLowerCase();
}

// Find the reviewer input: known id, then fallbacks
function findReviewerInput() {
    let input = document.querySelector('#react-select-BitbucketPullRequestReviewers-input');
    if (input) return input;

    const byId = [...document.querySelectorAll('input[id^="react-select-"]')]
        .find(i => /review/i.test(i.id));
    if (byId) return byId;

    const labels = [...document.querySelectorAll('label, h2, h3, span, div')]
        .filter(el => /^reviewers?$/i.test(el.textContent.trim()));
    for (const label of labels) {
        const container = label.closest('div, section, fieldset');
        const candidate = container?.querySelector('input[id^="react-select-"], input[role="combobox"]');
        if (candidate) return candidate;
    }
    return null;
}

// Type into a React-controlled input via the native setter
function typeIntoReactInput(input, value) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: value.slice(-1) || 'a' }));
    nativeSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || 'a' }));
}

// Best match: exact, then prefix, then substring
function matchOption(options, target) {
    return options.find(o => optionText(o) === target)
        || options.find(o => optionText(o).startsWith(target))
        || options.find(o => optionText(o).includes(target));
}

// Type the name, wait for the real option, then click it
window.addEventListener('sr-add-reviewer', (e) => {
    const { reviewer, eventId } = e.detail;
    const respond = (detail) => window.dispatchEvent(new CustomEvent(eventId, { detail }));

    const input = findReviewerInput();
    if (!input) {
        console.warn('[SR] reviewer input not found on page');
        respond({ ok: false, reason: 'reviewer input not found' });
        return;
    }

    const target = reviewer.name.toLowerCase();

    // Skip if already a chip in the field
    const chips = document.querySelectorAll('.-MultiValueLabel');
    if ([...chips].some(c => c.textContent.toLowerCase().includes(target))) {
        respond({ ok: true, skipped: true });
        return;
    }

    let done = false;
    const finish = (detail) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        respond(detail);
    };

    const trySelect = () => {
        const options = [...document.querySelectorAll('[role="option"]')];
        const match = matchOption(options, target);
        if (!match) return false;
        // react-select selects on mousedown
        match.scrollIntoView({ block: 'nearest' });
        match.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
        match.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
        match.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
        finish({ ok: true });
        return true;
    };

    const observer = new MutationObserver(() => trySelect());
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = setTimeout(() => {
        console.warn(`[SR] no dropdown option matched "${reviewer.name}" within timeout`);
        finish({ ok: false, reason: `no dropdown option matched "${reviewer.name}"` });
    }, 6000);

    // Trigger Bitbucket's user search
    typeIntoReactInput(input, reviewer.name);

    // Options may already be present
    trySelect();
});
