import {
	DEFAULT_SETTINGS,
	MESSAGE_TYPES,
	MINIMUM_MASTER_PASSWORD_LENGTH
} from "./lib/constants.js";
import { maskSecret } from "./lib/entries.js";

const authenticationPanel = document.getElementById("authentication-panel");
const authenticationLoading = document.getElementById("authentication-loading");
const setupCard = document.getElementById("setup-card");
const unlockCard = document.getElementById("unlock-card");
const authenticationMessage = document.getElementById("authentication-message");
const applicationShell = document.getElementById("application-shell");
const sessionControls = document.getElementById("session-controls");
const setupForm = document.getElementById("setup-form");
const unlockForm = document.getElementById("unlock-form");
const entryForm = document.getElementById("entry-form");
const settingsForm = document.getElementById("settings-form");
const passwordForm = document.getElementById("password-form");
const entriesList = document.getElementById("entries-list");
const entriesEmpty = document.getElementById("entries-empty");
const entryRowTemplate = document.getElementById("entry-row-template");
const entryEditorCard = document.getElementById("entry-editor-card");
const entryEditorHeading = document.getElementById("entry-editor-heading");
const entryCount = document.getElementById("entry-count");
const pageMessage = document.getElementById("page-message");
const importJson = document.getElementById("import-json");
const importFile = document.getElementById("import-file");
const importFileName = document.getElementById("import-file-name");
const exportPanel = document.getElementById("export-panel");
const exportJson = document.getElementById("export-json");
const downloadExportButton = document.getElementById("download-export-button");
const cancelEditButton = document.getElementById("cancel-edit-button");
const toggleSecretButton = document.getElementById("toggle-secret-button");
const secretInput = document.getElementById("entry-secret");

const settingInputs = Object.freeze({
	automaticAutofill: document.getElementById("setting-autofill"),
	showToast: document.getElementById("setting-toast"),
	automaticCopy: document.getElementById("setting-copy"),
	showSuccessPopup: document.getElementById("setting-popup")
});

let entries = [];
let settings = { ...DEFAULT_SETTINGS };
let clipboardPermissionGranted = false;
let preparedExport = "";
let messageTimer = null;
let refreshSequence = 0;

void initializePage();

setupForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void handleSetup();
});

unlockForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void handleUnlock();
});

entryForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void saveEntry();
});

settingsForm.addEventListener("change", (event) => {
	void updateBehaviorSetting(event);
});

passwordForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void changeMasterPassword();
});

document.getElementById("lock-button").addEventListener("click", () => {
	void lockSession();
});

document.getElementById("add-entry-button").addEventListener("click", () => {
	resetEntryForm();
	focusEntryEditor();
});

document.getElementById("reset-entry-button").addEventListener("click", () => {
	resetEntryForm();
});

cancelEditButton.addEventListener("click", () => {
	resetEntryForm();
});

toggleSecretButton.addEventListener("click", () => {
	const reveal = secretInput.type === "password";
	secretInput.type = reveal ? "text" : "password";
	toggleSecretButton.textContent = reveal ? "Hide" : "Show";
	toggleSecretButton.setAttribute("aria-pressed", String(reveal));
	secretInput.focus();
});

entriesList.addEventListener("click", (event) => {
	const actionButton = event.target.closest("button");
	const row = actionButton?.closest(".entry-row");

	if (!actionButton || !row?.dataset.entryId) {
		return;
	}

	if (actionButton.classList.contains("edit-entry-button")) {
		editEntry(row.dataset.entryId);
	}

	if (actionButton.classList.contains("delete-entry-button")) {
		void deleteEntry(row.dataset.entryId);
	}
});

document.getElementById("import-button").addEventListener("click", () => {
	void importEntries();
});

document.getElementById("export-button").addEventListener("click", () => {
	void prepareExport();
});

downloadExportButton.addEventListener("click", () => {
	downloadPreparedExport();
});

importFile.addEventListener("change", () => {
	void readImportFile();
});

