# Privacy statement

Offline TOTP Autofill processes all data locally in the user's Chrome profile.

## Data stored

The extension stores:

- an AES-GCM encrypted authenticator vault in `chrome.storage.local`;
- non-secret behavior settings in `chrome.storage.local`; and
- the derived AES key and temporary popup state in `chrome.storage.session` while unlocked.

The encrypted vault can contain labels, domains, TOTP secrets, algorithms, digit counts, and time periods.

## Data transmitted

The extension does not transmit data to the developer or any third party. It has no analytics, telemetry, crash-reporting service, advertising SDK, account service, or remote API.

When the user activates the extension on a website, the generated code may be inserted into that page, displayed in a page toast, or copied to the local clipboard according to the user's settings. Those are local, user-initiated actions.

## Permissions

- `storage`: stores the encrypted vault, settings, and unlock-session key.
- `activeTab`: grants temporary access to the current tab after a toolbar activation.
- `scripting`: injects the local content-script bundle into that active tab.
- optional `clipboardWrite`: used only while automatic copy is enabled.

## User control

Users can edit or delete individual entries, replace the database with an import, export a plaintext backup, change the master password, lock the session, or remove all extension data by uninstalling the extension or clearing its storage.
