document.addEventListener('DOMContentLoaded', async () => {
    const listEl = document.getElementById('reviewer-list');
    const applyBtn = document.getElementById('applyBtn');
    const clearBtn = document.getElementById('clearBtn');
    const statusEl = document.getElementById('status');
    const groupSelect = document.getElementById('groupSelect');
    const newGroupBtn = document.getElementById('newGroupBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const editRow = document.getElementById('groupEdit');
    const nameInput = document.getElementById('groupNameInput');
    const saveGroupBtn = document.getElementById('saveGroupBtn');
    const cancelGroupBtn = document.getElementById('cancelGroupBtn');
    const autoApplyToggle = document.getElementById('autoApplyToggle');

    let groups = [];
    let activeGroupId = null;
    let editing = false;
    let pageStatus = { onPrPage: false, currentReviewers: [] };

    // Ask the content script whether this tab is a Create PR page and who is already a reviewer
    function refreshPageStatus() {
        return new Promise(resolve => {
            chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
                if (!tab?.id) { resolve(); return; }
                chrome.tabs.sendMessage(tab.id, { action: 'status' }, response => {
                    if (chrome.runtime.lastError || !response?.ok) {
                        pageStatus = { onPrPage: false, currentReviewers: [] };
                    } else {
                        pageStatus = {
                            onPrPage: response.isCreatePrPage,
                            currentReviewers: response.currentReviewers || []
                        };
                    }
                    resolve();
                });
            });
        });
    }

    const newGroup = (name, reviewers = []) =>
        ({ id: 'g' + Date.now().toString(36), name, reviewers });

    const AVATAR_COLORS = ['#0052cc', '#36b37e', '#ff5630', '#ffab00', '#6554c0', '#00b8d9'];

    // Colored circle with the first letter of the name; color is stable per name
    function letterAvatar(name) {
        const div = document.createElement('div');
        div.className = 'letter-avatar';
        div.textContent = (name || '?').trim().charAt(0).toUpperCase();
        let hash = 0;
        for (const ch of name || '') hash = (hash * 31 + ch.charCodeAt(0)) | 0;
        div.style.background = AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
        return div;
    }

    // Gravatar URLs 404 for users without one, so skip them; any other broken image falls back too
    function avatarEl(reviewer) {
        const url = reviewer.avatarUrl || '';
        if (!url || url.startsWith('https://secure.gravatar.com/avatar')) {
            return letterAvatar(reviewer.name);
        }
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.onerror = () => img.replaceWith(letterAvatar(reviewer.name));
        return img;
    }

    const activeGroup = () => groups.find(g => g.id === activeGroupId) || groups[0];

    async function persist() {
        await chrome.storage.local.set({ groups, activeGroupId });
    }

    // Load groups state, migrating the old flat savedReviewers list on first run
    async function load() {
        const data = await chrome.storage.local.get(['groups', 'activeGroupId', 'savedReviewers', 'autoApply']);
        autoApplyToggle.checked = !!data.autoApply;
        if (Array.isArray(data.groups) && data.groups.length) {
            groups = data.groups;
            activeGroupId = groups.some(g => g.id === data.activeGroupId) ? data.activeGroupId : groups[0].id;
            // One-time rename of the old auto-created "Default" group
            if (groups.some(g => g.name === 'Default')) {
                groups.forEach(g => { if (g.name === 'Default') g.name = 'My Team'; });
                await persist();
            }
        } else {
            groups = [newGroup('My Team', data.savedReviewers || [])];
            activeGroupId = groups[0].id;
            await chrome.storage.local.remove('savedReviewers');
            await persist();
        }
        render();
    }

    // Two-step confirm: first click arms the button, second click within 3s executes
    function armConfirm(btn, armedLabel, onConfirm) {
        if (btn.dataset.armed) {
            btn.textContent = btn.dataset.label;
            btn.classList.remove('danger');
            delete btn.dataset.armed;
            onConfirm();
            return;
        }
        btn.dataset.armed = '1';
        btn.dataset.label = btn.textContent;
        btn.textContent = armedLabel;
        btn.classList.add('danger');
        setTimeout(() => {
            if (!btn.dataset.armed) return;
            btn.textContent = btn.dataset.label;
            btn.classList.remove('danger');
            delete btn.dataset.armed;
        }, 3000);
    }

    function render() {
        const group = activeGroup();

        groupSelect.innerHTML = '';
        groups.forEach(g => {
            const opt = document.createElement('option');
            opt.value = g.id;
            opt.textContent = `${g.name} (${g.reviewers.length})`;
            groupSelect.appendChild(opt);
        });
        groupSelect.value = group.id;

        applyBtn.disabled = group.reviewers.length === 0 || !pageStatus.onPrPage;
        applyBtn.title = pageStatus.onPrPage ? '' : 'Open a Create Pull Request page to apply';
        if (!pageStatus.onPrPage) {
            statusEl.textContent = 'Open a Create Pull Request page to apply.';
            statusEl.style.color = '#6b778c';
        }

        listEl.innerHTML = '';
        if (group.reviewers.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.append(`"${group.name}" is empty.`, document.createElement('br'));
            const strong = document.createElement('strong');
            strong.textContent = '+ Add';
            empty.append('Open the reviewer dropdown on a Create PR page and click ', strong, ' next to a name.');
            listEl.appendChild(empty);
            return;
        }

        group.reviewers.forEach((reviewer, i) => {
            const item = document.createElement('div');
            item.className = 'reviewer-item';

            const avatar = avatarEl(reviewer);

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = reviewer.name;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', async () => {
                group.reviewers.splice(i, 1);
                await persist();
                render();
            });

            item.append(avatar, name);
            if (pageStatus.currentReviewers.some(c => c.includes(reviewer.name.toLowerCase()))) {
                const check = document.createElement('span');
                check.className = 'on-pr';
                check.textContent = '✓';
                check.title = 'Already on this PR';
                item.appendChild(check);
            }
            item.appendChild(removeBtn);
            listEl.appendChild(item);
        });
    }

    function openEdit() {
        editing = true;
        editRow.hidden = false;
        nameInput.value = '';
        nameInput.focus();
    }

    function closeEdit() {
        editing = false;
        editRow.hidden = true;
        nameInput.value = '';
        render();
    }

    async function commitEdit() {
        const name = nameInput.value.trim();
        if (!name) { closeEdit(); return; }
        const g = newGroup(name);
        groups.push(g);
        activeGroupId = g.id;
        editing = false;
        editRow.hidden = true;
        nameInput.value = '';
        await persist();
        render();
    }

    groupSelect.addEventListener('change', async () => {
        activeGroupId = groupSelect.value;
        await persist();
        render();
    });

    autoApplyToggle.addEventListener('change', () => {
        chrome.storage.local.set({ autoApply: autoApplyToggle.checked });
    });

    newGroupBtn.addEventListener('click', openEdit);
    saveGroupBtn.addEventListener('click', commitEdit);
    cancelGroupBtn.addEventListener('click', closeEdit);
    nameInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') closeEdit();
    });

    deleteBtn.addEventListener('click', () => {
        const group = activeGroup();
        armConfirm(deleteBtn, `Delete ${group.reviewers.length}?`, async () => {
            groups = groups.filter(g => g.id !== group.id);
            if (groups.length === 0) groups = [newGroup('My Team')];
            activeGroupId = groups[0].id;
            // Drop per-repo mappings that pointed at the deleted group
            const { repoGroups = {} } = await chrome.storage.local.get('repoGroups');
            const pruned = Object.fromEntries(
                Object.entries(repoGroups).filter(([, gid]) => gid !== group.id));
            if (Object.keys(pruned).length !== Object.keys(repoGroups).length) {
                await chrome.storage.local.set({ repoGroups: pruned });
            }
            await persist();
            render();
        });
    });

    clearBtn.addEventListener('click', () => {
        armConfirm(clearBtn, 'Sure?', async () => {
            activeGroup().reviewers = [];
            await persist();
            render();
        });
    });

    applyBtn.addEventListener('click', async () => {
        const group = activeGroup();
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        applyBtn.disabled = true;
        statusEl.textContent = 'Applying...';
        statusEl.style.color = '#5e6c84';

        chrome.tabs.sendMessage(tab.id, { action: 'apply', reviewers: group.reviewers, groupId: group.id }, response => {
            const ok = !chrome.runtime.lastError && response?.ok;
            const errText = response?.error;
            (async () => {
                // Refresh ✓ marks and button state, then show the result on top
                await refreshPageStatus();
                render();
                statusEl.textContent = ok
                    ? `Done! "${group.name}" applied.`
                    : (errText || 'Error: make sure you are on a Bitbucket PR page.');
                statusEl.style.color = ok ? '#36b37e' : '#de350b';
                setTimeout(() => { statusEl.textContent = ''; render(); }, 3000);
            })();
        });
    });

    // Live-refresh when "+ Add" saves a reviewer on the page
    chrome.storage.onChanged.addListener(changes => {
        if (!changes.groups && !changes.activeGroupId) return;
        if (changes.groups) groups = changes.groups.newValue || groups;
        if (changes.activeGroupId) activeGroupId = changes.activeGroupId.newValue || activeGroupId;
        if (!editing) render();
    });

    await refreshPageStatus();
    await load();
});