/**
 * Session storage is the source of truth for lock state. This listener makes an
 * already-open options tab immediately discard rendered plaintext when another
 * extension page locks the session or Chrome invalidates the session key.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
	if (areaName === "session" && changes.sessionVaultKey && !changes.sessionVaultKey.newValue) {
		clearSensitiveUiState();
		void showCurrentAuthenticationState();
	}
});

async function initializePage() {
	try {
		await showCurrentAuthenticationState();
	} catch (error) {
		showAuthentication("locked");
		showAuthenticationError(error.message);
	}
}

async function showCurrentAuthenticationState() {
	const status = await sendMessage({ type: MESSAGE_TYPES.GET_STATUS });

	if (!status.initialized) {
		showAuthentication("setup");
		return;
	}

	if (!status.unlocked) {
		showAuthentication("locked");
		return;
	}

	await loadApplicationData();
}

function showAuthentication(mode) {
	authenticationPanel.hidden = false;
	applicationShell.hidden = true;
	sessionControls.hidden = true;
	authenticationLoading.hidden = mode !== "loading";
	setupCard.hidden = mode !== "setup";
	unlockCard.hidden = mode !== "locked";
	hideAuthenticationError();

	if (mode === "setup") {
		document.getElementById("setup-password").focus();
	}

	if (mode === "locked") {
		document.getElementById("unlock-password").focus();
	}
}

async function handleSetup() {
	const passwordInput = document.getElementById("setup-password");
	const confirmationInput = document.getElementById("setup-confirm-password");

	if (passwordInput.value !== confirmationInput.value) {
		showAuthenticationError("The master password confirmation does not match.");
		return;
	}

	if (passwordInput.value.length < MINIMUM_MASTER_PASSWORD_LENGTH) {
		showAuthenticationError(`Use at least ${MINIMUM_MASTER_PASSWORD_LENGTH} characters.`);
		return;
	}

	setContainerBusy(setupForm, true);

	try {
		await sendMessage({
			type: MESSAGE_TYPES.INITIALIZE_VAULT,
			password: passwordInput.value
		});
		passwordInput.value = "";
		confirmationInput.value = "";
		await loadApplicationData();
		showPageMessage("The encrypted vault was created and unlocked.");
	} catch (error) {
		showAuthenticationError(error.message);
	} finally {
		setContainerBusy(setupForm, false);
	}
}

async function handleUnlock() {
	const passwordInput = document.getElementById("unlock-password");
	setContainerBusy(unlockForm, true);

	try {
		await sendMessage({
			type: MESSAGE_TYPES.UNLOCK,
			password: passwordInput.value
		});
		passwordInput.value = "";
		await loadApplicationData();
	} catch (error) {
		showAuthenticationError(error.message);
		passwordInput.select();
	} finally {
		setContainerBusy(unlockForm, false);
	}
}

/**
 * The options page never reads chrome.storage.local directly. Requesting data
 * through the service worker guarantees that decryption, schema validation,
 * and session-key retrieval happen in one audited boundary.
 */
async function loadApplicationData() {
	const requestSequence = ++refreshSequence;
	showAuthentication("loading");
	const data = await sendMessage({ type: MESSAGE_TYPES.GET_OPTIONS_DATA });

	if (requestSequence !== refreshSequence) {
		return;
	}

	entries = Array.isArray(data.entries) ? data.entries : [];
	settings = {
		...DEFAULT_SETTINGS,
		...(data.settings ?? {})
	};
	clipboardPermissionGranted = Boolean(data.clipboardPermissionGranted);
	authenticationPanel.hidden = true;
	applicationShell.hidden = false;
	sessionControls.hidden = false;
	renderEntries();
	renderSettings();
}

