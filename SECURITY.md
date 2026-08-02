# Security policy

## Supported version

The latest release on the default branch is the supported version.

## Reporting a vulnerability

Do not place master passwords, TOTP secrets, exported vault data, working OTP codes, or other account credentials in a public issue.

Report a suspected vulnerability privately through the repository's GitHub security-advisory interface. Include:

- the extension version or commit;
- the affected Chrome version and operating system;
- concise reproduction steps;
- expected and observed behavior;
- a proof of concept that uses test credentials only; and
- the practical impact.

## Security design notes

- Persistent secrets are stored only inside one AES-256-GCM encrypted string.
- PBKDF2-SHA-256 uses a random 16-byte salt and 600,000 iterations.
- Envelope metadata is authenticated as AES-GCM additional data.
- The master password is never stored.
- The derived AES key is stored only in `chrome.storage.session` for the unlocked browser session.
- No network, cookie, browsing-history, or persistent host permissions are requested.
- Clipboard access is optional and removed when automatic copy is disabled.
- Page injection requires a toolbar activation and `activeTab` access.
- Autofill dispatches input events but never submits the form.

## Scope guidance

Examples of high-value reports include:

- plaintext secrets reaching persistent storage;
- unauthorized vault decryption or authentication bypass;
- extension pages accepting messages from untrusted origins;
- unintended code execution in the extension origin;
- domain-matching behavior that applies a code to an attacker-controlled suffix; and
- clipboard permission being retained or used contrary to the visible setting.

Site-specific inability to locate an OTP field is generally a compatibility issue rather than a security vulnerability, unless it fills a clearly unrelated sensitive field.
