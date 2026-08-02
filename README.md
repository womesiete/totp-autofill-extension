# Offline TOTP Autofill

A Manifest V3 Google Chrome extension that stores TOTP authenticator entries in one encrypted local vault, unlocks that vault for the current browser session, and applies a matching code to the active website from the toolbar.

The extension has no server component and requests no persistent host access. TOTP generation, AES-GCM encryption, domain matching, DOM inspection, autofill, toast rendering, and optional clipboard copying all happen locally.

## Features

- AES-256-GCM encrypted vault protected by a master password.
- PBKDF2-SHA-256 key derivation with a random 128-bit salt and 600,000 iterations.
- Raw AES key retained only in `chrome.storage.session` after unlock.
- Exact-domain and subdomain matching with DNS-label boundary protection.
- Automatic fuzzy OTP-field detection without automatic form submission.
- Ten-second page toast that is replaced, rather than stacked, on repeated use.
- Manual fallback dropdown when the current site has no matching entry.
- Optional automatic clipboard copy using an optional Chrome permission.
- JSON bulk import/export and individual entry management.
- SHA-1, SHA-256, and SHA-512 TOTP support with 6, 7, or 8 digits.
- Standard `otpauth://totp/` URI input support.

## Security model

### Persistent storage

`chrome.storage.local` contains two values:

- `encryptedVault`: one serialized JSON string containing KDF metadata, an AES-GCM IV, and authenticated ciphertext.
- `settings`: four non-secret booleans controlling autofill, toast, automatic copy, and success-popup behavior.

Labels, domains, TOTP secrets, algorithms, digit counts, and periods are all inside the encrypted ciphertext. They are not written separately to persistent storage.

### Unlock session

The master password is used only to derive a 256-bit AES key. The password itself is never stored. After successful authentication, the exported AES key is encoded and placed in `chrome.storage.session`, which allows the ephemeral Manifest V3 service worker to reconstruct a non-extractable `CryptoKey` after suspension.

The session key is cleared when:

- the user selects **Lock now**;
- Chrome ends the browser session;
- the extension is reloaded, disabled, or updated; or
- authenticated vault decryption fails.

### Authenticated envelope

AES-GCM authenticates the ciphertext and IV. The extension also includes the vault format version, PBKDF2 salt, PBKDF2 work factor, hash algorithm, cipher name, and tag length as authenticated additional data. Tampering with any of those values invalidates decryption.

### Page access

The extension requests `activeTab` and `scripting`, not broad host permissions. DOM access is granted only after the user activates the toolbar action for the current tab. The injected script runs in Chrome's isolated world and never submits the form.

### Clipboard access

`clipboardWrite` is declared under `optional_permissions`, not required permissions. Chrome asks for it only when **Automatically Copy to Clipboard** is enabled in Options. Turning the setting off removes the granted permission.

## Requirements

- Google Chrome 127 or later.
- Node.js 20 or later.
- npm 10 or later.

Chrome 127 is the minimum because the extension uses `chrome.action.openPopup()` to open a tab-specific popup only for setup, unlock, manual fallback, errors, or an explicitly enabled success view.

## Install dependencies and build

```sh
npm install
npm run validate
```

`npm run validate` performs all of the following:

1. Checks JavaScript syntax, JSON validity, required files, Manifest V3 permissions, local-only page assets, and tab indentation.
2. Runs unit and integration tests.
3. Creates an optimized production build in `dist/`.

For a readable development bundle:

```sh
npm run build:development
```

For continuous rebuilding:

```sh
npm run watch
```

## Load the extension in Chrome

1. Build the project.
2. Open Chrome's Extensions management page.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the generated `dist/` directory, not the repository root.
6. Pin **Offline TOTP Autofill** to the toolbar.

## First use

1. Select the toolbar icon or open the extension's Options page.
2. Create a master password containing at least 10 characters.
3. Open Options and add an entry with a label, root domain, and Base32 secret.
4. Visit a matching site and select the toolbar icon.

With default settings, the extension attempts to fill a likely OTP field and simultaneously displays the code in a ten-second page toast. It does not submit the form.

## Domain matching

Domains are normalized with the native `URL` API. A stored `example.com` entry matches:

- `example.com`
- `login.example.com`
- `admin.eu.example.com`