function renderEntries() {
	entriesList.replaceChildren();
	entryCount.textContent = String(entries.length);
	entriesEmpty.hidden = entries.length > 0;

	for (const entry of entries) {
		const fragment = entryRowTemplate.content.cloneNode(true);
		const row = fragment.querySelector(".entry-row");
		row.dataset.entryId = entry.id;
		fragment.querySelector(".entry-icon").textContent = entry.label.slice(0, 1) || "T";
		fragment.querySelector(".entry-label").textContent = entry.label;
		fragment.querySelector(".entry-domain").textContent = entry.domain;
		fragment.querySelector(".entry-metadata").textContent = `${formatAlgorithm(entry.algorithm)} · ${entry.digits} digits · ${entry.period}s`;
		fragment.querySelector(".entry-secret").textContent = maskSecret(entry.secret);
		entriesList.append(fragment);
	}
}

function formatAlgorithm(algorithm) {
	return String(algorithm).toUpperCase().replace(/^SHA/u, "SHA-");
}

async function saveEntry() {
	setContainerBusy(entryForm, true);

	try {
		const result = await sendMessage({
			type: MESSAGE_TYPES.UPSERT_ENTRY,
			entry: {
				id: document.getElementById("entry-id").value,
				label: document.getElementById("entry-label").value,
				domain: document.getElementById("entry-domain").value,
				secret: secretInput.value,
				algorithm: document.getElementById("entry-algorithm").value,
				digits: Number(document.getElementById("entry-digits").value),
				period: Number(document.getElementById("entry-period").value)
			}
		});
		entries = result.entries;
		renderEntries();
		resetEntryForm();
		showPageMessage(`Encrypted entry “${result.entry.label}” was saved.`);
	} catch (error) {
		await handleOperationalError(error);
	} finally {
		setContainerBusy(entryForm, false);
	}
}

function editEntry(entryId) {
	const entry = entries.find((candidate) => candidate.id === entryId);

	if (!entry) {
		showPageMessage("The selected entry no longer exists.", true);
		return;
	}

	document.getElementById("entry-id").value = entry.id;
	document.getElementById("entry-label").value = entry.label;
	document.getElementById("entry-domain").value = entry.domain;
	secretInput.value = entry.secret;
	document.getElementById("entry-algorithm").value = entry.algorithm;
	document.getElementById("entry-digits").value = String(entry.digits);
	document.getElementById("entry-period").value = String(entry.period);
	entryEditorHeading.textContent = `Edit ${entry.label}`;
	document.getElementById("save-entry-button").textContent = "Save encrypted changes";
	cancelEditButton.hidden = false;
	focusEntryEditor();
}

function resetEntryForm() {
	entryForm.reset();
	document.getElementById("entry-id").value = "";
	document.getElementById("entry-algorithm").value = "sha1";
	document.getElementById("entry-digits").value = "6";
	document.getElementById("entry-period").value = "30";
	entryEditorHeading.textContent = "Add an authenticator";
	document.getElementById("save-entry-button").textContent = "Save encrypted entry";
	cancelEditButton.hidden = true;
	secretInput.type = "password";
	toggleSecretButton.textContent = "Show";
	toggleSecretButton.setAttribute("aria-pressed", "false");
}

function focusEntryEditor() {
	entryEditorCard.scrollIntoView({
		behavior: "smooth",
		block: "start"
	});
	window.setTimeout(() => document.getElementById("entry-label").focus(), 250);
}

async function deleteEntry(entryId) {
	const entry = entries.find((candidate) => candidate.id === entryId);

	if (!entry) {
		return;
	}

	if (!window.confirm(`Delete “${entry.label}” from the encrypted vault?`)) {
		return;
	}

	try {
		const result = await sendMessage({
			type: MESSAGE_TYPES.DELETE_ENTRY,
			entryId
		});
		entries = result.entries;
		renderEntries();

		if (document.getElementById("entry-id").value === entryId) {
			resetEntryForm();
		}

		showPageMessage(`“${entry.label}” was deleted.`);
	} catch (error) {
		await handleOperationalError(error);
	}
}

function renderSettings() {
	for (const [key, input] of Object.entries(settingInputs)) {
		input.checked = Boolean(settings[key]);
	}

	settingInputs.automaticCopy.title = clipboardPermissionGranted
		? "Optional clipboard permission is currently granted."
		: "Enabling this setting asks Chrome for optional clipboard permission.";
}

