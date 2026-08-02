import {
	DEFAULT_SETTINGS,
	MESSAGE_TYPES,
	MINIMUM_MASTER_PASSWORD_LENGTH,
	STORAGE_KEYS,
	TOAST_DURATION_MS
} from "./lib/constants.js";
import {
	createEncryptedVault,
	decryptVaultWithKey,
	importVaultKey,
	reencryptVault,
	unlockEncryptedVault
} from "./lib/crypto.js";
import {
	findBestDomainMatch,
	hostnameFromUrl,
	isInjectableUrl
} from "./lib/domains.js";
import {
	createEmptyVault,
	normalizeEntry,
	sortEntries,
	summarizeEntry,
	validateVault
} from "./lib/entries.js";
import { normalizeSettings } from "./lib/settings.js";
import { getRemainingSeconds } from "./lib/time.js";
import { generateTotp } from "./lib/totp.js";

const extensionBaseUrl = chrome.runtime.getURL("");
let vaultWriteQueue = Promise.resolve();

class ExtensionError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "ExtensionError";
		this.code = code;
	}
}

/**
 * Service workers are disposable. Startup initialization therefore configures
 * storage access and defaults, but it never caches the decrypted vault or AES
 * key in a module-level variable. Every sensitive operation retrieves the raw
 * key from chrome.storage.session and reconstructs a CryptoKey on demand.
 */
void bootstrap().catch((error) => {
	console.error("TOTP Autofill bootstrap failed:", error);
});

chrome.runtime.onInstalled.addListener(() => {
	void bootstrap().catch((error) => {
		console.error("TOTP Autofill installation initialization failed:", error);
	});
});

chrome.runtime.onStartup.addListener(() => {
	void bootstrap().catch((error) => {
		console.error("TOTP Autofill startup initialization failed:", error);
	});
});

chrome.action.onClicked.addListener((tab) => {
	void handleToolbarClick(tab).catch(async (error) => {
		console.error("TOTP Autofill action failed:", error);

		if (Number.isInteger(tab.id)) {
			await openExtensionPopup(tab, {
				mode: "error",
				message: toPublicError(error).message
			});
		}
	});
});

/**
 * Extension pages use a single request/response channel. Returning true keeps
 * the message port open while the asynchronous handler decrypts or rewrites
 * the vault. Errors are serialized so popup and options pages never need to
 * inspect service-worker exceptions directly.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	void dispatchMessage(message, sender)
		.then((result) => {
			sendResponse({
				ok: true,
				result
			});
		})
		.catch((error) => {
			sendResponse({
				ok: false,
				error: toPublicError(error)
			});
		});

	return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
	void chrome.storage.session.remove(getPopupContextKey(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (!changeInfo.url) {
		return;
	}

	void Promise.allSettled([
		chrome.storage.session.remove(getPopupContextKey(tabId)),
		chrome.action.setPopup({
			tabId,
			popup: ""
		})
	]);
});

/**
 * If the optional clipboard permission is revoked outside the options page,
 * immediately synchronize the preference so the UI and runtime behavior do
 * not claim that automatic copying is still active.
 */
chrome.permissions.onRemoved.addListener((permissions) => {
	if (!permissions.permissions?.includes("clipboardWrite")) {
		return;
	}

	void updateSettings({ automaticCopy: false }).catch((error) => {
		console.error("Unable to synchronize revoked clipboard permission:", error);
	});
});

async function bootstrap() {
	await chrome.storage.session.setAccessLevel({
		accessLevel: "TRUSTED_CONTEXTS"
	});

	const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
	const clipboardPermissionGranted = await chrome.permissions.contains({
		permissions: ["clipboardWrite"]
	});
	const normalized = normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);

	if (normalized.automaticCopy && !clipboardPermissionGranted) {
		normalized.automaticCopy = false;
	}

	/**
	 * Keep the optional permission synchronized even after an interrupted UI
	 * update. If the setting is off, retaining clipboard authority serves no
	 * purpose and would contradict the user's explicit preference.
	 */
	if (!normalized.automaticCopy && clipboardPermissionGranted) {
		await chrome.permissions.remove({
			permissions: ["clipboardWrite"]
		});
	}

	await chrome.storage.local.set({
		[STORAGE_KEYS.SETTINGS]: normalized
	});
	await updateGlobalBadge();
}

