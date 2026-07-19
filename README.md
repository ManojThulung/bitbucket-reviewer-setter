# Bitbucket Reviewer Setter

Chrome extension (Manifest V3) that saves your preferred Bitbucket PR reviewers and applies them to any new pull request in one click — no more manually swapping default reviewers.

## Why

Every Bitbucket pull request starts pre-filled with company-wide default reviewers. Replacing them with your own team, by hand, on every single PR is a repetitive chore. This extension turns it into one click.

## How it works

**Save reviewers (once):**

1. Open a **Create Pull Request** page on Bitbucket (`.../pull-requests/new`).
2. Open the **Reviewers** dropdown — the extension adds a **`+ Add`** button next to each name.
3. Click `+ Add` on the people you want. They're saved locally.

**Apply them (every PR):**

1. On any Create Pull Request page, click the extension icon.
2. Click **Apply to PR** — every saved reviewer is added, and any pre-filled reviewer not in your saved set is removed.

Default reviewers are only removed after **all** saved reviewers were added successfully, so a failed run never leaves the field empty.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions` and enable **Developer mode** (top right).
3. Click **Load unpacked** and select the cloned folder.
4. Pin the extension for easy access.

After pulling changes, click the refresh icon on the extension card.

## How it's built

No build tools, no dependencies — vanilla JS in three contexts:

| File | Context | Role |
| --- | --- | --- |
| `popup.js` / `popup.html` | Extension popup | Saved-reviewer list, Apply / Clear All |
| `content.js` | Content script (isolated world) | Injects `+ Add` buttons, orchestrates apply |
| `main-world.js` | Content script (MAIN world) | Reads React internals and drives Bitbucket's react-select like a real user |

Reviewers are added by typing the name into Bitbucket's own search input and clicking the real dropdown option, so Bitbucket constructs its own data — the extension never fabricates reviewer objects.

Requires Chrome 111+ (MAIN-world content scripts). Data is stored in `chrome.storage.local`; nothing leaves your browser.
