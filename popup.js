document.addEventListener('DOMContentLoaded', () => {
    const input = document.getElementById('reviewerName')

    // Load saved reviewer on Open
    chrome.storage.local.get(['customReviewer'], (result) => {
        if (result.customReviewer) input.value = result.customReviewer;
    })

    // Save reviewr
    document.getElementById('saveBtn').addEventListener('click', () => {
        chrome.storage.local.set({ customReviewer: input.value }, () => {
            alert('Reviewr saved!')
        })
    })

    // Trigger the content script
    document.getElementById('applyBtn').addEventListener('click', async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (!tab) return;

        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js']
        })
    })
})