async function dispatchMessage(message, sender) {
	assertTrustedExtensionSender(sender);

	switch (message?.type) {
		case MESSAGE_TYPES.GET_STATUS:
			return getStatus();
		case MESSAGE_TYPES.INITIALIZE_VAULT:
			return initializeVault(message.password);
		case MESSAGE_TYPES.UNLOCK:
			return unlockVault(message.password);
		case MESSAGE_TYPES.LOCK:
			return lockVault();
		case MESSAGE_TYPES.GET_SETTINGS:
			return getSettings();
		case MESSAGE_TYPES.UPDATE_SETTINGS:
			return updateSettings(message.settings);
		case MESSAGE_TYPES.GET_OPTIONS_DATA:
			return getOptionsData();
		case MESSAGE_TYPES.UPSERT_ENTRY:
			return upsertEntry(message.entry);
		case MESSAGE_TYPES.DELETE_ENTRY:
			return deleteEntry(message.entryId);
		case MESSAGE_TYPES.IMPORT_ENTRIES:
			return importEntries(message.entries, message.mode);
		case MESSAGE_TYPES.EXPORT_ENTRIES:
			return exportEntries();
		case MESSAGE_TYPES.CHANGE_MASTER_PASSWORD:
			return changeMasterPassword(message.newPassword);
		case MESSAGE_TYPES.GET_POPUP_MODEL:
			return getPopupModel(message.tabId);
		case MESSAGE_TYPES.RUN_TAB_ACTION:
			return runTabAction(message.tabId);
		case MESSAGE_TYPES.APPLY_ENTRY:
			return applyEntryById(message.tabId, message.entryId, message.overrideActions);
		case MESSAGE_TYPES.CLEAR_POPUP_ASSIGNMENT:
			return clearPopupAssignment(message.tabId);
		default:
			throw new ExtensionError("UNKNOWN_MESSAGE", "The requested extension operation is not supported.");
	}
}

function assertTrustedExtensionSender(sender) {
	if (
		sender.id !== chrome.runtime.id
		|| typeof sender.url !== "string"
		|| !sender.url.startsWith(extensionBaseUrl)
	) {
		throw new ExtensionError("UNTRUSTED_SENDER", "The request did not originate from a trusted extension page.");
	}
}

function toPublicError(error) {
	return {
		code: error instanceof ExtensionError ? error.code : "UNEXPECTED_ERROR",
		message: error instanceof Error ? error.message : "An unexpected error occurred."
	};
}

function validatePassword(password) {
	if (typeof password !== "string" || password.length < MINIMUM_MASTER_PASSWORD_LENGTH) {
		throw new ExtensionError(
			"WEAK_PASSWORD",
			`The master password must contain at least ${MINIMUM_MASTER_PASSWORD_LENGTH} characters.`
		);
	}
}

async function getStatus() {
	const [localData, sessionData] = await Promise.all([
		chrome.storage.local.get(STORAGE_KEYS.ENCRYPTED_VAULT),
		chrome.storage.session.get(STORAGE_KEYS.SESSION_KEY)
	]);
	const initialized = typeof localData[STORAGE_KEYS.ENCRYPTED_VAULT] === "string";
	const unlocked = initialized && Boolean(sessionData[STORAGE_KEYS.SESSION_KEY]?.encodedKey);

	if (!initialized && sessionData[STORAGE_KEYS.SESSION_KEY]) {
		await chrome.storage.session.remove(STORAGE_KEYS.SESSION_KEY);
	}

	return {
		initialized,
		unlocked
	};
}

async function initializeVault(password) {
	validatePassword(password);

	return enqueueVaultWrite(async () => {
		const status = await getStatus();

		if (status.initialized) {
			throw new ExtensionError("ALREADY_INITIALIZED", "A vault already exists for this extension.");
		}

		const encrypted = await createEncryptedVault(createEmptyVault(), password);
		await chrome.storage.local.set({
			[STORAGE_KEYS.ENCRYPTED_VAULT]: encrypted.serializedEnvelope
		});
		await storeSessionKey(encrypted.encodedKey);
		await updateGlobalBadge();

		return getStatus();
	});
}