/**
 * clipboardWrite remains an optional manifest permission. Chrome's permission
 * prompt is initiated directly from the user's toggle gesture; turning the
 * preference off removes the grant so the extension does not retain clipboard
 * authority that the user is not actively using.
 */
async function updateBehaviorSetting(event) {
	const changedInput = event.target.closest("input[type='checkbox']");

	if (!changedInput || !settingsForm.contains(changedInput)) {
		return;
	}

	setContainerBusy(settingsForm, true);
	let permissionGrantedDuringUpdate = false;

	try {
		if (changedInput === settingInputs.automaticCopy && changedInput.checked) {
			const alreadyGranted = clipboardPermissionGranted;
			const granted = alreadyGranted || await chrome.permissions.request({
				permissions: ["clipboardWrite"]
			});

			if (!granted) {
				throw new Error("Clipboard permission was not granted, so automatic copy remains disabled.");
			}

			permissionGrantedDuringUpdate = !alreadyGranted;
			clipboardPermissionGranted = true;
		}

		const requestedSettings = readSettingsForm();
		settings = await sendMessage({
			type: MESSAGE_TYPES.UPDATE_SETTINGS,
			settings: requestedSettings
		});

		if (changedInput === settingInputs.automaticCopy && !changedInput.checked) {
			await chrome.permissions.remove({
				permissions: ["clipboardWrite"]
			});
			clipboardPermissionGranted = false;
		}

		renderSettings();
		showPageMessage("Automatic action settings were updated.");
	} catch (error) {
		if (permissionGrantedDuringUpdate) {
			await chrome.permissions.remove({
				permissions: ["clipboardWrite"]
			}).catch(() => false);
			clipboardPermissionGranted = false;
		}

		renderSettings();
		await handleOperationalError(error);
	} finally {
		setContainerBusy(settingsForm, false);
	}
}

function readSettingsForm() {
	return {
		automaticAutofill: settingInputs.automaticAutofill.checked,
		showToast: settingInputs.showToast.checked,
		automaticCopy: settingInputs.automaticCopy.checked,
		showSuccessPopup: settingInputs.showSuccessPopup.checked
	};
}

async function readImportFile() {
	const [file] = importFile.files;

	if (!file) {
		importFileName.textContent = "No file selected";
		return;
	}

	try {
		importJson.value = await file.text();
		importFileName.textContent = file.name;
		showPageMessage(`Loaded ${file.name}. Review the JSON, then import it.`);
	} catch (error) {
		showPageMessage("The selected file could not be read.", true);
	}
}

async function importEntries() {
	let parsed;

	try {
		parsed = JSON.parse(importJson.value);
	} catch (error) {
		showPageMessage(`Import JSON is invalid: ${error.message}`, true);
		return;
	}

	if (!Array.isArray(parsed)) {
		showPageMessage("Import data must be a JSON array of entry objects.", true);
		return;
	}

	const mode = document.querySelector("input[name='import-mode']:checked")?.value ?? "append";

	if (mode === "replace" && entries.length > 0) {
		const confirmed = window.confirm("Replace every existing authenticator entry with this import?");

		if (!confirmed) {
			return;
		}
	}

	setContainerBusy(document.getElementById("transfer-heading").closest(".card"), true);

	try {
		const result = await sendMessage({
			type: MESSAGE_TYPES.IMPORT_ENTRIES,
			entries: parsed,
			mode
		});
		entries = result.entries;
		renderEntries();
		importJson.value = "";
		importFile.value = "";
		importFileName.textContent = "No file selected";
		preparedExport = "";
		exportPanel.hidden = true;
		downloadExportButton.hidden = true;
		showPageMessage(`${result.count} entr${result.count === 1 ? "y was" : "ies were"} imported and encrypted.`);
	} catch (error) {
		await handleOperationalError(error);
	} finally {
		setContainerBusy(document.getElementById("transfer-heading").closest(".card"), false);
	}
}

