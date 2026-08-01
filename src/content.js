// content.js

// Listen for messages from the background script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
	if (request.action === 'autofillTotp') {
		const totpCode = request.code;
		// Logic to find the TOTP input field and fill it
		console.log("Autofilling TOTP code:", totpCode);
		// Example: document.querySelector('input[name="totp"]').value = totpCode;
		sendResponse({ success: true });
	}
});