async function unlockVault(password) {
	if (typeof password !== "string" || password.length === 0) {
		throw new ExtensionError("PASSWORD_REQUIRED", "Enter the master password.");
	}

	const localData = await chrome.storage.local.get(STORAGE_KEYS.ENCRYPTED_VAULT);
	const serializedEnvelope = localData[STORAGE_KEYS.ENCRYPTED_VAULT];

	if (typeof serializedEnvelope !== "string") {
		throw new ExtensionError("NOT_INITIALIZED", "Create a master password before unlocking the vault.");
	}

	try {
		const unlocked = await unlockEncryptedVault(serializedEnvelope, password);
		validateVault(unlocked.vault);
		await storeSessionKey(unlocked.encodedKey);
		await updateGlobalBadge();
		return getStatus();
	} catch (error) {
		throw new ExtensionError("UNLOCK_FAILED", "The master password is incorrect or the encrypted vault is damaged.");
	}
}

async function storeSessionKey(encodedKey) {
	await chrome.storage.session.set({
		[STORAGE_KEYS.SESSION_KEY]: {
			encodedKey,
			unlockedAt: new Date().toISOString()
		}
	});
}

async function lockVault() {
	await chrome.storage.session.clear();
	await updateGlobalBadge();

	return {
		locked: true
	};
}

async function getSettings() {
	const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
	return normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);
}

async function updateSettings(partialSettings) {
	const current = await getSettings();
	const next = normalizeSettings({
		...current,
		...(partialSettings && typeof partialSettings === "object" ? partialSettings : {})
	});

	if (next.automaticCopy) {
		const granted = await chrome.permissions.contains({
			permissions: ["clipboardWrite"]
		});

		if (!granted) {
			throw new ExtensionError(
				"CLIPBOARD_PERMISSION_REQUIRED",
				"Grant clipboard access before enabling automatic copy."
			);
		}
	}

	await chrome.storage.local.set({
		[STORAGE_KEYS.SETTINGS]: next
	});

	/**
	 * Permission revocation is enforced at the service-worker boundary instead
	 * of relying only on the Options page. This covers future extension pages,
	 * interrupted UI operations, and direct internal message callers.
	 */
	if (!next.automaticCopy) {
		await chrome.permissions.remove({
			permissions: ["clipboardWrite"]
		});
	}

	return next;
}

/**
 * Decrypt the current vault from storage for exactly one operation. If the raw
 * session key is stale or the ciphertext cannot be authenticated, the session
 * is locked immediately rather than allowing repeated operations with a bad
 * key.
 */
async function readUnlockedVault() {
	const [localData, sessionData] = await Promise.all([
		chrome.storage.local.get(STORAGE_KEYS.ENCRYPTED_VAULT),
		chrome.storage.session.get(STORAGE_KEYS.SESSION_KEY)
	]);
	const serializedEnvelope = localData[STORAGE_KEYS.ENCRYPTED_VAULT];
	const encodedKey = sessionData[STORAGE_KEYS.SESSION_KEY]?.encodedKey;

	if (typeof serializedEnvelope !== "string") {
		throw new ExtensionError("NOT_INITIALIZED", "The encrypted vault has not been created.");
	}

	if (typeof encodedKey !== "string") {
		throw new ExtensionError("LOCKED", "The vault is locked. Enter the master password to continue.");
	}

	try {
		const key = await importVaultKey(encodedKey);
		const vault = validateVault(await decryptVaultWithKey(serializedEnvelope, key));

		return {
			key,
			vault,
			serializedEnvelope
		};
	} catch (error) {
		await chrome.storage.session.remove(STORAGE_KEYS.SESSION_KEY);
		await updateGlobalBadge();
		throw new ExtensionError("SESSION_INVALID", "The unlock session is no longer valid. Unlock the vault again.");
	}
}

function enqueueVaultWrite(operation) {
	const queued = vaultWriteQueue.then(operation, operation);
	vaultWriteQueue = queued.catch(() => undefined);
	return queued;
}

async function persistVault(unlockedVault, updatedVault) {
	const encrypted = await reencryptVault(
		unlockedVault.serializedEnvelope,
		updatedVault,
		unlockedVault.key
	);

	await chrome.storage.local.set({
		[STORAGE_KEYS.ENCRYPTED_VAULT]: encrypted
	});
}

async function getOptionsData() {
	const unlocked = await readUnlockedVault();
	const settings = await getSettings();
	const clipboardPermissionGranted = await chrome.permissions.contains({
		permissions: ["clipboardWrite"]
	});

	return {
		entries: sortEntries(unlocked.vault.entries),
		settings,
		clipboardPermissionGranted
	};
}