It does not match:

- `notexample.com`
- `example.com.attacker.test`

When multiple entries match, the longest stored domain wins. This lets `login.example.com` override a broader `example.com` entry.

The Options form accepts a bare domain, wildcard-style domain, or full URL. The following all normalize to a hostname scope:

```text
example.com
*.example.com
https://www.example.com/login
```

## Entry JSON format

Bulk import expects a JSON array. The export uses the same format:

```json
[
	{
		"label": "Work account",
		"domain": "example.com",
		"secret": "JBSWY3DPEHPK3PXP",
		"algorithm": "sha1",
		"digits": 6,
		"period": 30
	}
]
```

Required fields:

- `label`: display name, up to 100 characters.
- `domain`: root domain or URL used for matching.
- `secret`: unpadded Base32 secret or a standard TOTP `otpauth` URI.

Optional fields:

- `algorithm`: `sha1`, `sha256`, or `sha512`; default `sha1`.
- `digits`: `6`, `7`, or `8`; default `6`.
- `period`: integer from 15 through 120 seconds; default `30`.

Exports are plaintext by design so they can be moved between authenticators. Store exported files securely and delete them when no longer needed.

## Automatic action settings

| Setting | Default | Behavior |
| --- | --- | --- |
| Enable Automatic Autofill | On | Finds and fills the most likely OTP input. |
| Show Toast Notification (10 seconds) | On | Shows the generated code on the page. |
| Automatically Copy to Clipboard | Off | Requests optional clipboard permission and copies the code. |
| Show Success Popup | Off | Opens a popup with the code and manual copy/autofill controls. |

When no domain matches, the popup always opens a manual entry selector. Selecting an entry uses the same action settings as an automatic match.

## Autofill strategy

The content script:

1. Traverses the document and accessible open shadow roots.
2. Detects segmented one-character OTP widgets before normal inputs.
3. Scores inputs using `autocomplete="one-time-code"`, identifiers, names, labels, placeholders, test IDs, expected length, numeric input hints, focus, and negative password/email/search signals.
4. Uses the native input value setter for framework compatibility.
5. dispatches bubbling `input` and `change` events.
6. Focuses the populated control without clicking buttons, pressing Enter, or submitting the form.

Closed shadow roots, cross-origin frames, browser-internal pages, and site-specific anti-automation logic may prevent autofill. The toast and manual success popup provide a fallback on ordinary web pages.

## Project structure

```text
public/
	manifest.json
	options.html
	options.css
	popup.html
	popup.css
	icons/
scripts/
	check-source.mjs
	clean.mjs
src/
	background.js
	content.js
	options.js
	popup.js
	lib/
		constants.js
		crypto.js
		domains.js
		encoding.js
		entries.js
		settings.js
		time.js
		totp.js
tests/
webpack.config.js
package.json
```

Webpack creates independent bundles for the service worker, injected content script, popup, and Options page. Shared runtime chunks are disabled because Chrome loads each execution context independently. Static files are copied from `public/`.

## Commands

```sh
npm run check
npm test
npm run build
npm run build:development
npm run watch
npm run clean
npm run validate
```

## Recovery and backups

There is no master-password recovery mechanism. This is intentional: the extension does not store a password verifier or alternate decryption key. Losing the password means losing access to the encrypted vault.

Keep a secure backup by exporting the database and protecting that plaintext export with an appropriate encrypted storage system. Clearing extension data, removing the extension, or creating a new Chrome profile also removes the local encrypted vault.

## Threat boundaries

This extension protects secrets at rest from casual local inspection and from accidental plaintext storage. It does not protect against:

- malware or another process controlling the user's unlocked operating-system session;
- a compromised Chrome installation or malicious extension with sufficient privileges;
- a website reading a code after the extension intentionally inserts it into that website;
- shoulder surfing, screenshots, clipboard-history software, or page scripts observing the filled input;
- a weak or reused master password subjected to offline guessing after the encrypted vault is copied.

Use a long, unique master password and keep the operating system and browser updated.

## Privacy

The extension has no analytics, telemetry, advertising, account system, or network API. See [PRIVACY.md](PRIVACY.md) for the data-handling statement.

## License

MIT. See [LICENSE](LICENSE).
