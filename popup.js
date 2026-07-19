document.addEventListener('DOMContentLoaded', async () => {
    const listEl = document.getElementById('reviewer-list');
    const applyBtn = document.getElementById('applyBtn');
    const clearBtn = document.getElementById('clearBtn');
    const statusEl = document.getElementById('status');

    let reviewers = [];

    async function load() {
        const { savedReviewers = [] } = await chrome.storage.local.get(['savedReviewers']);
        reviewers = savedReviewers;
        render();
    }

    function render() {
        applyBtn.disabled = reviewers.length === 0;
        listEl.innerHTML = '';

        if (reviewers.length === 0) {
            listEl.innerHTML = `
                <div class="empty">
                    No reviewers saved yet.<br>
                    Open the reviewer dropdown on a Bitbucket PR page and click <strong>+ Add</strong> next to a name.
                </div>`;
            return;
        }

        reviewers.forEach((reviewer, i) => {
            const item = document.createElement('div');
            item.className = 'reviewer-item';

            const img = document.createElement('img');
            img.src = reviewer.avatarUrl || '';
            img.alt = '';
            img.onerror = () => { img.style.visibility = 'hidden'; };

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = reviewer.name;

            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.textContent = '×';
            removeBtn.title = 'Remove';
            removeBtn.addEventListener('click', async () => {
                reviewers.splice(i, 1);
                await chrome.storage.local.set({ savedReviewers: reviewers });
                render();
            });

            item.append(img, name, removeBtn);
            listEl.appendChild(item);
        });
    }

    clearBtn.addEventListener('click', async () => {
        reviewers = [];
        await chrome.storage.local.set({ savedReviewers: [] });
        render();
    });

    applyBtn.addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return;

        applyBtn.disabled = true;
        statusEl.textContent = 'Applying...';
        statusEl.style.color = '#5e6c84';

        chrome.tabs.sendMessage(tab.id, { action: 'apply', reviewers }, response => {
            if (chrome.runtime.lastError || !response?.ok) {
                statusEl.textContent = response?.error
                    || 'Error: make sure you are on a Bitbucket PR page.';
                statusEl.style.color = '#de350b';
            } else {
                statusEl.textContent = 'Done! Reviewers applied.';
                statusEl.style.color = '#36b37e';
            }
            applyBtn.disabled = false;
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        });
    });

    // Live-refresh when "+ Add" saves a reviewer
    chrome.storage.onChanged.addListener(changes => {
        if (changes.savedReviewers) {
            reviewers = changes.savedReviewers.newValue || [];
            render();
        }
    });

    await load();
});