async function upsertEntry(rawEntry) {
	return enqueueVaultWrite(async () => {
		const unlocked = await readUnlockedVault();
		const existing = unlocked.vault.entries.find((entry) => entry.id === rawEntry?.id) ?? null;
		const normalized = normalizeEntry(rawEntry, existing);

		try {
			await generateTotp(normalized);
		} catch (error) {
			throw new ExtensionError("INVALID_TOTP_SECRET", `The TOTP secret could not generate a code: ${error.message}`);
		}

		const nextEntries = existing
			? unlocked.vault.entries.map((entry) => entry.id === existing.id ? normalized : entry)
			: [...unlocked.vault.entries, normalized];
		const nextVault = {
			...unlocked.vault,
			entries: nextEntries
		};

		await persistVault(unlocked, nextVault);

		return {
			entry: normalized,
			entries: sortEntries(nextEntries)
		};
	});
}

async function deleteEntry(entryId) {
	if (typeof entryId !== "string" || entryId.length === 0) {
		throw new ExtensionError("ENTRY_REQUIRED", "Select an entry to delete.");
	}

	return enqueueVaultWrite(async () => {
		const unlocked = await readUnlockedVault();
		const nextEntries = unlocked.vault.entries.filter((entry) => entry.id !== entryId);

		if (nextEntries.length === unlocked.vault.entries.length) {
			throw new ExtensionError("ENTRY_NOT_FOUND", "The selected entry no longer exists.");
		}

		await persistVault(unlocked, {
			...unlocked.vault,
			entries: nextEntries
		});

		return {
			entries: sortEntries(nextEntries)
		};
	});
}

async function importEntries(rawEntries, mode = "replace") {
	if (!Array.isArray(rawEntries)) {
		throw new ExtensionError("INVALID_IMPORT", "The import must be a JSON array of TOTP entries.");
	}

	if (mode !== "replace" && mode !== "append") {
		throw new ExtensionError("INVALID_IMPORT_MODE", "The import mode must be replace or append.");
	}

	return enqueueVaultWrite(async () => {
		const unlocked = await readUnlockedVault();
		const normalizedEntries = [];

		for (let index = 0; index < rawEntries.length; index += 1) {
			try {
				const normalized = normalizeEntry({
					...rawEntries[index],
					id: ""
				});
				await generateTotp(normalized);
				normalizedEntries.push(normalized);
			} catch (error) {
				throw new ExtensionError(
					"INVALID_IMPORT_ENTRY",
					`Import entry ${index + 1} is invalid: ${error.message}`
				);
			}
		}

		const nextEntries = mode === "append"
			? [...unlocked.vault.entries, ...normalizedEntries]
			: normalizedEntries;

		await persistVault(unlocked, {
			...unlocked.vault,
			entries: nextEntries
		});

		return {
			count: normalizedEntries.length,
			entries: sortEntries(nextEntries)
		};
	});
}

async function exportEntries() {
	const unlocked = await readUnlockedVault();

	return sortEntries(unlocked.vault.entries).map((entry) => ({
		label: entry.label,
		domain: entry.domain,
		secret: entry.secret,
		algorithm: entry.algorithm,
		digits: entry.digits,
		period: entry.period
	}));
}

async function changeMasterPassword(newPassword) {
	validatePassword(newPassword);

	return enqueueVaultWrite(async () => {
		const unlocked = await readUnlockedVault();
		const encrypted = await createEncryptedVault(unlocked.vault, newPassword);

		await chrome.storage.local.set({
			[STORAGE_KEYS.ENCRYPTED_VAULT]: encrypted.serializedEnvelope
		});
		await storeSessionKey(encrypted.encodedKey);

		return {
			changed: true
		};
	});
}

async function handleToolbarClick(tab) {
	if (!Number.isInteger(tab.id)) {
		throw new ExtensionError("TAB_UNAVAILABLE", "Chrome did not provide an active tab.");
	}

	const status = await getStatus();

	if (!status.initialized || !status.unlocked) {
		await openExtensionPopup(tab, {
			mode: status.initialized ? "locked" : "setup"
		});
		return;
	}

	const actionResult = await executeAutomaticMatch(tab.id);

	if (actionResult.mode === "manual") {
		await openExtensionPopup(tab, actionResult);
		return;
	}

	if (actionResult.settings.showSuccessPopup) {
		await openExtensionPopup(tab, actionResult);
		return;
	}

	await showTransientBadge(tab.id, actionResult.outcome?.autofill?.filled ? "OK" : "TOTP");
}

