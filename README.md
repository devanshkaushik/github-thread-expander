# GitHub Thread Expander

Expand hidden GitHub conversations with a single click. GitHub Thread Expander finds visible **Load more** controls on supported GitHub pages and opens the hidden comments, replies, and timeline items for you.

## Features

- Expands up to 10 hidden thread sections per run
- Waits for GitHub to finish loading before looking for more threads
- Shows live progress in the extension popup
- Remembers the current page's status for the browser session
- Avoids running while an unsaved comment or review draft is open
- Uses safety limits to prevent an expansion loop from running indefinitely

## Supported pages

The extension works on GitHub:

- Pull requests
- Issues
- Repository and organization discussions

## Install from source

1. Download or clone this repository.
2. Open `chrome://extensions` in a Chromium-based browser.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this repository's root directory.

## Usage

1. Open a supported page on `github.com`.
2. Select the GitHub Thread Expander icon in the browser toolbar.
3. Select **Expand hidden threads**.
4. If the extension reaches its 10-section limit, select **Check again** to continue.

If you have an unsaved comment or review draft, save or discard it before running the extension.

## Permissions

The extension requests only the permissions needed for its popup-driven workflow:

- `activeTab` - accesses the current tab after you open the extension
- `scripting` - runs the thread-expansion logic on the active GitHub page
- `storage` - keeps progress and result messages for the current browser session

The extension has no background service, does not make its own network requests, and does not collect or transmit user data.

## Development

This is a Manifest V3 browser extension built with plain HTML, CSS, and JavaScript. No build step or external dependencies are required.

After changing the source, open `chrome://extensions` and select the extension's reload button. Refresh any GitHub tab you are using to test the updated code.
