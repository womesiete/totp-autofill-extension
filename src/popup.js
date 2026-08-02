import { MESSAGE_TYPES } from "./lib/constants.js";

const extensionTitle = chrome.i18n.getMessage("extensionName");

if (extensionTitle) {
	document.title = extensionTitle;
}

const views = [...document.querySelectorAll(".view")];
const loadingView = document.getElementById("loading-view");
const setupView = document.getElementById("setup-view");
const unlockView = document.getElementById("unlock-view");
const manualView = document.getElementById("manual-view");
const successView = document.getElementById("success-view");
const errorView = document.getElementById("error-view");
const setupForm = document.getElementById("setup-form");
const unlockForm = document.getElementById("unlock-form");
const manualSelect = document.getElementById("manual-entry-select");
const manualHostname = document.getElementById("manual-hostname");
const manualEmptyMessage = document.getElementById("manual-empty-message");
const successDomain = document.getElementById("success-domain");
const successLabel = document.getElementById("success-label");
const successCode = document.getElementById("success-code");
const countdownText = document.getElementById("countdown-text");
const outcomeSummary = document.getElementById("outcome-summary");
const errorMessage = document.getElementById("error-message");
const inlineMessage = document.getElementById("inline-message");
const lockButton = document.getElementById("lock-button");
const copyButton = document.getElementById("copy-button");
const codeButton = document.getElementById("code-button");
const autofillButton = document.getElementById("autofill-button");
const refreshButton = document.getElementById("refresh-button");
const retryButton = document.getElementById("retry-button");
const optionsButton = document.getElementById("options-button");

let activeTabId = null;
let currentEntryId = null;
let currentCode = "";
let currentRemainingSeconds = 0;
let countdownTimer = null;

void initializePopup();

setupForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void handleSetup();
});

unlockForm.addEventListener("submit", (event) => {
	event.preventDefault();
	void handleUnlock();
});

/**
 * Selecting a manual fallback immediately invokes the same background code
 * generation and page-application pipeline used by an automatic domain match.
 */
manualSelect.addEventListener("change", () => {
	if (manualSelect.value) {
		void handleManualSelection(manualSelect.value);
	}
});

copyButton.addEventListener("click", () => {
	void copyCurrentCode();
});

codeButton.addEventListener("click", () => {
	void copyCurrentCode();
});

autofillButton.addEventListener("click", () => {
	void applyManualOverride({
		autofill: true,
		toast: true,
		copy: false
	});
});

refreshButton.addEventListener("click", () => {
	void applyManualOverride({
		autofill: false,
		toast: false,
		copy: false
	});
});

retryButton.addEventListener("click", () => {
	void continueAfterAuthentication();
});

lockButton.addEventListener("click", () => {
	void sendMessage({ type: MESSAGE_TYPES.LOCK })
		.then(() => window.close())
		.catch((error) => showInlineMessage(error.message, true));
});

optionsButton.addEventListener("click", () => {
	void chrome.runtime.openOptionsPage();
});

async function initializePopup() {
	try {
		const [tab] = await chrome.tabs.query({
			active: true,
			currentWindow: true
		});

		if (!Number.isInteger(tab?.id)) {
			throw new Error("The active tab is unavailable.");
		}

		activeTabId = tab.id;
		const model = await sendMessage({
			type: MESSAGE_TYPES.GET_POPUP_MODEL,
			tabId: activeTabId
		});
		await renderModel(model);
	} catch (error) {
		renderError(error.message);
	}
}

async function renderModel(model) {
	switch (model.mode) {
		case "setup":
			showView(setupView, false);
			document.getElementById("setup-password").focus();
			break;
		case "locked":
			showView(unlockView, false);
			document.getElementById("unlock-password").focus();
			break;
		case "manual":
			renderManual(model);
			break;
		case "success":
			renderSuccess(model);
			break;
		case "completed":
			window.close();
			break;
		case "ready":
			await continueAfterAuthentication();
			break;
		case "error":
			renderError(model.message);
			break;
		default:
			throw new Error("The popup received an unknown state.");
	}
}

function showView(view, unlocked = true) {
	for (const candidate of views) {
		candidate.hidden = candidate !== view;
	}

	lockButton.hidden = !unlocked;
	hideInlineMessage();
}

async function handleSetup() {
	const passwordInput = document.getElementById("setup-password");
	const confirmInput = document.getElementById("setup-confirm-password");

	if (passwordInput.value !== confirmInput.value) {
		showInlineMessage("The password confirmation does not match.", true);
		return;
	}

	setFormBusy(setupForm, true);

	try {
		await sendMessage({
			type: MESSAGE_TYPES.INITIALIZE_VAULT,
			password: passwordInput.value
		});
		passwordInput.value = "";
		confirmInput.value = "";
		await continueAfterAuthentication();
	} catch (error) {
		showInlineMessage(error.message, true);
	} finally {
		setFormBusy(setupForm, false);
	}
}

async function handleUnlock() {
	const passwordInput = document.getElementById("unlock-password");
	setFormBusy(unlockForm, true);

	try {
		await sendMessage({
			type: MESSAGE_TYPES.UNLOCK,
			password: passwordInput.value
		});
		passwordInput.value = "";
		await continueAfterAuthentication();
	} catch (error) {
		showInlineMessage(error.message, true);
		passwordInput.select();
	} finally {
		setFormBusy(unlockForm, false);
	}
}

async function continueAfterAuthentication() {
	showView(loadingView, true);

	try {
		const result = await sendMessage({
			type: MESSAGE_TYPES.RUN_TAB_ACTION,
			tabId: activeTabId
		});
		await renderModel(result);
	} catch (error) {
		renderError(error.message);
	}
}

