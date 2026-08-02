import { DEFAULT_SETTINGS } from "./constants.js";

/**
 * Settings are intentionally unencrypted and contain no secrets. Boolean
 * coercion prevents malformed imports or manual storage edits from enabling a
 * behavior with an unexpected truthy value.
 */
export function normalizeSettings(value = {}) {
	return {
		automaticAutofill: typeof value.automaticAutofill === "boolean"
			? value.automaticAutofill
			: DEFAULT_SETTINGS.automaticAutofill,
		showToast: typeof value.showToast === "boolean"
			? value.showToast
			: DEFAULT_SETTINGS.showToast,
		automaticCopy: typeof value.automaticCopy === "boolean"
			? value.automaticCopy
			: DEFAULT_SETTINGS.automaticCopy,
		showSuccessPopup: typeof value.showSuccessPopup === "boolean"
			? value.showSuccessPopup
			: DEFAULT_SETTINGS.showSuccessPopup
	};
}