async function getPopupModel(tabId) {
	validateTabId(tabId);
	const storedContext = await consumePopupContext(tabId);
	const context = isFreshPopupContext(storedContext) ? storedContext : null;
	await clearPopupAssignment(tabId);
	const status = await getStatus();

	if (!status.initialized) {
		return {
			mode: "setup"
		};
	}

	if (!status.unlocked) {
		return {
			mode: "locked"
		};
	}

	if (context?.mode === "success" || context?.mode === "error") {
		return context;
	}

	const tab = await chrome.tabs.get(tabId);
	const hostname = getWebHostname(tab.url);
	const unlocked = await readUnlockedVault();
	const matchedEntry = hostname
		? findBestDomainMatch(unlocked.vault.entries, hostname)
		: null;

	if (context?.mode === "manual" || !matchedEntry) {
		return {
			mode: "manual",
			hostname,
			entries: sortEntries(unlocked.vault.entries).map(summarizeEntry)
		};
	}

	return {
		mode: "ready",
		hostname,
		entry: summarizeEntry(matchedEntry)
	};
}

async function runTabAction(tabId) {
	validateTabId(tabId);
	const result = await executeAutomaticMatch(tabId);

	if (result.mode === "manual") {
		return result;
	}

	return result.settings.showSuccessPopup
		? result
		: {
			mode: "completed",
			entry: result.entry,
			outcome: result.outcome
		};
}

async function executeAutomaticMatch(tabId) {
	const tab = await chrome.tabs.get(tabId);
	const hostname = getWebHostname(tab.url);
	const unlocked = await readUnlockedVault();
	const matchedEntry = hostname
		? findBestDomainMatch(unlocked.vault.entries, hostname)
		: null;

	if (!matchedEntry) {
		return {
			mode: "manual",
			hostname,
			entries: sortEntries(unlocked.vault.entries).map(summarizeEntry)
		};
	}

	return applyResolvedEntry(tab, matchedEntry);
}

async function applyEntryById(tabId, entryId, overrideActions = null) {
	validateTabId(tabId);

	if (typeof entryId !== "string" || entryId.length === 0) {
		throw new ExtensionError("ENTRY_REQUIRED", "Choose a TOTP entry first.");
	}

	const tab = await chrome.tabs.get(tabId);
	const unlocked = await readUnlockedVault();
	const entry = unlocked.vault.entries.find((candidate) => candidate.id === entryId);

	if (!entry) {
		throw new ExtensionError("ENTRY_NOT_FOUND", "The selected TOTP entry no longer exists.");
	}

	return applyResolvedEntry(tab, entry, overrideActions);
}

async function applyResolvedEntry(tab, entry, overrideActions = null) {
	const settings = await getSettings();
	const actions = overrideActions
		? normalizeActionOverrides(overrideActions)
		: await getAutomaticActions(settings);
	const generatedAtMilliseconds = Date.now();
	const code = await generateTotp(entry, Math.floor(generatedAtMilliseconds / 1000));
	const outcome = await applyCodeToTab(tab, code, entry, actions);

	return {
		mode: "success",
		hostname: getWebHostname(tab.url),
		entry: summarizeEntry(entry),
		code,
		remainingSeconds: getRemainingSeconds(entry.period, generatedAtMilliseconds),
		settings,
		actions,
		outcome
	};
}

function normalizeActionOverrides(value) {
	return {
		autofill: Boolean(value.autofill),
		toast: Boolean(value.toast),
		copy: Boolean(value.copy)
	};
}

async function getAutomaticActions(settings) {
	let copy = settings.automaticCopy;

	if (copy) {
		copy = await chrome.permissions.contains({
			permissions: ["clipboardWrite"]
		});
	}

	return {
		autofill: settings.automaticAutofill,
		toast: settings.showToast,
		copy
	};
}

/**
 * The content script is injected only after a toolbar click has granted
 * activeTab access. This avoids broad host permissions and limits DOM access to
 * the current page. The script installs one idempotent message listener, then
 * receives the code and the exact behaviors selected by user preferences.
 */