function renderManual(model) {
	showView(manualView, true);
	manualHostname.textContent = model.hostname
		? `No encrypted entry matches ${model.hostname}. Select one below to apply it manually.`
		: "This page has no usable web hostname. Select an entry to generate its code manually.";
	manualSelect.replaceChildren(createOption("", "Select a site…"));

	for (const entry of model.entries ?? []) {
		manualSelect.append(createOption(entry.id, `${entry.label} — ${entry.domain}`));
	}

	manualSelect.disabled = !(model.entries?.length > 0);
	manualEmptyMessage.hidden = model.entries?.length > 0;
}

async function handleManualSelection(entryId) {
	manualSelect.disabled = true;

	try {
		const result = await sendMessage({
			type: MESSAGE_TYPES.APPLY_ENTRY,
			tabId: activeTabId,
			entryId
		});

		if (result.settings?.showSuccessPopup) {
			renderSuccess(result);
		} else {
			window.close();
		}
	} catch (error) {
		showInlineMessage(error.message, true);
		manualSelect.disabled = false;
	}
}

function renderSuccess(model) {
	showView(successView, true);
	currentEntryId = model.entry.id;
	currentCode = model.code;
	currentRemainingSeconds = model.remainingSeconds ?? model.entry.period;
	successDomain.textContent = model.entry.domain;
	successLabel.textContent = model.entry.label;
	successCode.textContent = formatCode(model.code);
	renderOutcome(model.outcome, model.actions);
	startCountdown();
}

function renderOutcome(outcome = {}, actions = {}) {
	outcomeSummary.replaceChildren();

	if (actions.autofill) {
		appendOutcome("Autofill", outcome.autofill?.filled ? "Input filled" : outcome.autofill?.reason ?? "No input found");
	}

	if (actions.toast) {
		appendOutcome("Toast", outcome.toast?.shown ? "Shown for 10 seconds" : "Not shown");
	}

	if (actions.copy) {
		appendOutcome("Clipboard", outcome.copy?.copied ? "Code copied" : "Copy was blocked");
	}

	if (!actions.autofill && !actions.toast && !actions.copy) {
		appendOutcome("Generation", "Code generated locally");
	}
}

function appendOutcome(label, value) {
	const item = document.createElement("div");
	item.className = "outcome-item";
	const labelElement = document.createElement("span");
	labelElement.textContent = label;
	const valueElement = document.createElement("strong");
	valueElement.textContent = value;
	item.append(labelElement, valueElement);
	outcomeSummary.append(item);
}

function startCountdown() {
	if (countdownTimer) {
		clearInterval(countdownTimer);
	}

	updateCountdownText();
	countdownTimer = setInterval(() => {
		currentRemainingSeconds = Math.max(0, currentRemainingSeconds - 1);
		updateCountdownText();
	}, 1000);
}

function updateCountdownText() {
	countdownText.textContent = currentRemainingSeconds > 0
		? `Current time window ends in ${currentRemainingSeconds} second${currentRemainingSeconds === 1 ? "" : "s"}.`
		: "This code may have expired. Generate the current code again.";
}

async function copyCurrentCode() {
	if (!currentCode) {
		return;
	}

	try {
		await copyText(currentCode);
		showInlineMessage("Code copied to the clipboard.");
	} catch (error) {
		showInlineMessage("Chrome blocked clipboard access. Select the code and copy it manually.", true);
	}
}

async function applyManualOverride(overrideActions) {
	if (!currentEntryId) {
		return;
	}

	setSuccessButtonsBusy(true);

	try {
		const result = await sendMessage({
			type: MESSAGE_TYPES.APPLY_ENTRY,
			tabId: activeTabId,
			entryId: currentEntryId,
			overrideActions
		});
		renderSuccess(result);
	} catch (error) {
		showInlineMessage(error.message, true);
	} finally {
		setSuccessButtonsBusy(false);
	}
}

function renderError(message) {
	showView(errorView, false);
	errorMessage.textContent = message;
}

function createOption(value, label) {
	const option = document.createElement("option");
	option.value = value;
	option.textContent = label;
	return option;
}

function formatCode(code) {
	if (code.length === 6) {
		return `${code.slice(0, 3)} ${code.slice(3)}`;
	}

	if (code.length === 8) {
		return `${code.slice(0, 4)} ${code.slice(4)}`;
	}

	return code;
}

function setFormBusy(form, busy) {
	for (const element of form.elements) {
		element.disabled = busy;
	}
}

function setSuccessButtonsBusy(busy) {
	copyButton.disabled = busy;
	codeButton.disabled = busy;
	autofillButton.disabled = busy;
	refreshButton.disabled = busy;
}

function showInlineMessage(message, isError = false) {
	inlineMessage.textContent = message;
	inlineMessage.classList.toggle("error", isError);
	inlineMessage.hidden = false;
}

function hideInlineMessage() {
	inlineMessage.hidden = true;
	inlineMessage.textContent = "";
	inlineMessage.classList.remove("error");
}

/**
 * Clipboard writes rely exclusively on the modern Clipboard API. When Chrome
 * denies access, the caller displays the existing manual-copy guidance.
 */
async function copyText(value) {
	await navigator.clipboard.writeText(value);
}

async function sendMessage(message) {
	const response = await chrome.runtime.sendMessage(message);

	if (!response?.ok) {
		const error = new Error(response?.error?.message ?? "The extension did not return a valid response.");
		error.code = response?.error?.code;
		throw error;
	}

	return response.result;
}