async function prepareExport() {
	try {
		const exportedEntries = await sendMessage({ type: MESSAGE_TYPES.EXPORT_ENTRIES });
		preparedExport = `${JSON.stringify(exportedEntries, null, "\t")}\n`;
		exportJson.value = preparedExport;
		exportPanel.hidden = false;
		downloadExportButton.hidden = false;
		exportJson.focus();
		exportJson.select();
		showPageMessage("Plaintext export prepared. Store it securely and clear it when finished.");
	} catch (error) {
		await handleOperationalError(error);
	}
}

function downloadPreparedExport() {
	if (!preparedExport) {
		return;
	}

	const blob = new Blob([preparedExport], { type: "application/json" });
	const objectUrl = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	const date = new Date().toISOString().slice(0, 10);
	anchor.href = objectUrl;
	anchor.download = `totp-autofill-export-${date}.json`;
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(objectUrl);
}

async function changeMasterPassword() {
	const passwordInput = document.getElementById("new-password");
	const confirmationInput = document.getElementById("confirm-new-password");

	if (passwordInput.value !== confirmationInput.value) {
		showPageMessage("The new master password confirmation does not match.", true);
		return;
	}

	if (passwordInput.value.length < MINIMUM_MASTER_PASSWORD_LENGTH) {
		showPageMessage(`Use at least ${MINIMUM_MASTER_PASSWORD_LENGTH} characters.`, true);
		return;
	}

	setContainerBusy(passwordForm, true);

	try {
		await sendMessage({
			type: MESSAGE_TYPES.CHANGE_MASTER_PASSWORD,
			newPassword: passwordInput.value
		});
		passwordForm.reset();
		showPageMessage("The entire vault was re-encrypted with the new master password.");
	} catch (error) {
		await handleOperationalError(error);
	} finally {
		setContainerBusy(passwordForm, false);
	}
}

async function lockSession() {
	try {
		await sendMessage({ type: MESSAGE_TYPES.LOCK });
		clearSensitiveUiState();
		showAuthentication("locked");
	} catch (error) {
		showPageMessage(error.message, true);
	}
}

function clearSensitiveUiState() {
	refreshSequence += 1;
	entries = [];
	preparedExport = "";
	entriesList.replaceChildren();
	entryCount.textContent = "0";
	entryForm.reset();
	passwordForm.reset();
	importJson.value = "";
	exportJson.value = "";
	exportPanel.hidden = true;
	downloadExportButton.hidden = true;
	applicationShell.hidden = true;
	sessionControls.hidden = true;
}

async function handleOperationalError(error) {
	if (error.code === "LOCKED" || error.code === "SESSION_INVALID") {
		clearSensitiveUiState();
		showAuthentication("locked");
		showAuthenticationError(error.message);
		return;
	}

	showPageMessage(error.message, true);
}

function setContainerBusy(container, busy) {
	for (const control of container.querySelectorAll("button, input, select, textarea")) {
		control.disabled = busy;
	}
}

function showPageMessage(message, isError = false) {
	if (messageTimer) {
		window.clearTimeout(messageTimer);
	}

	pageMessage.textContent = message;
	pageMessage.classList.toggle("error", isError);
	pageMessage.hidden = false;
	messageTimer = window.setTimeout(() => {
		pageMessage.hidden = true;
	}, isError ? 9000 : 5500);
}

function showAuthenticationError(message) {
	authenticationMessage.textContent = message;
	authenticationMessage.hidden = false;
}

function hideAuthenticationError() {
	authenticationMessage.textContent = "";
	authenticationMessage.hidden = true;
}

async function sendMessage(message) {
	const response = await chrome.runtime.sendMessage(message);

	if (!response?.ok) {
		const error = new Error(response?.error?.message ?? "The extension did not complete the request.");
		error.code = response?.error?.code ?? "UNKNOWN_ERROR";
		throw error;
	}

	return response.result;
}