async function applyCodeToTab(tab, code, entry, actions) {
	const hasRequestedPageAction = actions.autofill || actions.toast || actions.copy;

	if (!hasRequestedPageAction) {
		return {
			autofill: {
				attempted: false,
				filled: false
			},
			toast: {
				shown: false
			},
			copy: {
				attempted: false,
				copied: false
			}
		};
	}

	if (!Number.isInteger(tab.id) || !isInjectableUrl(tab.url)) {
		throw new ExtensionError(
			"RESTRICTED_PAGE",
			"Chrome does not allow this extension to inject into the current page. Open a regular http or https page."
		);
	}

	try {
		await chrome.scripting.executeScript({
			target: {
				tabId: tab.id
			},
			files: ["content.js"]
		});

		return await chrome.tabs.sendMessage(tab.id, {
			type: "applyTotp",
			payload: {
				code,
				label: entry.label,
				actions,
				toastDurationMs: TOAST_DURATION_MS
			}
		});
	} catch (error) {
		throw new ExtensionError(
			"INJECTION_FAILED",
			`The code was generated, but Chrome could not apply it to this page: ${error.message}`
		);
	}
}

function validateTabId(tabId) {
	if (!Number.isInteger(tabId)) {
		throw new ExtensionError("TAB_UNAVAILABLE", "The active tab is no longer available.");
	}
}

function getWebHostname(url) {
	if (!isInjectableUrl(url)) {
		return "";
	}

	try {
		return hostnameFromUrl(url);
	} catch (error) {
		return "";
	}
}

function getPopupContextKey(tabId) {
	return `${STORAGE_KEYS.POPUP_CONTEXT_PREFIX}${tabId}`;
}

async function openExtensionPopup(tab, context) {
	validateTabId(tab.id);
	const contextKey = getPopupContextKey(tab.id);

	await chrome.storage.session.set({
		[contextKey]: {
			...context,
			tabId: tab.id,
			createdAt: Date.now()
		}
	});
	await chrome.action.setPopup({
		tabId: tab.id,
		popup: "popup.html"
	});

	try {
		if (Number.isInteger(tab.windowId)) {
			await chrome.action.openPopup({
				windowId: tab.windowId
			});
		} else {
			await chrome.action.openPopup();
		}
	} catch (error) {
		/**
		 * Leaving the tab-specific popup assigned is an intentional fallback.
		 * If Chrome declines the programmatic open, the user's next toolbar
		 * click opens popup.html directly instead of losing the pending state.
		 */
		await chrome.action.setBadgeText({
			tabId: tab.id,
			text: "OPEN"
		});
	}
}

async function consumePopupContext(tabId) {
	const key = getPopupContextKey(tabId);
	const stored = await chrome.storage.session.get(key);
	await chrome.storage.session.remove(key);
	return stored[key] ?? null;
}

/**
 * A programmatic popup can be declined by Chrome, leaving its tab-specific
 * context for the user's next click. Success contexts contain time-sensitive
 * codes, so they are accepted only within the entry's current TOTP period.
 * Stale contexts fall through to normal matching and generate a fresh code.
 */
function isFreshPopupContext(context) {
	if (!context || !Number.isFinite(context.createdAt)) {
		return false;
	}

	const ageMilliseconds = Date.now() - context.createdAt;

	if (ageMilliseconds < 0) {
		return false;
	}

	if (context.mode === "success") {
		const periodSeconds = Number.isInteger(context.entry?.period)
			? context.entry.period
			: 30;
		return ageMilliseconds <= periodSeconds * 1000;
	}

	return ageMilliseconds <= 120000;
}

async function clearPopupAssignment(tabId) {
	if (!Number.isInteger(tabId)) {
		return {
			cleared: false
		};
	}

	try {
		await chrome.action.setPopup({
			tabId,
			popup: ""
		});
		await chrome.action.setBadgeText({
			tabId,
			text: ""
		});
	} catch (error) {
		return {
			cleared: false
		};
	}

	return {
		cleared: true
	};
}

async function updateGlobalBadge() {
	const status = await getStatus();
	const text = status.unlocked ? "" : status.initialized ? "LOCK" : "NEW";

	await chrome.action.setBadgeBackgroundColor({
		color: status.initialized ? "#7c2d12" : "#1e3a8a"
	});
	await chrome.action.setBadgeText({ text });
}

async function showTransientBadge(tabId, text) {
	await chrome.action.setBadgeBackgroundColor({
		tabId,
		color: "#166534"
	});
	await chrome.action.setBadgeText({
		tabId,
		text
	});

	setTimeout(() => {
		void chrome.action.setBadgeText({
			tabId,
			text: ""
		}).catch(() => undefined);
	}, 1800);
}
