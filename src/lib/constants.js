/**
 * All persistent and session storage keys are centralized so that migrations
 * can be implemented deliberately instead of scattering magic strings across
 * the extension contexts.
 */
export const STORAGE_KEYS = Object.freeze({
	ENCRYPTED_VAULT: "encryptedVault",
	SETTINGS: "settings",
	SESSION_KEY: "sessionVaultKey",
	POPUP_CONTEXT_PREFIX: "popupContext:"
});

/**
 * Automatic copy is intentionally disabled by default because enabling it
 * requires the optional clipboardWrite permission and changes the user's
 * clipboard contents.
 */
export const DEFAULT_SETTINGS = Object.freeze({
	automaticAutofill: true,
	showToast: true,
	automaticCopy: false,
	showSuccessPopup: false
});

export const VAULT_FORMAT_VERSION = 1;
export const VAULT_AAD = "offline-totp-autofill:vault:v1";
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_HASH = "SHA-256";
export const AES_ALGORITHM = "AES-GCM";
export const AES_KEY_LENGTH = 256;
export const SALT_LENGTH_BYTES = 16;
export const IV_LENGTH_BYTES = 12;
export const MINIMUM_MASTER_PASSWORD_LENGTH = 10;
export const TOAST_DURATION_MS = 10000;
export const MINIMUM_LEGACY_TOTP_SECRET_BYTES = 10;

export const MESSAGE_TYPES = Object.freeze({
	GET_STATUS: "getStatus",
	INITIALIZE_VAULT: "initializeVault",
	UNLOCK: "unlock",
	LOCK: "lock",
	GET_SETTINGS: "getSettings",
	UPDATE_SETTINGS: "updateSettings",
	GET_OPTIONS_DATA: "getOptionsData",
	UPSERT_ENTRY: "upsertEntry",
	DELETE_ENTRY: "deleteEntry",
	IMPORT_ENTRIES: "importEntries",
	EXPORT_ENTRIES: "exportEntries",
	CHANGE_MASTER_PASSWORD: "changeMasterPassword",
	GET_POPUP_MODEL: "getPopupModel",
	RUN_TAB_ACTION: "runTabAction",
	APPLY_ENTRY: "applyEntry",
	CLEAR_POPUP_ASSIGNMENT: "clearPopupAssignment"
});
