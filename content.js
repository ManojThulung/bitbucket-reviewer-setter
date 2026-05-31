chrome.storage.local.get(['customReviewer'], (result) => {
    const reviewer = result.customReviewer;

    if (!reviewer) {
         alert("Please  set a reviwer in the extension popup first.");
         return;
    }

    // Remove the default reviewer
    const removeDetaultBtn = document.querySelector('.reemove-reviewer-button-class');
    if (removeDetaultBtn) removeDetaultBtn.click();

    // Find the Reviewer Input Field
    const inputField = document.querySelector('input[placeholder="Search for reviewers"]');
    if (inputField) { 
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeInputValueSetter.call(inputField, reviewer); 

        inputField.dispatchEvent(new Event('input', { bubbles: true }));
        inputField.dispatchEvent(new Event('change', { bubbles: true }));

        // Select the user from the dropdown menu
        setTimeout(() => {
            const dropdownOption = document.querySelector('.reviewer-dropdown-item');
            if (dropdownOption) {
                dropdownOption.click();
            }
        }, 1000)
    } else {
        console.error("Reviewer input field not found.");
    }
});
    