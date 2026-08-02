import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/lib/constants.js";
import { normalizeSettings } from "../src/lib/settings.js";

test("missing settings use the documented defaults", () => {
	assert.deepEqual(normalizeSettings(), DEFAULT_SETTINGS);
});

test("only actual booleans override behavior settings", () => {
	assert.deepEqual(normalizeSettings({
		automaticAutofill: false,
		showToast: false,
		automaticCopy: true,
		showSuccessPopup: true
	}), {
		automaticAutofill: false,
		showToast: false,
		automaticCopy: true,
		showSuccessPopup: true
	});

	assert.deepEqual(normalizeSettings({
		automaticAutofill: "false",
		automaticCopy: 1
	}), DEFAULT_SETTINGS);
});
